export interface AuditThrottleOptions
{
    maxHits?: number
    windowMs?: number
    lockoutMs?: number
    maxKeys?: number
    now?: () => number
}

export interface AuditThrottleDecision
{
    allowed: boolean
    retryAfterMs: number
}

interface AuditThrottleEntry
{
    hits: number
    windowStart: number
    lockedUntil: number
}

/**
 * In-memory per-client-ip throttle for pre-auth mutating denials. An ip locks for a fixed lockout
 * after `maxHits` hits inside one window, so an unauthenticated flood cannot swamp the capped audit
 * log. Memory is bounded: stale entries are pruned on access and the oldest are evicted past `maxKeys`.
 */
export class AuditThrottle
{
    private static readonly DefaultMaxHits = 30
    private static readonly DefaultWindowMs = 60 * 1000
    private static readonly DefaultLockoutMs = 60 * 1000
    private static readonly DefaultMaxKeys = 10000
    private static readonly NoRetryMs = 0
    private static readonly NoLock = 0
    private static readonly FirstHit = 1
    private static readonly Increment = 1
    private static readonly MinKeys = 1
    private static readonly NeverPruned = Number.NEGATIVE_INFINITY

    private readonly maxHits: number
    private readonly windowMs: number
    private readonly lockoutMs: number
    private readonly maxKeys: number
    private readonly now: () => number
    private lastPruneAt = AuditThrottle.NeverPruned
    // Map preserves insertion order; entries are re-inserted on update so the first key is the oldest.
    private readonly entries = new Map<string, AuditThrottleEntry>()

    public constructor(options: AuditThrottleOptions = {})
    {
        this.maxHits = options.maxHits ?? AuditThrottle.DefaultMaxHits
        this.windowMs = options.windowMs ?? AuditThrottle.DefaultWindowMs
        this.lockoutMs = options.lockoutMs ?? AuditThrottle.DefaultLockoutMs
        this.maxKeys = Math.max(AuditThrottle.MinKeys, options.maxKeys ?? AuditThrottle.DefaultMaxKeys)
        this.now = options.now ?? Date.now
    }

    public CheckAllowed(ip: string): AuditThrottleDecision
    {
        const now = this.now()
        this.Prune(now)
        const entry = this.entries.get(ip)
        if (entry !== undefined && entry.lockedUntil > now)
        {
            return { allowed: false, retryAfterMs: entry.lockedUntil - now }
        }
        return { allowed: true, retryAfterMs: AuditThrottle.NoRetryMs }
    }

    public RecordHit(ip: string): void
    {
        const now = this.now()
        this.Prune(now)
        const prior = this.entries.get(ip)
        const fresh = prior === undefined || now - prior.windowStart >= this.windowMs
        const entry: AuditThrottleEntry = fresh
            ? { hits: AuditThrottle.FirstHit, windowStart: now, lockedUntil: AuditThrottle.NoLock }
            : { hits: prior.hits + AuditThrottle.Increment, windowStart: prior.windowStart, lockedUntil: prior.lockedUntil }
        if (entry.hits > this.maxHits)
        {
            entry.lockedUntil = now + this.lockoutMs
        }
        this.entries.delete(ip)
        this.entries.set(ip, entry)
        while (this.entries.size > this.maxKeys && this.EvictOne(now, ip))
        {
        }
    }

    /** Number of tracked keys (observability / tests). */
    public Size(): number
    {
        return this.entries.size
    }

    /** Evicts the oldest UNLOCKED entry; a locked one only if none is unlocked; never the key just recorded. Returns false when there is no victim. */
    private EvictOne(now: number, keep: string): boolean
    {
        let fallback: string | undefined
        for (const [key, entry] of this.entries)
        {
            if (key === keep)
            {
                continue
            }
            if (entry.lockedUntil <= now)
            {
                this.entries.delete(key)
                return true
            }
            fallback ??= key
        }
        if (fallback === undefined)
        {
            return false
        }
        this.entries.delete(fallback)
        return true
    }

    private Prune(now: number): void
    {
        // Full scans are amortised: at most one per (window + lockout). Expired entries are never counted regardless,
        // because CheckAllowed compares lockedUntil and RecordHit restarts a stale window.
        if (now - this.lastPruneAt < this.windowMs + this.lockoutMs)
        {
            return
        }
        this.lastPruneAt = now
        for (const [key, entry] of this.entries)
        {
            const windowOver = now - entry.windowStart >= this.windowMs
            const lockOver = entry.lockedUntil <= now
            if (windowOver && lockOver)
            {
                this.entries.delete(key)
            }
        }
    }
}
