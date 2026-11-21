import { SerialRuns, type IdpRecord, FileRecordMap, RecordDocuments, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

export class IdpRegistry
{
    public static readonly RootKey = 'idps'

    private readonly records = new Map<string, IdpRecord>()
    private readonly writes = new SerialRuns()
    /** Keys changed since the last write that included them (a failed write leaves them for the next one). */
    private readonly pending = new Set<string>()
    private readonly map: IRecordMap<IdpRecord>

    /** `location`: the `{ idps: { <tenantId>: record } }` file, or a record map (the console's Postgres table). */
    public constructor(location: string | IRecordMap<IdpRecord>)
    {
        this.map = typeof location === 'string' ? new FileRecordMap<IdpRecord>(location, { RootKey: IdpRegistry.RootKey }) : location
    }

    public async Load(): Promise<void>
    {
        this.records.clear()
        for (const [tenantId, record] of await this.map.Load())
        {
            this.records.set(tenantId, { ...record })
        }
    }

    public List(): readonly IdpRecord[]
    {
        return [...this.records.values()]
    }

    public Get(tenantId: string): IdpRecord | undefined
    {
        return this.records.get(tenantId)
    }

    public async Put(record: IdpRecord): Promise<void>
    {
        RecordDocuments.AssertStorable(record)
        this.records.set(record.tenantId, { ...record })
        await this.persist(new Set([record.tenantId]))
    }

    public async Delete(tenantId: string): Promise<void>
    {
        this.records.delete(tenantId)
        await this.persist(new Set([tenantId]))
    }

    /** Writes run one at a time; each saves the current records of every key changed since the last successful write (a
     *  failed write's keys ride with the next), so a later write carries every earlier change. */
    private persist(changed: ReadonlySet<string>): Promise<void>
    {
        for (const key of changed)
        {
            this.pending.add(key)
        }
        return this.writes.Run(async () =>
        {
            const batch = new Set(this.pending)
            this.pending.clear()
            try
            {
                await this.Commit(batch)
            }
            catch (err)
            {
                for (const key of batch)
                {
                    this.pending.add(key)
                }
                throw err
            }
        })
    }

    /** One write of the changed tenants (the file form rewrites the whole map); overridable so a test can hold a write. */
    protected Commit(changed: ReadonlySet<string>): Promise<void>
    {
        return this.map.Save(new Map(this.records), changed)
    }
}
