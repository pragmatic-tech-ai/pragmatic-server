export interface ITenantCoordinator
{
    Note(tenantId: string): void
    Acquire(tenantId: string): void
    Release(tenantId: string): void
    EvictCandidates(nowMs: number, idleTtlMs: number): readonly string[]
    Forget(tenantId: string): void
    Known(): readonly string[]
}

interface TenantLiveness
{
    connections: number
    lastUseMs: number
}

/** In-process tenant membership + connection-refcount + idle-evict bookkeeping.
 *  5B replaces this with a Redis-backed coordinator that also routes to workers. */
export class InMemoryTenantCoordinator implements ITenantCoordinator
{
    private readonly now: () => number
    private readonly tenants = new Map<string, TenantLiveness>()

    public constructor(now: () => number = () => Date.now())
    {
        this.now = now
    }

    public Note(tenantId: string): void
    {
        this.Entry(tenantId).lastUseMs = this.now()
    }

    public Acquire(tenantId: string): void
    {
        const entry = this.Entry(tenantId)
        entry.connections += 1
        entry.lastUseMs = this.now()
    }

    public Release(tenantId: string): void
    {
        const entry = this.tenants.get(tenantId)
        if (entry === undefined)
        {
            return
        }
        entry.connections = Math.max(0, entry.connections - 1)
        entry.lastUseMs = this.now()
    }

    public EvictCandidates(nowMs: number, idleTtlMs: number): readonly string[]
    {
        const candidates: string[] = []
        for (const [tenantId, entry] of this.tenants)
        {
            if (entry.connections === 0 && nowMs - entry.lastUseMs >= idleTtlMs)
            {
                candidates.push(tenantId)
            }
        }
        return candidates
    }

    public Forget(tenantId: string): void
    {
        this.tenants.delete(tenantId)
    }

    public Known(): readonly string[]
    {
        return [...this.tenants.keys()]
    }

    private Entry(tenantId: string): TenantLiveness
    {
        let entry = this.tenants.get(tenantId)
        if (entry === undefined)
        {
            entry = { connections: 0, lastUseMs: this.now() }
            this.tenants.set(tenantId, entry)
        }
        return entry
    }
}
