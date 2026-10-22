import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ISignatureStore
{
    Get(digest: string): Promise<string | undefined>
    Put(digest: string, signature: string): Promise<void>
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

/** Persists a `{ digest: signature }` JSON map; the local analog of cosign's OCI signature artifacts. */
export class FileSignatureStore implements ISignatureStore
{
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2

    public constructor(private readonly filePath: string)
    {
    }

    public async Get(digest: string): Promise<string | undefined>
    {
        const map = await this.load()
        return Object.hasOwn(map, digest) ? map[digest] : undefined
    }

    public async Put(digest: string, signature: string): Promise<void>
    {
        const map = await this.load()
        map[digest] = signature
        await this.persist(map)
    }

    private async load(): Promise<Record<string, string>>
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
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        {
            throw new SignatureStoreCorruptError(this.filePath)
        }
        return parsed as Record<string, string>
    }

    private async persist(map: Record<string, string>): Promise<void>
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
