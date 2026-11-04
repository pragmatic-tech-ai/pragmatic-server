import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EncryptedSecretStore } from '@pragmatic-tech-ai/todl-identity-local'

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
    private static readonly Redacted = '[SealedSecretStore: values redacted]'

    private chain: Promise<void> = Promise.resolve()

    private constructor(
        private readonly filePath: string,
        private readonly entries: Map<string, string>,
        private readonly sealer: EncryptedSecretStore)
    {
    }

    public static async Open(filePath: string, masterKey: Buffer): Promise<SealedSecretStore>
    {
        const entries = new Map<string, string>()
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
        if (text !== undefined)
        {
            const parsed = JSON.parse(text) as Record<string, Record<string, string> | undefined>
            for (const [ref, blob] of Object.entries(parsed[SealedSecretStore.RootKey] ?? {}))
            {
                entries.set(ref, blob)
            }
        }
        return new SealedSecretStore(filePath, entries, new EncryptedSecretStore(masterKey, entries))
    }

    public async Get(ref: string): Promise<Buffer | undefined>
    {
        const text = await this.sealer.Get(ref)
        return text === null ? undefined : Buffer.from(text, SealedSecretStore.ValueEncoding)
    }

    public Put(ref: string, value: Buffer): Promise<void>
    {
        return this.Enqueue(async () =>
        {
            await this.sealer.Put(ref, value.toString(SealedSecretStore.ValueEncoding))
            await this.Persist()
        })
    }

    public Delete(ref: string): Promise<void>
    {
        return this.Enqueue(async () =>
        {
            await this.sealer.Delete(ref)
            await this.Persist()
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

    private Enqueue(work: () => Promise<void>): Promise<void>
    {
        const run = this.chain.then(work)
        this.chain = run.catch(() => undefined)
        return run
    }

    private async Persist(): Promise<void>
    {
        const body = JSON.stringify({ [SealedSecretStore.RootKey]: Object.fromEntries(this.entries) }, null, SealedSecretStore.JsonIndent)
        await mkdir(dirname(this.filePath), { recursive: true })
        const temp = `${this.filePath}.${randomUUID()}${SealedSecretStore.TempSuffix}`
        try
        {
            await writeFile(temp, body, { encoding: SealedSecretStore.Encoding, mode: SealedSecretStore.FileMode })
            await rename(temp, this.filePath)
        }
        catch (err)
        {
            await unlink(temp).catch(() => undefined)
            throw err
        }
    }
}
