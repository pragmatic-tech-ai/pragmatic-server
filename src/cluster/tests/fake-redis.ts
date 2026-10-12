import type { RedisClientType } from 'redis'

interface ZEntry
{
    score: number
    value: string
}

/** Minimal in-memory Redis double shared across clients, modelling only the commands the cluster router and worker
 *  registration use: string set/get (NX/PX), a single compare-pexpire eval, and a sorted set (zAdd/zRangeByScore/zRem).
 *  TTLs are tracked but do not auto-expire; tests control liveness by score and membership. */
export class FakeRedisStore
{
    private readonly strings = new Map<string, string>()
    private readonly stringPx = new Map<string, number>()
    private readonly zsets = new Map<string, ZEntry[]>()

    public Client(): RedisClientType
    {
        return new FakeRedisClient(this) as unknown as RedisClientType
    }

    public SetString(key: string, value: string): void
    {
        this.strings.set(key, value)
    }

    public GetString(key: string): string | undefined
    {
        return this.strings.get(key)
    }

    public DeleteString(key: string): void
    {
        this.strings.delete(key)
    }

    public PxOf(key: string): number | undefined
    {
        return this.stringPx.get(key)
    }

    public SetPx(key: string, px: number): void
    {
        this.stringPx.set(key, px)
    }

    public ZAdd(key: string, entry: ZEntry): void
    {
        const set = this.zsets.get(key) ?? []
        const next = set.filter(e => e.value !== entry.value)
        next.push(entry)
        this.zsets.set(key, next)
    }

    public ZRangeByScore(key: string, min: number): string[]
    {
        return (this.zsets.get(key) ?? []).filter(e => e.score >= min).map(e => e.value)
    }

    public ZRem(key: string, member: string): void
    {
        const set = this.zsets.get(key)
        if (set !== undefined)
        {
            this.zsets.set(key, set.filter(e => e.value !== member))
        }
    }
}

/** A client bound to one FakeRedisStore. Several clients over one store share state (for multi-router tests). */
class FakeRedisClient
{
    private static readonly PexpireMarker = 'pexpire'

    private _open = true

    public constructor(private readonly store: FakeRedisStore)
    {
    }

    public get isOpen(): boolean
    {
        return this._open
    }

    public async connect(): Promise<void>
    {
    }

    public on(_event: string, _cb: (...args: unknown[]) => void): this
    {
        return this
    }

    public async quit(): Promise<void>
    {
        this._open = false
    }

    public async set(key: string, value: string, options?: { NX?: boolean; PX?: number }): Promise<string | null>
    {
        if (options?.NX === true && this.store.GetString(key) !== undefined)
        {
            return null
        }
        this.store.SetString(key, value)
        if (options?.PX !== undefined)
        {
            this.store.SetPx(key, options.PX)
        }
        return 'OK'
    }

    public async get(key: string): Promise<string | null>
    {
        return this.store.GetString(key) ?? null
    }

    public async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<number>
    {
        if (!script.includes(FakeRedisClient.PexpireMarker))
        {
            return 0
        }
        const key = options.keys[0]!
        if (this.store.GetString(key) === options.arguments[0])
        {
            this.store.SetPx(key, Number(options.arguments[1]))
            return 1
        }
        return 0
    }

    public async zAdd(key: string, entry: { score: number; value: string }): Promise<number>
    {
        this.store.ZAdd(key, entry)
        return 1
    }

    public async zRangeByScore(key: string, min: number, _max: string): Promise<string[]>
    {
        return this.store.ZRangeByScore(key, min)
    }

    public async zRem(key: string, member: string): Promise<number>
    {
        this.store.ZRem(key, member)
        return 1
    }
}
