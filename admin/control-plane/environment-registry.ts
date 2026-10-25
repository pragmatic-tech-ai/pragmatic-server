import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EnvStatus, EnvType, type EnvironmentRecord, type IContainerProbe } from './environment-record.js'

type PersistedEnvironmentRecord = Omit<EnvironmentRecord, 'type'> & { type?: EnvType }

export class EnvironmentRegistry
{
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly RootKey = 'environments'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2

    private readonly records = new Map<string, EnvironmentRecord>()

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

    public async Reconcile(): Promise<void>
    {
        for (const record of this.records.values())
        {
            if (record.status === EnvStatus.Failed)
            {
                continue
            }
            const running = await this.probe.Running(record.containerName ?? '')
            this.records.set(record.name, { ...record, status: running ? EnvStatus.Running : EnvStatus.Stopped })
        }
        await this.persist()
    }

    private async persist(): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const body = { [EnvironmentRegistry.RootKey]: Object.fromEntries(this.records) }
        const temp = `${this.filePath}.${randomUUID()}${EnvironmentRegistry.TempSuffix}`
        await writeFile(temp, JSON.stringify(body, null, EnvironmentRegistry.JsonIndent), EnvironmentRegistry.Encoding)
        await rename(temp, this.filePath)
    }
}
