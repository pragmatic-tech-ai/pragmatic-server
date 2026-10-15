import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IDocumentSession } from '@pragmatic-tech-ai/todl-connectors-host'

/** Dev/debug document store: one JSON file per instance at `<collection>/<key>.json` over IStorage. */
export class StorageDocumentSession implements IDocumentSession
{
    private static readonly Extension = '.json'
    private static readonly Separator = '/'
    private static readonly Utf8 = 'utf8'
    private static readonly Hex = 'hex'

    public constructor(private readonly storage: IStorage)
    {
    }

    public async Find(collection: string, _filter: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>
    {
        const dir = StorageDocumentSession.Encode(collection)
        if (!(await this.storage.Exists(dir)))
        {
            return []
        }
        const entries = await this.storage.List(dir)
        const docs: Record<string, unknown>[] = []
        for (const entry of entries)
        {
            if (entry.IsDirectory || !entry.Name.endsWith(StorageDocumentSession.Extension))
            {
                continue
            }
            const text = await this.storage.ReadText(`${dir}${StorageDocumentSession.Separator}${entry.Name}`)
            docs.push(JSON.parse(text) as Record<string, unknown>)
        }
        return docs
    }

    public async Upsert(collection: string, idField: string, key: unknown, doc: Record<string, unknown>): Promise<void>
    {
        await this.storage.CreateDirectory(StorageDocumentSession.Encode(collection))
        await this.storage.WriteText(this.PathFor(collection, key), JSON.stringify({ ...doc, [idField]: key }))
    }

    public async Delete(collection: string, _idField: string, key: unknown): Promise<boolean>
    {
        const path = this.PathFor(collection, key)
        if (!(await this.storage.Exists(path)))
        {
            return false
        }
        await this.storage.Delete(path)
        return true
    }

    private PathFor(collection: string, key: unknown): string
    {
        return `${StorageDocumentSession.Encode(collection)}${StorageDocumentSession.Separator}${StorageDocumentSession.Encode(String(key))}${StorageDocumentSession.Extension}`
    }

    /** One-way lowercase hex of the UTF-8 bytes: filesystem-safe, case-stable, injective. */
    private static Encode(segment: string): string
    {
        return Buffer.from(segment, StorageDocumentSession.Utf8).toString(StorageDocumentSession.Hex)
    }
}
