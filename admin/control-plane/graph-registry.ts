import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GraphRecord } from './graph-record.js'

export class GraphRegistry
{
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly RootKey = 'graphs'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2

    private readonly records = new Map<string, GraphRecord>()

    public constructor(private readonly filePath: string)
    {
    }

    public async Load(): Promise<void>
    {
        this.records.clear()
        let text: string
        try
        {
            text = await readFile(this.filePath, GraphRegistry.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === GraphRegistry.NotFoundCode)
            {
                return
            }
            throw err
        }
        const parsed = JSON.parse(text) as Record<string, Record<string, GraphRecord> | undefined>
        const graphs = parsed[GraphRegistry.RootKey] ?? {}
        for (const [name, record] of Object.entries(graphs))
        {
            this.records.set(name, { ...record })
        }
    }

    public List(): readonly GraphRecord[]
    {
        return [...this.records.values()]
    }

    public Get(name: string): GraphRecord | undefined
    {
        return this.records.get(name)
    }

    public async Put(record: GraphRecord): Promise<void>
    {
        this.records.set(record.manifest.name, { ...record })
        await this.persist()
    }

    public async Remove(name: string): Promise<void>
    {
        this.records.delete(name)
        await this.persist()
    }

    private async persist(): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const body = { [GraphRegistry.RootKey]: Object.fromEntries(this.records) }
        const temp = `${this.filePath}.${randomUUID()}${GraphRegistry.TempSuffix}`
        await writeFile(temp, JSON.stringify(body, null, GraphRegistry.JsonIndent), GraphRegistry.Encoding)
        await rename(temp, this.filePath)
    }
}
