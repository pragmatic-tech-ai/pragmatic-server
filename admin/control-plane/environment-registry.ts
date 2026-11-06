import { readFile } from 'node:fs/promises'
import { AtomicJsonFile, SerialRuns } from './atomic-json-file.js'
import { EnvStatus, EnvType, type EnvironmentRecord, type IContainerProbe } from './environment-record.js'

type PersistedEnvironmentRecord = Omit<EnvironmentRecord, 'type'> & { type?: EnvType }

export class EnvironmentRegistry
{
    private static readonly Encoding = 'utf8'
    private static readonly RootKey = 'environments'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2
    private static readonly NoContainerName = ''

    private readonly records = new Map<string, EnvironmentRecord>()
    private readonly writes = new SerialRuns()

    public constructor(private readonly filePath: string, private readonly probe: IContainerProbe)
    {
    }

    public async Load(): Promise<void>
    {
        this.records.clear()
        let text: string
        try
        {
            text = await readFile(this.filePath, EnvironmentRegistry.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === EnvironmentRegistry.NotFoundCode)
            {
                return
            }
            throw err
        }
        const parsed = JSON.parse(text) as Record<string, Record<string, PersistedEnvironmentRecord> | undefined>
        const envs = parsed[EnvironmentRegistry.RootKey] ?? {}
        for (const [name, record] of Object.entries(envs))
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

    public async Put(record: EnvironmentRecord): Promise<void>
    {
        this.records.set(record.name, { ...record })
        await this.persist()
    }

    public async Remove(name: string): Promise<void>
    {
        this.records.delete(name)
        await this.persist()
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
        await this.persist()
    }

    /** Writes run one at a time; each snapshots the records when it starts, so a later write carries every earlier change. */
    private persist(): Promise<void>
    {
        return this.writes.Run(() => this.WriteFile(this.Body()))
    }

    /** Writes the file atomically; overridable so a test can hold a write. */
    protected WriteFile(body: object): Promise<void>
    {
        return AtomicJsonFile.Write(this.filePath, body, EnvironmentRegistry.JsonIndent)
    }

    private Body(): object
    {
        return { [EnvironmentRegistry.RootKey]: Object.fromEntries(this.records) }
    }
}
