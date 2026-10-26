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

    private readonly maxAttempts: number
    private readonly windowMs: number
    private readonly lockoutMs: number
    private readonly maxKeys: number
    private readonly now: () => number
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
            : { failures: prior.failures + LoginThrottle.FirstFailure, windowStart: prior.windowStart, lockedUntil: prior.lockedUntil }
        if (entry.failures >= this.maxAttempts)
        {
            entry.lockedUntil = now + this.lockoutMs
        }
        this.entries.delete(key)
        this.entries.set(key, entry)
        while (this.entries.size > this.maxKeys)
        {
            const oldest = this.entries.keys().next()
            if (oldest.done === true)
            {
                break
            }
            this.entries.delete(oldest.value)
        }
    }

    public Clear(email: string, ip: string): void
    {
        this.entries.delete(LoginThrottle.KeyOf(email, ip))
    }

    private Prune(now: number): void
    {
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
