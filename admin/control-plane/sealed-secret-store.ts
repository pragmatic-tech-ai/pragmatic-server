import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EncryptedSecretStore } from '@pragmatic-tech-ai/todl-identity-local'

export class SealedSecretUnreadableError extends Error
{
    private static readonly Text = 'A sealed secret could not be read.'
    private static readonly ErrorName = 'SealedSecretUnreadableError'

    public constructor()
    {
        super(SealedSecretUnreadableError.Text)
        this.name = SealedSecretUnreadableError.ErrorName
    }
}

export class SealedSecretFileError extends Error
{
    private static readonly Text = 'The sealed secret file is invalid.'
    private static readonly ErrorName = 'SealedSecretFileError'

    public constructor()
    {
        super(SealedSecretFileError.Text)
        this.name = SealedSecretFileError.ErrorName
    }
}

/**
 * Byte secrets sealed with the master key (AES-256-GCM via EncryptedSecretStore) and persisted
 * as { "sealed": { "<ref>": "<blob>" } }. Put/Delete are serialized through a promise chain so
 * concurrent writers never interleave or share a temp file. Values never appear in errors or JSON.
 */
export class SealedSecretStore
{
    public static readonly FileName = 'sealed-secrets.json'
    private static readonly RootKey = 'sealed'
    private static readonly TempSuffix = '.tmp'
    private static readonly Encoding = 'utf8'
    private static readonly ValueEncoding = 'base64'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly FileMode = 0o600
    private static readonly JsonIndent = 2
    private static readonly Separator = '\u0000'
    private static readonly BadRefText = 'A sealed secret reference is invalid.'
    private static readonly Redacted = '[SealedSecretStore: values redacted]'

    private chain: Promise<void> = Promise.resolve()

    private constructor(
        private readonly filePath: string,
        private readonly masterKey: Buffer,
        private entries: Map<string, string>)
    {
    }

    public static async Open(filePath: string, masterKey: Buffer): Promise<SealedSecretStore>
    {
        let text: string | undefined
        try
        {
            text = await readFile(filePath, SealedSecretStore.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code !== SealedSecretStore.NotFoundCode)
            {
                throw err
            }
        }
        const entries = text === undefined ? new Map<string, string>() : SealedSecretStore.ParseEntries(text)
        return new SealedSecretStore(filePath, Buffer.from(masterKey), entries)
    }

    private static ParseEntries(text: string): Map<string, string>
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            throw new SealedSecretFileError()
        }
        const root = SealedSecretStore.AsRecord(parsed)
        const sealed = root === undefined ? undefined : SealedSecretStore.AsRecord(root[SealedSecretStore.RootKey])
        if (sealed === undefined)
        {
            throw new SealedSecretFileError()
        }
        const entries = new Map<string, string>()
        for (const [ref, blob] of Object.entries(sealed))
        {
            if (typeof blob !== 'string')
            {
                throw new SealedSecretFileError()
            }
            entries.set(ref, blob)
        }
        return entries
    }

    private static CheckRef(ref: string): void
    {
        if (ref.includes(SealedSecretStore.Separator))
        {
            throw new Error(SealedSecretStore.BadRefText)
        }
    }

    private static AsRecord(value: unknown): Record<string, unknown> | undefined
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    }

    /** Undefined when absent; throws SealedSecretUnreadableError when present but tampered, wrong-key or bound to another ref. */
    public Get(ref: string): Promise<Buffer | undefined>
    {
        SealedSecretStore.CheckRef(ref)
        return this.Enqueue(async () =>
        {
            if (!this.entries.has(ref))
            {
                return undefined
            }
            const text = await new EncryptedSecretStore(this.masterKey, this.entries).Get(ref)
            const prefix = `${ref}${SealedSecretStore.Separator}`
            if (text === null || !text.startsWith(prefix))
            {
                throw new SealedSecretUnreadableError()
            }
            return Buffer.from(text.slice(prefix.length), SealedSecretStore.ValueEncoding)
        })
    }

    public Put(ref: string, value: Buffer): Promise<void>
    {
        SealedSecretStore.CheckRef(ref)
        return this.Enqueue(async () =>
        {
            const next = new Map(this.entries)
            const plain = `${ref}${SealedSecretStore.Separator}${value.toString(SealedSecretStore.ValueEncoding)}`
            await new EncryptedSecretStore(this.masterKey, next).Put(ref, plain)
            await this.Persist(next)
            this.entries = next
        })
    }

    public Delete(ref: string): Promise<void>
    {
        SealedSecretStore.CheckRef(ref)
        return this.Enqueue(async () =>
        {
            const next = new Map(this.entries)
            next.delete(ref)
            await this.Persist(next)
            this.entries = next
        })
    }

    public toJSON(): string
    {
        return SealedSecretStore.Redacted
    }

    public toString(): string
    {
        return SealedSecretStore.Redacted
    }

    private Enqueue<T>(work: () => Promise<T>): Promise<T>
    {
        const run = this.chain.then(work)
        this.chain = run.then(() => undefined, () => undefined)
        return run
    }

    private async Persist(entries: Map<string, string>): Promise<void>
    {
        const body = JSON.stringify({ [SealedSecretStore.RootKey]: Object.fromEntries(entries) }, null, SealedSecretStore.JsonIndent)
        await mkdir(dirname(this.filePath), { recursive: true })
        const temp = `${this.filePath}.${randomUUID()}${SealedSecretStore.TempSuffix}`
        try
        {
            const handle = await open(temp, 'w', SealedSecretStore.FileMode)
            try
            {
                await handle.writeFile(body, SealedSecretStore.Encoding)
                await handle.sync()
            }
            finally
            {
                await handle.close()
            }
            await rename(temp, this.filePath)
        }
        catch (err)
        {
            await unlink(temp).catch(() => undefined)
            throw err
        }
    }
}
