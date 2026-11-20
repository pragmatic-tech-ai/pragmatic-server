import { AtomicJsonFile } from './atomic-json-file.js'
import { FileRecordMap, type IRecordMap } from './record-map.js'

/**
 * A registry of records by id, held in memory (reads are synchronous copies) and persisted through a record map: the
 * `{ <root>: { <id>: record } }` JSON file when constructed from a path, or any IRecordMap (the Postgres table of the
 * platform admin console). Writes are write-behind batches of the ids changed since the last write.
 */
export abstract class JsonRecordStore<TRecord extends { id: string }>
{
    private readonly records = new Map<string, TRecord>()
    /** Ids staged or unstaged since the last write that included them. */
    private readonly changed = new Set<string>()
    private readonly map: IRecordMap<TRecord>
    private readonly filePath: string | undefined
    private waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = []
    private draining = false

    protected constructor(location: string | IRecordMap<TRecord>, rootKey: string)
    {
        if (typeof location === 'string')
        {
            this.filePath = location
            this.map = new FileRecordMap<TRecord>(location, { RootKey: rootKey, WriteText: (_path, text) => this.WriteText(text) })
        }
        else
        {
            this.filePath = undefined
            this.map = location
        }
    }

    public async Load(): Promise<void>
    {
        this.records.clear()
        this.changed.clear()
        for (const [id, record] of await this.map.Load())
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
        this.changed.add(record.id)
    }

    /** Mutates memory only; pair with Flush() to persist. */
    protected Unstage(id: string): boolean
    {
        const removed = this.records.delete(id)
        if (removed)
        {
            this.changed.add(id)
        }
        return removed
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

    /** The file form's write primitive (temp + rename); overridable for observation. Unused over another record map. */
    protected WriteText(text: string): Promise<void>
    {
        return AtomicJsonFile.WriteText(this.filePath as string, text)
    }

    /** Writes the ids changed since the last write; on failure they stay pending, so the next Flush retries them. */
    private async persist(): Promise<void>
    {
        const batch = new Set(this.changed)
        this.changed.clear()
        try
        {
            await this.map.Save(this.records, batch)
        }
        catch (err)
        {
            for (const id of batch)
            {
                this.changed.add(id)
            }
            throw err
        }
    }
}
