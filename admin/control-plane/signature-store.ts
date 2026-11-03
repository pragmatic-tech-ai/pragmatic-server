import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Signatures per image digest, one per signing key ref: two keys signing the same digest never displace each other. */
export interface ISignatureStore
{
    Get(digest: string, keyRef: string): Promise<string | undefined>
    /** Whether `keyRef` itself filed a signature for `digest` (a pre-keyed entry never counts): what "signed with this key" reports. */
    HasKeyed(digest: string, keyRef: string): Promise<boolean>
    Put(digest: string, keyRef: string, signature: string): Promise<void>
}

/** Names the corrupt file path only; never carries file contents. */
export class SignatureStoreCorruptError extends Error
{
    private static readonly ErrorName = 'SignatureStoreCorruptError'
    private static readonly MessagePrefix = 'signature store corrupt: '

    public constructor(filePath: string)
    {
        super(`${SignatureStoreCorruptError.MessagePrefix}${filePath}`)
        this.name = SignatureStoreCorruptError.ErrorName
    }
}

/** One digest's signatures by key ref; a file written before signatures were keyed holds a bare string instead. */
type SignatureEntry = string | Record<string, string>

/**
 * Persists a `{ digest: { keyRef: signature } }` JSON map; the local analog of cosign's OCI signature artifacts. An
 * entry from before signatures were keyed (a bare signature string) is still answered for any key ref: the verifier
 * checks it cryptographically against the asked key, so it can only ever verify under the key that made it.
 */
export class FileSignatureStore implements ISignatureStore
{
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2
    // Holds a pre-keyed entry's signature once that digest gets a keyed one; never a valid key ref (refs are non-empty).
    private static readonly LegacyKeyRef = ''
    private static readonly CaseInsensitivePlatform = 'win32'

    // Puts to one file run one at a time across every instance in this process: each is a read-modify-write of the
    // whole file, so two at once would drop a signature.
    private static readonly writes = new Map<string, Promise<void>>()

    public constructor(private readonly filePath: string)
    {
    }

    public async Get(digest: string, keyRef: string): Promise<string | undefined>
    {
        const map = await this.load()
        if (!Object.hasOwn(map, digest))
        {
            return undefined
        }
        const entry = map[digest] as SignatureEntry
        if (typeof entry === 'string')
        {
            return entry
        }
        if (Object.hasOwn(entry, keyRef))
        {
            return entry[keyRef]
        }
        return Object.hasOwn(entry, FileSignatureStore.LegacyKeyRef) ? entry[FileSignatureStore.LegacyKeyRef] : undefined
    }

    public async HasKeyed(digest: string, keyRef: string): Promise<boolean>
    {
        const map = await this.load()
        const entry = Object.hasOwn(map, digest) ? map[digest] as SignatureEntry : undefined
        return entry !== undefined && typeof entry !== 'string' && keyRef !== FileSignatureStore.LegacyKeyRef && Object.hasOwn(entry, keyRef)
    }

    public Put(digest: string, keyRef: string, signature: string): Promise<void>
    {
        const C = FileSignatureStore
        const key = C.QueueKeyOf(this.filePath)
        const run = (C.writes.get(key) ?? Promise.resolve()).then(async () =>
        {
            const map = await this.load()
            const existing = Object.hasOwn(map, digest) ? map[digest] as SignatureEntry : undefined
            const entry: Record<string, string> = typeof existing === 'string' ? { [C.LegacyKeyRef]: existing } : { ...existing }
            entry[keyRef] = signature
            map[digest] = entry
            await this.persist(map)
        })
        // A failed write must not wedge later ones; the caller still sees this write's error.
        const settled = run.catch(() => undefined)
        C.writes.set(key, settled)
        // Forget the queue once it drains, so the map holds only files with a write in flight.
        void settled.then(() =>
        {
            if (C.writes.get(key) === settled)
            {
                C.writes.delete(key)
            }
        })
        return run
    }

    // One queue per file: paths are case-insensitive on Windows, so two spellings of one file share a queue.
    private static QueueKeyOf(filePath: string): string
    {
        const full = resolve(filePath)
        return process.platform === FileSignatureStore.CaseInsensitivePlatform ? full.toLowerCase() : full
    }

    // An entry is a signature string (pre-keyed file) or a map of key ref to signature string; anything else is corrupt.
    private static IsEntry(value: unknown): boolean
    {
        if (typeof value === 'string')
        {
            return true
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
        {
            return false
        }
        return Object.values(value).every(v => typeof v === 'string')
    }

    private async load(): Promise<Record<string, SignatureEntry>>
    {
        let text: string
        try
        {
            text = await readFile(this.filePath, FileSignatureStore.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === FileSignatureStore.NotFoundCode)
            {
                return {}
            }
            throw err
        }
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            throw new SignatureStoreCorruptError(this.filePath)
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every(v => FileSignatureStore.IsEntry(v)))
        {
            throw new SignatureStoreCorruptError(this.filePath)
        }
        return parsed as Record<string, SignatureEntry>
    }

    private async persist(map: Record<string, SignatureEntry>): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const temp = `${this.filePath}.${randomUUID()}${FileSignatureStore.TempSuffix}`
        await writeFile(temp, JSON.stringify(map, null, FileSignatureStore.JsonIndent), FileSignatureStore.Encoding)
        try
        {
            await rename(temp, this.filePath)
        }
        catch (err)
        {
            await unlink(temp).catch(() => undefined)
            throw err
        }
    }
}
