import { EncryptedSecretStore } from '@pragmatic-tech-ai/pragmatic-identity-source-local'
import { FileRecordMap, RecordMapFormatError, SerialRuns, type IRecordMap, type ISealedSecrets } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

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
 * as { "sealed": { "<ref>": "<blob>" } } (or as one row per ref in a record map: the platform admin console's Postgres
 * table, where the blobs stay sealed exactly as in the file). Get/Put/Delete run one at a time through a SerialRuns, so
 * concurrent callers never interleave or share a temp file. Values never appear in errors or JSON. Writes are fsynced; a
 * parent-directory sync that fails after the rename landed does not fail the Put/Delete (the new content is in place, so
 * memory follows the disk) and is logged as a fixed sentence plus the error's name.
 */
export class SealedSecretStore implements ISealedSecrets
{
    public static readonly FileName = 'sealed-secrets.json'
    public static readonly RootKey = 'sealed'
    private static readonly ValueEncoding = 'base64'
    private static readonly FileMode = 0o600
    private static readonly Separator = '\u0000'
    private static readonly BadRefText = 'A sealed secret reference is invalid.'
    private static readonly Redacted = '[SealedSecretStore: values redacted]'
    private static readonly DirectorySyncFailedLog = '[sealed-secrets] the sealed file is saved, but its directory could not be synced:'
    private static readonly UnknownErrorName = 'unknown error'

    private readonly runs = new SerialRuns()

    private constructor(
        private readonly map: IRecordMap<string>,
        private readonly masterKey: Buffer,
        private entries: Map<string, string>)
    {
    }

    /** `location`: the sealed file (a missing one is empty), or a record map of sealed blobs by ref. */
    public static async Open(location: string | IRecordMap<string>, masterKey: Buffer): Promise<SealedSecretStore>
    {
        const map = typeof location === 'string' ? SealedSecretStore.FileMap(location) : location
        let stored: ReadonlyMap<string, unknown>
        try
        {
            stored = await map.Load()
        }
        catch (err)
        {
            throw err instanceof RecordMapFormatError ? new SealedSecretFileError() : err
        }
        const entries = new Map<string, string>()
        for (const [ref, blob] of stored)
        {
            if (typeof blob !== 'string')
            {
                throw new SealedSecretFileError()
            }
            entries.set(ref, blob)
        }
        return new SealedSecretStore(map, Buffer.from(masterKey), entries)
    }

    /** The file form: `{ sealed: { <ref>: blob } }`, written 0600 and fsynced (a failed directory sync is only logged). */
    public static FileMap(filePath: string): FileRecordMap<string>
    {
        return new FileRecordMap<string>(filePath, {
            RootKey: SealedSecretStore.RootKey,
            RequireRoot: true,
            Write: { mode: SealedSecretStore.FileMode, fsync: true, onDirectorySyncFailure: err => SealedSecretStore.ReportDirectorySyncFailure(err) },
        })
    }

    private static CheckRef(ref: string): void
    {
        if (ref.includes(SealedSecretStore.Separator))
        {
            throw new Error(SealedSecretStore.BadRefText)
        }
    }

    /** Undefined when absent; throws SealedSecretUnreadableError when present but tampered, wrong-key or bound to another ref. */
    public Get(ref: string): Promise<Buffer | undefined>
    {
        SealedSecretStore.CheckRef(ref)
        return this.runs.Run(async () =>
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
        return this.runs.Run(async () =>
        {
            const next = new Map(this.entries)
            const plain = `${ref}${SealedSecretStore.Separator}${value.toString(SealedSecretStore.ValueEncoding)}`
            await new EncryptedSecretStore(this.masterKey, next).Put(ref, plain)
            await this.map.Save(next, new Set([ref]))
            this.entries = next
        })
    }

    public Delete(ref: string): Promise<void>
    {
        SealedSecretStore.CheckRef(ref)
        return this.runs.Run(async () =>
        {
            const next = new Map(this.entries)
            next.delete(ref)
            await this.map.Save(next, new Set([ref]))
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

    /** The sealed file is already in place (the rename landed), so the write still succeeds; only the sentence and the error's name are logged. */
    private static ReportDirectorySyncFailure(err: unknown): void
    {
        console.error(SealedSecretStore.DirectorySyncFailedLog, err instanceof Error ? err.name : SealedSecretStore.UnknownErrorName)
    }
}
