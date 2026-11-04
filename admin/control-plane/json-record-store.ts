import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export abstract class JsonRecordStore<TRecord extends { id: string }>
{
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2

    private readonly records = new Map<string, TRecord>()
    private waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = []
    private draining = false

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
            this.records.set(id, structuredClone(record))
        }
    }

    public List(): readonly TRecord[]
    {
        return [...this.records.values()].map(r => structuredClone(r))
    }

    /** Internal, read-only: the live records (no clone); callers must not mutate them. */
    protected Values(): IterableIterator<TRecord>
    {
        return this.records.values()
    }

    public Get(id: string): TRecord | undefined
    {
        const record = this.records.get(id)
        return record === undefined ? undefined : structuredClone(record)
    }

    /** Stages the record and resolves once a write including it is durable; writes are serialized through Flush. */
    public async Put(record: TRecord): Promise<void>
    {
        this.Stage(record)
        await this.Flush()
    }

    /** Unstages the record and, if it existed, resolves once a write without it is durable (serialized through Flush). */
    public async Remove(id: string): Promise<void>
    {
        if (this.Unstage(id))
        {
            await this.Flush()
        }
    }

    /** Mutates memory only; pair with Flush() to persist. */
    protected Stage(record: TRecord): void
    {
        this.records.set(record.id, structuredClone(record))
    }

    /** Mutates memory only; pair with Flush() to persist. */
    protected Unstage(id: string): boolean
    {
        return this.records.delete(id)
    }

    /**
     * Write-behind persist: every Flush call made while a write is in flight shares ONE following write
     * (at most one in flight plus one queued). Resolves once a write that included the caller's staged
     * changes completes; a failed write rejects every Flush it covered, and the next Flush retries the full state.
     */
    protected Flush(): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            this.waiters.push({ resolve, reject })
            if (!this.draining)
            {
                this.draining = true
                void this.Drain()
            }
        })
    }

    private async Drain(): Promise<void>
    {
        try
        {
            while (this.waiters.length > 0)
            {
                const batch = this.waiters
                this.waiters = []
                try
                {
                    await this.persist()
                    batch.forEach(w => w.resolve())
                }
                catch (err)
                {
                    batch.forEach(w => w.reject(err))
                }
            }
        }
        finally
        {
            this.draining = false
        }
    }

    /** The single file-write primitive (temp + rename); overridable for observation. */
    protected async WriteText(text: string): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const temp = `${this.filePath}.${randomUUID()}${JsonRecordStore.TempSuffix}`
        await writeFile(temp, text, JsonRecordStore.Encoding)
        try
        {
            await rename(temp, this.filePath)
        }
        catch (err)
        {
            await unlink(temp).catch(() => undefined)
            throw err
        }
    }

    private async persist(): Promise<void>
    {
        const body = { [this.rootKey]: Object.fromEntries(this.records) }
        await this.WriteText(JSON.stringify(body, null, JsonRecordStore.JsonIndent))
    }
}
