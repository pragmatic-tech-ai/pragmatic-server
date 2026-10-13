import { performance } from 'node:perf_hooks'

/** The two per-replica rate-limit dimensions. */
export enum RateLimitScope
{
    Tenant = 'tenant',
    Principal = 'principal',
}

/** One rate-limit query: the scope, the tenant (used as a bounded metric label by the guard), and the bucket key
 *  (tenant id for Tenant scope, principal id for Principal scope). */
export interface RateLimitRequest
{
    scope: RateLimitScope
    tenant: string
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
    perTenant?: RateLimitSettings
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

    public TryConsume(now: number, settings: RateLimitSettings): RateLimitDecision
    {
        const elapsedSeconds = Math.max(0, now - this.last) / TokenBucket.MsPerSecond
        this.tokens = Math.min(settings.Burst, this.tokens + elapsedSeconds * settings.Rps)
        this.last = now
        if (this.tokens >= 1)
        {
            this.tokens -= 1
            return RateLimitDecision.Allow()
        }
        const deficit = 1 - this.tokens
        const retryMs = settings.Rps > 0 ? Math.ceil((deficit / settings.Rps) * TokenBucket.MsPerSecond) : TokenBucket.MinRetryMs
        return RateLimitDecision.Reject(Math.max(TokenBucket.MinRetryMs, retryMs))
    }
}

/** Per-replica in-memory token buckets, keyed independently per tenant and per principal. */
export class TokenBucketRateLimiter implements IRateLimiter
{
    private readonly perTenant: RateLimitSettings | undefined
    private readonly perPrincipal: RateLimitSettings | undefined
    private readonly clock: MonotonicClock
    private readonly tenantBuckets = new Map<string, TokenBucket>()
    private readonly principalBuckets = new Map<string, TokenBucket>()

    public constructor(config: RateLimitConfig, clock: MonotonicClock = () => performance.now())
    {
        this.perTenant = config.perTenant
        this.perPrincipal = config.perPrincipal
        this.clock = clock
    }

    public Check(request: RateLimitRequest): RateLimitDecision
    {
        const settings = request.scope === RateLimitScope.Tenant ? this.perTenant : this.perPrincipal
        if (settings === undefined)
        {
            return RateLimitDecision.Allow()
        }
        const buckets = request.scope === RateLimitScope.Tenant ? this.tenantBuckets : this.principalBuckets
        const now = this.clock()
        let bucket = buckets.get(request.key)
        if (bucket === undefined)
        {
            bucket = new TokenBucket(now, settings.Burst)
            buckets.set(request.key, bucket)
        }
        return bucket.TryConsume(now, settings)
    }
}
