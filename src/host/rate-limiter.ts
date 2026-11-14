import { performance } from 'node:perf_hooks'

/** The two per-replica rate-limit dimensions. */
export enum RateLimitScope
{
    Environment = 'environment',
    Principal = 'principal',
}

/** One rate-limit query: the scope, the environment (used as a bounded metric label by the guard), and the bucket key
 *  (environment id for Environment scope, principal id for Principal scope). */
export interface RateLimitRequest
{
    scope: RateLimitScope
    environment: string
    key: string
}

/** Per-scope token-bucket parameters. */
export interface RateLimitSettings
{
    Rps: number
    Burst: number
}

/** Optional per-scope settings; a scope left undefined is unlimited. Absent block entirely = disabled. */
export interface RateLimitConfig
{
    perEnvironment?: RateLimitSettings
    perPrincipal?: RateLimitSettings
}

/** Milliseconds from a monotonic source; injectable so tests advance time deterministically. */
export type MonotonicClock = () => number

/** The verdict for one query; RetryAfterMs is a hint for the caller's Retry-After / retry payload. */
export class RateLimitDecision
{
    public readonly Allowed: boolean
    public readonly RetryAfterMs: number

    private constructor(allowed: boolean, retryAfterMs: number)
    {
        this.Allowed = allowed
        this.RetryAfterMs = retryAfterMs
    }

    public static Allow(): RateLimitDecision
    {
        return new RateLimitDecision(true, 0)
    }

    public static Reject(retryAfterMs: number): RateLimitDecision
    {
        return new RateLimitDecision(false, retryAfterMs)
    }
}

/** The rate-limit seam. The in-memory implementation cannot error, so there is no fail-open path. */
export interface IRateLimiter
{
    Check(request: RateLimitRequest): RateLimitDecision
}

/** Default limiter: unlimited. Composing without a limiter is byte-safe. */
export class NullRateLimiter implements IRateLimiter
{
    public Check(): RateLimitDecision
    {
        return RateLimitDecision.Allow()
    }
}

/** One refillable bucket. Monotonic refill: tokens grow by elapsed-seconds * Rps, capped at Burst. */
class TokenBucket
{
    private static readonly MsPerSecond = 1000
    private static readonly MinRetryMs = 1

    private tokens: number
    private last: number

    public constructor(now: number, burst: number)
    {
        this.tokens = burst
        this.last = now
    }

    /** True when idle for at least the full-refill horizon (Burst / Rps): equivalent to a fresh full bucket. */
    public IsIdle(now: number, settings: RateLimitSettings): boolean
    {
        return now - this.last >= (settings.Burst / settings.Rps) * TokenBucket.MsPerSecond
    }

    public TryConsume(now: number, settings: RateLimitSettings): RateLimitDecision
    {
        const elapsedSeconds = Math.max(0, now - this.last) / TokenBucket.MsPerSecond
        this.tokens = Math.min(settings.Burst, this.tokens + elapsedSeconds * settings.Rps)
        this.last = Math.max(this.last, now)
        if (this.tokens >= 1)
        {
            this.tokens -= 1
            return RateLimitDecision.Allow()
        }
        const deficit = 1 - this.tokens
        const retryMs = Math.ceil((deficit / settings.Rps) * TokenBucket.MsPerSecond)
        return RateLimitDecision.Reject(Math.max(TokenBucket.MinRetryMs, retryMs))
    }
}

/** Per-replica in-memory token buckets, keyed independently per environment and per principal. Environment buckets are keyed by
 *  environment id; principal buckets by a length-prefixed (environment, principal) composite so the same principal id in two
 *  environments never shares a bucket and no (environment, key) pair can collide with another. Idle buckets are swept once a
 *  scope's map exceeds MaxBuckets, bounding memory against attacker-supplied ids. */
export class TokenBucketRateLimiter implements IRateLimiter
{
    public static readonly DefaultMaxBuckets = 10000
    private static readonly KeySeparator = ':'
    private static readonly InvalidRpsMessage = 'Invalid rate-limit config: Rps must be a finite number greater than 0'
    private static readonly InvalidBurstMessage = 'Invalid rate-limit config: Burst must be a finite number of at least 1'

    private readonly perEnvironment: RateLimitSettings | undefined
    private readonly perPrincipal: RateLimitSettings | undefined
    private readonly clock: MonotonicClock
    private readonly maxBuckets: number
    private readonly environmentBuckets = new Map<string, TokenBucket>()
    private readonly principalBuckets = new Map<string, TokenBucket>()
    private checksSinceSweep = 0

    public constructor(config: RateLimitConfig, clock: MonotonicClock = () => performance.now(), maxBuckets: number = TokenBucketRateLimiter.DefaultMaxBuckets)
    {
        TokenBucketRateLimiter.Validate(config.perEnvironment)
        TokenBucketRateLimiter.Validate(config.perPrincipal)
        this.perEnvironment = config.perEnvironment
        this.perPrincipal = config.perPrincipal
        this.clock = clock
        this.maxBuckets = maxBuckets
    }

    public Check(request: RateLimitRequest): RateLimitDecision
    {
        const isEnvironment = request.scope === RateLimitScope.Environment
        const settings = isEnvironment ? this.perEnvironment : this.perPrincipal
        if (settings === undefined)
        {
            return RateLimitDecision.Allow()
        }
        const buckets = isEnvironment ? this.environmentBuckets : this.principalBuckets
        const mapKey = isEnvironment ? request.key : TokenBucketRateLimiter.PrincipalKey(request.environment, request.key)
        const now = this.clock()
        this.MaybeSweep(buckets, settings, now)
        let bucket = buckets.get(mapKey)
        if (bucket === undefined)
        {
            bucket = new TokenBucket(now, settings.Burst)
            buckets.set(mapKey, bucket)
        }
        return bucket.TryConsume(now, settings)
    }

    /** Diagnostic: current bucket count for a scope. */
    public BucketCount(scope: RateLimitScope): number
    {
        return (scope === RateLimitScope.Environment ? this.environmentBuckets : this.principalBuckets).size
    }

    private MaybeSweep(buckets: Map<string, TokenBucket>, settings: RateLimitSettings, now: number): void
    {
        this.checksSinceSweep++
        if (buckets.size <= this.maxBuckets || this.checksSinceSweep < this.maxBuckets)
        {
            return
        }
        this.checksSinceSweep = 0
        for (const [key, bucket] of buckets)
        {
            if (bucket.IsIdle(now, settings))
            {
                buckets.delete(key)
            }
        }
    }

    private static PrincipalKey(environment: string, key: string): string
    {
        return `${environment.length}${TokenBucketRateLimiter.KeySeparator}${environment}${key}`
    }

    private static Validate(settings: RateLimitSettings | undefined): void
    {
        if (settings === undefined)
        {
            return
        }
        if (!Number.isFinite(settings.Rps) || settings.Rps <= 0)
        {
            throw new Error(TokenBucketRateLimiter.InvalidRpsMessage)
        }
        if (!Number.isFinite(settings.Burst) || settings.Burst < 1)
        {
            throw new Error(TokenBucketRateLimiter.InvalidBurstMessage)
        }
    }
}
