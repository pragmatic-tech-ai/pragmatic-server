import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ISignatureStore
{
    Get(digest: string): Promise<string | undefined>
    Put(digest: string, signature: string): Promise<void>
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
        try
        {
            const text = await readFile(this.filePath, FileSignatureStore.Encoding)
            return JSON.parse(text) as Record<string, string>
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === FileSignatureStore.NotFoundCode)
            {
                return {}
            }
            throw err
        }
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
