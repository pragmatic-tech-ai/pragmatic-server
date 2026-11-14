export interface IEnvironmentCoordinator
{
    Note(environmentId: string): void
    Acquire(environmentId: string): void
    Release(environmentId: string): void
    EvictCandidates(nowMs: number, idleTtlMs: number): readonly string[]
    Forget(environmentId: string): void
    Known(): readonly string[]
}

interface EnvironmentLiveness
{
    connections: number
    lastUseMs: number
}

/** In-process environment membership + connection-refcount + idle-evict bookkeeping.
 *  5B replaces this with a Redis-backed coordinator that also routes to workers. */
export class InMemoryEnvironmentCoordinator implements IEnvironmentCoordinator
{
    private readonly now: () => number
    private readonly environments = new Map<string, EnvironmentLiveness>()

    public constructor(now: () => number = () => Date.now())
    {
        this.now = now
    }

    public Note(environmentId: string): void
    {
        this.Entry(environmentId).lastUseMs = this.now()
    }

    public Acquire(environmentId: string): void
    {
        const entry = this.Entry(environmentId)
        entry.connections += 1
        entry.lastUseMs = this.now()
    }

    public Release(environmentId: string): void
    {
        const entry = this.environments.get(environmentId)
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
        for (const [environmentId, entry] of this.environments)
        {
            if (entry.connections === 0 && nowMs - entry.lastUseMs >= idleTtlMs)
            {
                candidates.push(environmentId)
            }
        }
        return candidates
    }

    public Forget(environmentId: string): void
    {
        this.environments.delete(environmentId)
    }

    public Known(): readonly string[]
    {
        return [...this.environments.keys()]
    }

    private Entry(environmentId: string): EnvironmentLiveness
    {
        let entry = this.environments.get(environmentId)
        if (entry === undefined)
        {
            entry = { connections: 0, lastUseMs: this.now() }
            this.environments.set(environmentId, entry)
        }
        return entry
    }
}
