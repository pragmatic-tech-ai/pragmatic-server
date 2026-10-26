export interface LoginThrottleOptions
{
    maxAttempts?: number
    windowMs?: number
    lockoutMs?: number
    maxKeys?: number
    now?: () => number
}

export interface LoginThrottleDecision
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
 * In-memory login throttle keyed by (normalized email, client ip). A key locks for a fixed
 * lockout after `maxAttempts` failures inside one window. Memory is bounded: stale entries are
 * pruned on access and the oldest are evicted past `maxKeys`.
 */
export class LoginThrottle
{
    private static readonly DefaultMaxAttempts = 5
    private static readonly DefaultWindowMs = 15 * 60 * 1000
    private static readonly DefaultLockoutMs = 15 * 60 * 1000
    private static readonly DefaultMaxKeys = 10000
    private static readonly KeySeparator = '\u0000'
    private static readonly NoRetryMs = 0
    private static readonly NoLock = 0
    private static readonly FirstFailure = 1
    private static readonly Increment = 1
    private static readonly NeverPruned = Number.NEGATIVE_INFINITY

    private readonly maxAttempts: number
    private readonly windowMs: number
    private readonly lockoutMs: number
    private readonly maxKeys: number
    private readonly now: () => number
    private lastPruneAt = LoginThrottle.NeverPruned
    // Map preserves insertion order; entries are re-inserted on update so the first key is the oldest.
    private readonly entries = new Map<string, ThrottleEntry>()

    public constructor(options: LoginThrottleOptions = {})
    {
        this.maxAttempts = options.maxAttempts ?? LoginThrottle.DefaultMaxAttempts
        this.windowMs = options.windowMs ?? LoginThrottle.DefaultWindowMs
        this.lockoutMs = options.lockoutMs ?? LoginThrottle.DefaultLockoutMs
        this.maxKeys = options.maxKeys ?? LoginThrottle.DefaultMaxKeys
        this.now = options.now ?? Date.now
    }

    public CheckAllowed(email: string, ip: string): LoginThrottleDecision
    {
        const now = this.now()
        this.Prune(now)
        const entry = this.entries.get(LoginThrottle.KeyOf(email, ip))
        if (entry !== undefined && entry.lockedUntil > now)
        {
            return { allowed: false, retryAfterMs: entry.lockedUntil - now }
        }
        return { allowed: true, retryAfterMs: LoginThrottle.NoRetryMs }
    }

    public RecordFailure(email: string, ip: string): void
    {
        const now = this.now()
        this.Prune(now)
        const key = LoginThrottle.KeyOf(email, ip)
        const prior = this.entries.get(key)
        const fresh = prior === undefined || now - prior.windowStart >= this.windowMs
        const entry: ThrottleEntry = fresh
            ? { failures: LoginThrottle.FirstFailure, windowStart: now, lockedUntil: LoginThrottle.NoLock }
            : { failures: prior.failures + LoginThrottle.Increment, windowStart: prior.windowStart, lockedUntil: prior.lockedUntil }
        if (entry.failures >= this.maxAttempts)
        {
            entry.lockedUntil = now + this.lockoutMs
        }
        this.entries.delete(key)
        this.entries.set(key, entry)
        while (this.entries.size > this.maxKeys)
        {
            this.EvictOne(now, key)
        }
    }

    /** Number of tracked keys (observability / tests). */
    public Size(): number
    {
        return this.entries.size
    }

    /** Evicts the oldest UNLOCKED entry; a locked entry only if none is unlocked; never the key just recorded (so spraying keys cannot shed a lock). */
    private EvictOne(now: number, keep: string): void
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
                return
            }
            fallback ??= key
        }
        if (fallback !== undefined)
        {
            this.entries.delete(fallback)
        }
    }

    public Clear(email: string, ip: string): void
    {
        this.entries.delete(LoginThrottle.KeyOf(email, ip))
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

    private static KeyOf(email: string, ip: string): string
    {
        return email.trim().toLowerCase() + LoginThrottle.KeySeparator + ip
    }
}
