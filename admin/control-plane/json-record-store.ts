import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export abstract class JsonRecordStore<TRecord extends { id: string }>
{
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2

    private readonly records = new Map<string, TRecord>()

    protected constructor(private readonly filePath: string, private readonly rootKey: string)
    {
    }

    public async Load(): Promise<void>
    {
        this.records.clear()
        let text: string
        try
        {
            text = await readFile(this.filePath, JsonRecordStore.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === JsonRecordStore.NotFoundCode)
            {
                return
            }
            throw err
        }
        const parsed = JSON.parse(text) as Record<string, Record<string, TRecord> | undefined>
        const stored = parsed[this.rootKey] ?? {}
        for (const [id, record] of Object.entries(stored))
        {
            this.records.set(id, { ...record })
        }
    }

    public List(): readonly TRecord[]
    {
        return [...this.records.values()]
    }

    public Get(id: string): TRecord | undefined
    {
        return this.records.get(id)
    }

    public async Put(record: TRecord): Promise<void>
    {
        this.records.set(record.id, { ...record })
        await this.persist()
    }

    public async Remove(id: string): Promise<void>
    {
        this.records.delete(id)
        await this.persist()
    }

    private async persist(): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const body = { [this.rootKey]: Object.fromEntries(this.records) }
        const temp = `${this.filePath}.${randomUUID()}${JsonRecordStore.TempSuffix}`
        await writeFile(temp, JSON.stringify(body, null, JsonRecordStore.JsonIndent), JsonRecordStore.Encoding)
        await rename(temp, this.filePath)
    }
}
