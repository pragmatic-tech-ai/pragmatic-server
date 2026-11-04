import type { PortForwardResult } from './kubectl.js'

/** A hold on a pooled tunnel: its loopback port, kept open until every lease on it is released. */
export interface ITunnelLease
{
    readonly LocalPort: number
    /** Gives the hold back; idempotent. When the last lease goes, the tunnel's idle countdown starts. */
    Release(): void
}

/** The pool was closed while a tunnel was still opening: the tunnel was killed, so its port is useless. */
export class TunnelPoolClosedError extends Error
{
    public static readonly DefaultMessage = 'The cluster tunnel pool was closed.'
    private static readonly ErrorName = 'TunnelPoolClosedError'

    public constructor()
    {
        super(TunnelPoolClosedError.DefaultMessage)
        this.name = TunnelPoolClosedError.ErrorName
    }
}

/** One pooled tunnel: the in-flight or landed open, its process once landed, its outstanding leases and idle timer. */
type TunnelEntry = {
    opening: Promise<number>
    result?: PortForwardResult
    leases: number
    closed: boolean
    timer?: ReturnType<typeof setTimeout>
}

/** One lease; Release decrements its tunnel's lease count at most once. */
class TunnelLease implements ITunnelLease
{
    private released = false

    public constructor(public readonly LocalPort: number, private readonly onRelease: () => void)
    {
    }

    public Release(): void
    {
        if (this.released)
        {
            return
        }
        this.released = true
        this.onRelease()
    }
}

/**
 * Keeps one kubectl port-forward per key (an environment on a hive) open while it is in use. Concurrent acquires for a
 * key share one open. A tunnel with outstanding leases never idles out; once its last lease is released it is killed
 * after idleMs unless acquired again. A tunnel whose process exits is dropped so the next acquire reopens it.
 * CloseAll (shutdown) kills every tunnel; acquires still waiting on an open reject with TunnelPoolClosedError.
 */
export class ClusterTunnelPool
{
    public static readonly DefaultIdleMs = 300_000

    private readonly entries = new Map<string, TunnelEntry>()

    public constructor(private readonly idleMs: number = ClusterTunnelPool.DefaultIdleMs)
    {
    }

    /** A lease on the key's tunnel, opening it through `open` when none is open (or opening) yet. */
    public async Acquire(key: string, open: () => Promise<PortForwardResult>): Promise<ITunnelLease>
    {
        let entry = this.entries.get(key)
        if (entry === undefined)
        {
            const created: TunnelEntry = { opening: Promise.resolve(0), leases: 0, closed: false }
            created.opening = this.Open(key, created, open)
            this.entries.set(key, created)
            entry = created
        }
        entry.leases++
        ClusterTunnelPool.CancelIdle(entry)
        const held = entry
        let port: number
        try
        {
            port = await held.opening
        }
        catch (err)
        {
            held.leases--
            throw err
        }
        return new TunnelLease(port, () => this.Release(key, held))
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
        if (entry.closed)
        {
            // Closed while opening: the tunnel has no owner, so it must not linger, and its port must not be handed out.
            result.Process.Kill()
            throw new TunnelPoolClosedError()
        }
        result.Process.OnExit(() => this.Drop(key, entry))
        return result.LocalPort
    }

    private Release(key: string, entry: TunnelEntry): void
    {
        entry.leases--
        if (entry.leases > 0 || entry.closed || this.entries.get(key) !== entry)
        {
            return
        }
        ClusterTunnelPool.CancelIdle(entry)
        entry.timer = setTimeout(() => this.Expire(key, entry), this.idleMs)
        // An idle tunnel's timer must not keep the control plane alive on its own.
        entry.timer.unref?.()
    }

    private Expire(key: string, entry: TunnelEntry): void
    {
        entry.timer = undefined
        if (this.entries.get(key) !== entry || entry.leases > 0)
        {
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
        ClusterTunnelPool.CancelIdle(entry)
    }

    private static CancelIdle(entry: TunnelEntry): void
    {
        if (entry.timer !== undefined)
        {
            clearTimeout(entry.timer)
            entry.timer = undefined
        }
    }

    private static Stop(entry: TunnelEntry): void
    {
        entry.closed = true
        ClusterTunnelPool.CancelIdle(entry)
        entry.result?.Process.Kill()
    }
}
