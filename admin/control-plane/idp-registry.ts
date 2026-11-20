import { SerialRuns } from './atomic-json-file.js'
import type { IdpRecord } from './idp-record.js'
import { FileRecordMap, type IRecordMap } from './record-map.js'

export class IdpRegistry
{
    public static readonly RootKey = 'idps'

    private readonly records = new Map<string, IdpRecord>()
    private readonly writes = new SerialRuns()
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
        this.records.set(record.tenantId, { ...record })
        await this.persist(new Set([record.tenantId]))
    }

    public async Delete(tenantId: string): Promise<void>
    {
        this.records.delete(tenantId)
        await this.persist(new Set([tenantId]))
    }

    /** Writes run one at a time; each saves the current records of the tenants it changed, so a later write carries every earlier change. */
    private persist(changed: ReadonlySet<string>): Promise<void>
    {
        return this.writes.Run(() => this.Commit(changed))
    }

    /** One write of the changed tenants (the file form rewrites the whole map); overridable so a test can hold a write. */
    protected Commit(changed: ReadonlySet<string>): Promise<void>
    {
        return this.map.Save(new Map(this.records), changed)
    }
}
