import { SerialRuns } from './atomic-json-file.js'
import { EnvStatus, EnvType, type EnvironmentRecord, type IContainerProbe } from './environment-record.js'
import { FileRecordMap, RecordDocuments, type IRecordMap } from './record-map.js'

/** An environment as stored: records from before environment types read as Development. */
export type PersistedEnvironmentRecord = Omit<EnvironmentRecord, 'type'> & { type?: EnvType }

export class EnvironmentRegistry
{
    public static readonly RootKey = 'environments'
    private static readonly NoContainerName = ''

    private readonly records = new Map<string, EnvironmentRecord>()
    private readonly writes = new SerialRuns()
    /** Keys changed since the last write that included them (a failed write leaves them for the next one). */
    private readonly pending = new Set<string>()
    private readonly map: IRecordMap<PersistedEnvironmentRecord>

    /** `location`: the `{ environments: { <name>: record } }` file, or a record map (the console's Postgres table). */
    public constructor(location: string | IRecordMap<PersistedEnvironmentRecord>, private readonly probe: IContainerProbe)
    {
        this.map = typeof location === 'string' ? new FileRecordMap<PersistedEnvironmentRecord>(location, { RootKey: EnvironmentRegistry.RootKey }) : location
    }

    public async Load(): Promise<void>
    {
        this.records.clear()
        for (const [name, record] of await this.map.Load())
        {
            this.records.set(name, { ...record, type: record.type ?? EnvType.Development })
        }
    }

    public List(): readonly EnvironmentRecord[]
    {
        return [...this.records.values()]
    }

    public Get(name: string): EnvironmentRecord | undefined
    {
        return this.records.get(name)
    }

    /**
     * True when the tenant owns a platform-managed environment that the desktop would list: any status but Failed. A delete
     * removes the record outright, so there is no "being deleted" status to exclude.
     */
    public HasEnvironmentsOf(tenantId: string): boolean
    {
        for (const record of this.records.values())
        {
            if (record.tenantId === tenantId && record.status !== EnvStatus.Failed)
            {
                return true
            }
        }
        return false
    }

    public async Put(record: EnvironmentRecord): Promise<void>
    {
        RecordDocuments.AssertStorable(record)
        this.records.set(record.name, { ...record })
        await this.persist(new Set([record.name]))
    }

    public async Remove(name: string): Promise<void>
    {
        this.records.delete(name)
        await this.persist(new Set([name]))
    }

    /** Docker-probes unbound records only; a hive-bound (in-cluster) record's status is owned by the hive agent, so it is left untouched. */
    public async Reconcile(): Promise<void>
    {
        for (const record of this.records.values())
        {
            if (record.status === EnvStatus.Failed || record.hiveId !== undefined)
            {
                continue
            }
            const running = await this.probe.Running(record.containerName ?? EnvironmentRegistry.NoContainerName)
            this.records.set(record.name, { ...record, status: running ? EnvStatus.Running : EnvStatus.Stopped })
        }
        await this.persist(new Set(this.records.keys()))
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

    /** One write of the changed names (the file form rewrites the whole map); overridable so a test can hold a write. */
    protected Commit(changed: ReadonlySet<string>): Promise<void>
    {
        return this.map.Save(new Map(this.records), changed)
    }
}
