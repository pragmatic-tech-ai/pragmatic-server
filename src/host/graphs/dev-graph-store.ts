import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'

export type PackageRef = { id: string; version: string }

/** Slices are keyed by stable solution id; each holds that solution's contributed package refs. */
export type DevGraphRecord = { name: string; description: string; slices: Record<string, PackageRef[]>; createdAt: string }

type GraphsDocument = { graphs: Record<string, DevGraphRecord> }

/** Returns defensive copies so callers cannot mutate persisted state. Persistent store of a dev environment's graph records: one JSON document in the tenant graphs volume, over IStorage. */
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
            this.records.set(name, DevGraphStore.Copy(record))
        }
    }

    public List(): readonly DevGraphRecord[]
    {
        return [...this.records.values()].map(r => DevGraphStore.Copy(r))
    }

    public Get(name: string): DevGraphRecord | undefined
    {
        const record = this.records.get(name)
        return record === undefined ? undefined : DevGraphStore.Copy(record)
    }

    public async Put(record: DevGraphRecord): Promise<void>
    {
        this.records.set(record.name, DevGraphStore.Copy(record))
        await this.Persist()
    }

    public async Remove(name: string): Promise<void>
    {
        this.records.delete(name)
        await this.Persist()
    }

    private static Copy(record: DevGraphRecord): DevGraphRecord
    {
        const slices: Record<string, PackageRef[]> = {}
        for (const [solutionId, refs] of Object.entries(record.slices ?? {}))
        {
            slices[solutionId] = refs.map(p => ({ id: p.id, version: p.version }))
        }
        return { name: record.name, description: record.description, slices, createdAt: record.createdAt }
    }

    private async Persist(): Promise<void>
    {
        const document: GraphsDocument = { [DevGraphStore.RootKey]: Object.fromEntries(this.records) }
        await this.storage.WriteText(DevGraphStore.FileName, JSON.stringify(document, null, 2))
    }
}
