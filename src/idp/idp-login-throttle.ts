export interface IdpLoginThrottleOptions
{
    maxAttempts?: number
    windowMs?: number
    lockoutMs?: number
    maxKeys?: number
    now?: () => number
}

export interface IdpLoginThrottleDecision
{
    allowed: boolean
    retryAfterMs: number
}

interface ThrottleEntry
{
    failures: number
    windowStart: number
    lockedUntil: number
}

/**
 * Realm-local in-memory brute-force throttle for the per-tenant IdP, keyed by (tenantId, normalized
 * email, client ip). A key locks for a fixed lockout after `maxAttempts` failures inside one window.
 * Memory is bounded: stale entries are pruned on access and unlocked entries are evicted past `maxKeys`.
 * The key never involves a password or other secret.
 */
export class IdpLoginThrottle
{
    private static readonly DefaultMaxAttempts = 3
    private static readonly DefaultWindowMs = 15 * 60 * 1000
    private static readonly DefaultLockoutMs = 30 * 60 * 1000
    private static readonly DefaultMaxKeys = 10000
    private static readonly KeySeparator = '\u0000'
    private static readonly NoRetryMs = 0
    private static readonly NoLock = 0
    private static readonly FirstFailure = 1
    private static readonly Increment = 1
    private static readonly MinKeys = 1
    private static readonly NeverPruned = Number.NEGATIVE_INFINITY

    private readonly maxAttempts: number
    private readonly windowMs: number
    private readonly lockoutMs: number
    private readonly maxKeys: number
    private readonly now: () => number
    private lastPruneAt = IdpLoginThrottle.NeverPruned
    // Map preserves insertion order; entries are re-inserted on update so the first key is the oldest.
    private readonly entries = new Map<string, ThrottleEntry>()

    public constructor(options: IdpLoginThrottleOptions = {})
    {
        this.maxAttempts = options.maxAttempts ?? IdpLoginThrottle.DefaultMaxAttempts
        this.windowMs = options.windowMs ?? IdpLoginThrottle.DefaultWindowMs
        this.lockoutMs = options.lockoutMs ?? IdpLoginThrottle.DefaultLockoutMs
        this.maxKeys = Math.max(IdpLoginThrottle.MinKeys, options.maxKeys ?? IdpLoginThrottle.DefaultMaxKeys)
        this.now = options.now ?? Date.now
    }

    public CheckAllowed(tenantId: string, email: string, ip: string): IdpLoginThrottleDecision
    {
        const now = this.now()
        this.Prune(now)
        const entry = this.entries.get(IdpLoginThrottle.KeyOf(tenantId, email, ip))
        if (entry !== undefined && entry.lockedUntil > now)
        {
            return { allowed: false, retryAfterMs: entry.lockedUntil - now }
        }
        return { allowed: true, retryAfterMs: IdpLoginThrottle.NoRetryMs }
    }

    public RecordFailure(tenantId: string, email: string, ip: string): void
    {
        const now = this.now()
        this.Prune(now)
        const key = IdpLoginThrottle.KeyOf(tenantId, email, ip)
        const prior = this.entries.get(key)
        const fresh = prior === undefined || now - prior.windowStart >= this.windowMs
        const entry: ThrottleEntry = fresh
            ? { failures: IdpLoginThrottle.FirstFailure, windowStart: now, lockedUntil: IdpLoginThrottle.NoLock }
            : { failures: prior.failures + IdpLoginThrottle.Increment, windowStart: prior.windowStart, lockedUntil: prior.lockedUntil }
        if (entry.failures >= this.maxAttempts)
        {
            entry.lockedUntil = now + this.lockoutMs
        }
        this.entries.delete(key)
        this.entries.set(key, entry)
        while (this.entries.size > this.maxKeys && this.EvictOne(now, key))
        {
        }
    }

    public Clear(tenantId: string, email: string, ip: string): void
    {
        this.entries.delete(IdpLoginThrottle.KeyOf(tenantId, email, ip))
    }

    /** Number of tracked keys (observability / tests). */
    public Size(): number
    {
        return this.entries.size
    }

    /** Evicts the oldest UNLOCKED entry; a locked entry only if none is unlocked; never the key just recorded (so spraying keys cannot shed a lock). Returns false when there is no victim. */
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
        // because CheckAllowed compares lockedUntil and RecordFailure restarts a stale window.
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

    private static KeyOf(tenantId: string, email: string, ip: string): string
    {
        return tenantId + IdpLoginThrottle.KeySeparator + email.trim().toLowerCase() + IdpLoginThrottle.KeySeparator + ip
    }
}
