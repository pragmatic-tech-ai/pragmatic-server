import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IdpRecord } from './idp-record.js'

export class IdpRegistry
{
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly RootKey = 'idps'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2

    private readonly records = new Map<string, IdpRecord>()

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

    private async persist(): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const body = { [IdpRegistry.RootKey]: Object.fromEntries(this.records) }
        const temp = `${this.filePath}.${randomUUID()}${IdpRegistry.TempSuffix}`
        await writeFile(temp, JSON.stringify(body, null, IdpRegistry.JsonIndent), IdpRegistry.Encoding)
        await rename(temp, this.filePath)
    }
}
