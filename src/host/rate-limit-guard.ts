import type { Counter } from '@opentelemetry/api'
import type { ILogger } from '../observability/logger.js'
import { NullRateLimiter } from './rate-limiter.js'
import { RateLimitDecision } from './rate-limiter.js'
import type { IRateLimiter, RateLimitRequest } from './rate-limiter.js'
import { NullAccessAuditSink, AuditOutcome } from './access-audit.js'
import type { IAccessAuditSink, AccessAuditEvent, AuditSurface } from './access-audit.js'

/** The non-limiter context a rejection needs to audit itself: surface, tenant (metric label), the method/path,
 *  the optional principal (audit only, never a metric label), and the correlation id. */
export interface RateLimitContext
{
    surface: AuditSurface
    tenant: string
    principal?: string
    methodOrPath: string
    correlationId?: string
}

/** Wraps an IRateLimiter so every rejection is a first-class audited (RateLimited) + metered
 *  (rate_limited_total{scope,tenant}) outcome. A bare guard (NullRateLimiter, no sink, no counter) is pure
 *  pass-through, so an unconfigured server is byte-unchanged. */
export class RateLimitGuard
{
    private static readonly Metric = 'rate_limited_total'
    private static readonly ScopeLabel = 'scope'
    private static readonly TenantLabel = 'tenant'
    private static readonly ErrorMetric = 'rate_limit_errors_total'
    private static readonly LimiterErrorMessage = 'rate limiter failed; request allowed (fail-open)'
    private static readonly SurfaceField = 'surface'
    private static readonly MethodField = 'methodOrPath'
    private static readonly ErrorField = 'error'
    public static readonly RejectedReason = 'rate limit exceeded'
    private static readonly StatusLine = 'HTTP/1.1 429 Too Many Requests'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly Crlf = '\r\n'
    private static readonly CloseHeader = 'Connection: close'
    private static readonly UpgradeMethod = 'ws-upgrade'

    private readonly limiter: IRateLimiter
    private readonly audit: IAccessAuditSink
    private readonly rejected: Counter | undefined
    private readonly logger: ILogger | undefined
    private readonly errors: Counter | undefined

    public constructor(limiter: IRateLimiter = new NullRateLimiter(), audit: IAccessAuditSink = new NullAccessAuditSink(), rejected?: Counter, logger?: ILogger, errors?: Counter)
    {
        this.limiter = limiter
        this.audit = audit
        this.rejected = rejected
        this.logger = logger
        this.errors = errors
    }

    public static MetricName(): string
    {
        return RateLimitGuard.Metric
    }

    public static ErrorMetricName(): string
    {
        return RateLimitGuard.ErrorMetric
    }

    /** The audit method/path recorded for a front-door Upgrade rejection. */
    public static UpgradeMethodName(): string
    {
        return RateLimitGuard.UpgradeMethod
    }

    /** The raw HTTP 429 written to an upgrade socket, with Retry-After in whole seconds (rounded up, at least 1). */
    public static TooManyRequestsResponse(retryAfterMs: number): string
    {
        const seconds = Number.isFinite(retryAfterMs) ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 1
        const crlf = RateLimitGuard.Crlf
        return `${RateLimitGuard.StatusLine}${crlf}${RateLimitGuard.RetryAfterHeader}: ${seconds}${crlf}${RateLimitGuard.CloseHeader}${crlf}${crlf}`
    }

    public Check(request: RateLimitRequest, context: RateLimitContext): RateLimitDecision
    {
        try
        {
            const decision = this.limiter.Check(request)
            if (!decision.Allowed)
            {
                this.Meter(request.scope, context.tenant)
                this.Emit(context)
            }
            return decision
        }
        catch (error)
        {
            // rate-limiting is an availability control, not an access gate: an unexpected internal error allows the request (observably)
            this.ReportLimiterError(request, context, error)
            return RateLimitDecision.Allow()
        }
    }

    private ReportLimiterError(request: RateLimitRequest, context: RateLimitContext, error: unknown): void
    {
        try
        {
            this.logger?.Error(RateLimitGuard.LimiterErrorMessage, {
                [RateLimitGuard.ScopeLabel]: request.scope,
                [RateLimitGuard.TenantLabel]: context.tenant,
                [RateLimitGuard.SurfaceField]: context.surface,
                [RateLimitGuard.MethodField]: context.methodOrPath,
                [RateLimitGuard.ErrorField]: error instanceof Error ? error.message : String(error),
            })
            this.errors?.add(1, { [RateLimitGuard.ScopeLabel]: request.scope, [RateLimitGuard.TenantLabel]: context.tenant })
        }
        catch
        {
            // a broken logger or meter must never turn a fail-open allow into a crash
        }
    }

    private Meter(scope: string, tenant: string): void
    {
        try
        {
            this.rejected?.add(1, { [RateLimitGuard.ScopeLabel]: scope, [RateLimitGuard.TenantLabel]: tenant })
        }
        catch
        {
            // a broken meter must never turn a rejection into a crash
        }
    }

    private Emit(context: RateLimitContext): void
    {
        const event: AccessAuditEvent = {
            Timestamp: new Date(),
            TenantId: context.tenant,
            PrincipalId: context.principal,
            Surface: context.surface,
            MethodOrPath: context.methodOrPath,
            Outcome: AuditOutcome.RateLimited,
            Reason: RateLimitGuard.RejectedReason,
            CorrelationId: context.correlationId,
        }
        try
        {
            void Promise.resolve(this.audit.Record(event)).catch(() => {})
        }
        catch
        {
            // audit is fire-and-forget: it must never change the rejection it describes
        }
    }
}
