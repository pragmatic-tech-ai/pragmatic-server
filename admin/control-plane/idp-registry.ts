import { readFile } from 'node:fs/promises'
import { AtomicJsonFile, SerialRuns } from './atomic-json-file.js'
import type { IdpRecord } from './idp-record.js'

export class IdpRegistry
{
    private static readonly Encoding = 'utf8'
    private static readonly RootKey = 'idps'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2

    private readonly records = new Map<string, IdpRecord>()
    private readonly writes = new SerialRuns()

    public constructor(private readonly filePath: string)
    {
    }

    public async Load(): Promise<void>
    {
        this.records.clear()
        let text: string
        try
        {
            text = await readFile(this.filePath, IdpRegistry.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === IdpRegistry.NotFoundCode)
            {
                return
            }
            throw err
        }
        const parsed = JSON.parse(text) as Record<string, Record<string, IdpRecord> | undefined>
        const idps = parsed[IdpRegistry.RootKey] ?? {}
        for (const [tenantId, record] of Object.entries(idps))
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
        await this.persist()
    }

    public async Delete(tenantId: string): Promise<void>
    {
        this.records.delete(tenantId)
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
        return AtomicJsonFile.Write(this.filePath, body, IdpRegistry.JsonIndent)
    }

    private Body(): object
    {
        return { [IdpRegistry.RootKey]: Object.fromEntries(this.records) }
    }
}
