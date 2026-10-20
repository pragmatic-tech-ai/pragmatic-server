import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'

export type DevGraphRecord = { name: string; description: string; packages: { id: string; version: string }[]; createdAt: string }

type GraphsDocument = { graphs: Record<string, DevGraphRecord> }

/** Persistent store of a dev environment's graph records: one JSON document in the tenant graphs volume, over IStorage. */
export class DevGraphStore
{
    private static readonly FileName = 'graphs.json'
    private static readonly RootKey = 'graphs'

    private readonly records = new Map<string, DevGraphRecord>()

    public constructor(private readonly storage: IStorage)
    {
    }

    public async Load(): Promise<void>
    {
        this.records.clear()
        if (!(await this.storage.Exists(DevGraphStore.FileName)))
        {
            return
        }
        const document = JSON.parse(await this.storage.ReadText(DevGraphStore.FileName)) as Partial<GraphsDocument>
        const graphs = document[DevGraphStore.RootKey] ?? {}
        for (const [name, record] of Object.entries(graphs))
        {
            this.records.set(name, { ...record })
        }
    }

    public List(): readonly DevGraphRecord[]
    {
        return [...this.records.values()]
    }

    public Get(name: string): DevGraphRecord | undefined
    {
        return this.records.get(name)
    }

    public async Put(record: DevGraphRecord): Promise<void>
    {
        this.records.set(record.name, { ...record })
        await this.Persist()
    }

    public async Remove(name: string): Promise<void>
    {
        this.records.delete(name)
        await this.Persist()
    }

    private async Persist(): Promise<void>
    {
        const document: GraphsDocument = { [DevGraphStore.RootKey]: Object.fromEntries(this.records) }
        await this.storage.WriteText(DevGraphStore.FileName, JSON.stringify(document, null, 2))
    }
}
