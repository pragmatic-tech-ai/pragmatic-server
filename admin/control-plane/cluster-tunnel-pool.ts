import type { IProcessSpawner, PortForwardResult } from './kubectl.js'

/** One pooled tunnel: the in-flight or landed open, its process once landed, and its idle bookkeeping. */
type TunnelEntry = {
    opening: Promise<number>
    result?: PortForwardResult
    lastUsed: number
    timer?: ReturnType<typeof setTimeout>
}

/**
 * Keeps one kubectl port-forward per key (an environment on a hive) open while it is in use. Concurrent acquires for a
 * key share one open; each acquire resets the idle clock; a tunnel idle for idleMs is killed; a tunnel whose process
 * exits is dropped so the next acquire reopens it. CloseAll (shutdown) kills every tunnel, including ones still opening.
 */
export class ClusterTunnelPool
{
    public static readonly DefaultIdleMs = 300_000

    private readonly entries = new Map<string, TunnelEntry>()

    public constructor(
        private readonly spawner: IProcessSpawner,
        private readonly idleMs: number = ClusterTunnelPool.DefaultIdleMs,
        private readonly now: () => number = () => Date.now())
    {
    }

    /** The spawner tunnels in this pool are opened with. */
    public get Spawner(): IProcessSpawner
    {
        return this.spawner
    }

    /** The local port of the key's tunnel, opening it through `open` when none is open (or opening) yet. */
    public Acquire(key: string, open: () => Promise<PortForwardResult>): Promise<number>
    {
        const existing = this.entries.get(key)
        if (existing !== undefined)
        {
            this.Touch(key, existing)
            return existing.opening
        }
        const entry: TunnelEntry = { opening: Promise.resolve(0), lastUsed: this.now() }
        entry.opening = this.Open(key, entry, open)
        this.entries.set(key, entry)
        return entry.opening
    }

    /** Kills every tunnel and forgets them all; a tunnel still opening is killed as soon as it lands. */
    public CloseAll(): void
    {
        const entries = [...this.entries.values()]
        this.entries.clear()
        for (const entry of entries)
        {
            ClusterTunnelPool.Stop(entry)
        }
    }

    private async Open(key: string, entry: TunnelEntry, open: () => Promise<PortForwardResult>): Promise<number>
    {
        let result: PortForwardResult
        try
        {
            result = await open()
        }
        catch (err)
        {
            this.Drop(key, entry)
            throw err
        }
        entry.result = result
        if (this.entries.get(key) !== entry)
        {
            // Closed (or replaced) while opening: this tunnel has no owner, so it must not linger.
            result.Process.Kill()
            return result.LocalPort
        }
        result.Process.OnExit(() => this.Drop(key, entry))
        this.Schedule(key, entry, this.idleMs)
        return result.LocalPort
    }

    private Touch(key: string, entry: TunnelEntry): void
    {
        entry.lastUsed = this.now()
        if (entry.result !== undefined)
        {
            this.Schedule(key, entry, this.idleMs)
        }
    }

    private Schedule(key: string, entry: TunnelEntry, delayMs: number): void
    {
        if (entry.timer !== undefined)
        {
            clearTimeout(entry.timer)
        }
        entry.timer = setTimeout(() => this.Expire(key, entry), delayMs)
        // An idle tunnel's timer must not keep the control plane alive on its own.
        entry.timer.unref?.()
    }

    private Expire(key: string, entry: TunnelEntry): void
    {
        if (this.entries.get(key) !== entry)
        {
            return
        }
        const idleFor = this.now() - entry.lastUsed
        if (idleFor < this.idleMs)
        {
            this.Schedule(key, entry, this.idleMs - idleFor)
            return
        }
        this.entries.delete(key)
        ClusterTunnelPool.Stop(entry)
    }

    private Drop(key: string, entry: TunnelEntry): void
    {
        if (this.entries.get(key) === entry)
        {
            this.entries.delete(key)
        }
        if (entry.timer !== undefined)
        {
            clearTimeout(entry.timer)
            entry.timer = undefined
        }
    }

    private static Stop(entry: TunnelEntry): void
    {
        if (entry.timer !== undefined)
        {
            clearTimeout(entry.timer)
            entry.timer = undefined
        }
        entry.result?.Process.Kill()
    }
}
