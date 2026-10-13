import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import type { DataPoint } from '@opentelemetry/sdk-metrics'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { Observability, ObservabilityRole } from '../../observability/observability.js'
import { RateLimitScope, TokenBucketRateLimiter, NullRateLimiter } from '../rate-limiter.js'
import type { IRateLimiter, RateLimitDecision } from '../rate-limiter.js'
import { RateLimitGuard } from '../rate-limit-guard.js'
import { AuditSurface, AuditOutcome } from '../access-audit.js'
import type { IAccessAuditSink, AccessAuditEvent } from '../access-audit.js'
import type { ILogger, LogFields } from '../../observability/logger.js'

class CapturingSink implements IAccessAuditSink
{
    public readonly Events: AccessAuditEvent[] = []

    public Record(event: AccessAuditEvent): Promise<void>
    {
        this.Events.push(event)
        return Promise.resolve()
    }
}

class ThrowingSink implements IAccessAuditSink
{
    public Record(): Promise<void>
    {
        throw new Error('sink down')
    }
}

class FakeClock
{
    public Now = 0
    public readonly Tick = (): number => this.Now
}

class Points
{
    public static async Of(reader: PeriodicExportingMetricReader, name: string): Promise<Array<DataPoint<number>>>
    {
        const collected = await reader.collect()
        const out: Array<DataPoint<number>> = []
        for (const scope of collected.resourceMetrics.scopeMetrics)
        {
            for (const metric of scope.metrics)
            {
                if (metric.descriptor.name === name)
                {
                    out.push(...(metric.dataPoints as Array<DataPoint<number>>))
                }
            }
        }
        return out
    }
}

test('a rejection audits a RateLimited event and increments rate_limited_total with scope+tenant but no principal label', async () =>
{
    const reader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 2_147_483_647 })
    const observability = Observability.ForTest({ role: ObservabilityRole.Host, serviceName: 'svc' }, new InMemorySpanExporter(), reader)
    const sink = new CapturingSink()
    const clock = new FakeClock()
    const guard = new RateLimitGuard(new TokenBucketRateLimiter({ perTenant: { Rps: 1, Burst: 1 } }, clock.Tick), sink, observability.Meter().createCounter(RateLimitGuard.MetricName()))
    const request = { scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }
    const context = { surface: AuditSurface.Upgrade, tenant: 't1', principal: 'p1', methodOrPath: 'ws-upgrade', correlationId: 'trace-1' }
    assert.equal(guard.Check(request, context).Allowed, true)
    assert.equal(guard.Check(request, context).Allowed, false)
    assert.equal(sink.Events.length, 1)
    assert.equal(sink.Events[0]!.Outcome, AuditOutcome.RateLimited)
    assert.equal(sink.Events[0]!.Surface, AuditSurface.Upgrade)
    const pts = await Points.Of(reader, 'rate_limited_total')
    assert.equal(pts.length, 1)
    assert.equal(pts[0]!.value, 1)
    assert.equal(pts[0]!.attributes.scope, 'tenant')
    assert.equal(pts[0]!.attributes.tenant, 't1')
    assert.equal(pts[0]!.attributes.principal, undefined)
    await observability.Shutdown()
})

test('a throwing audit sink never escapes and the rejection stands', () =>
{
    const guard = new RateLimitGuard(new TokenBucketRateLimiter({ perTenant: { Rps: 0.001, Burst: 1 } }), new ThrowingSink())
    const request = { scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }
    const context = { surface: AuditSurface.Upgrade, tenant: 't1', methodOrPath: 'ws' }
    assert.equal(guard.Check(request, context).Allowed, true)
    assert.equal(guard.Check(request, context).Allowed, false)
})

test('a disabled guard is pure pass-through: every request allowed, nothing audited, nothing metered', () =>
{
    const sink = new CapturingSink()
    const guard = new RateLimitGuard(new NullRateLimiter(), sink)
    for (let i = 0; i < 50; i++)
    {
        assert.equal(guard.Check({ scope: RateLimitScope.Principal, tenant: 't1', key: 'p1' }, { surface: AuditSurface.Rpc, tenant: 't1', methodOrPath: 'm' }).Allowed, true)
    }
    assert.equal(sink.Events.length, 0)
})

test('a bare guard (no args) allows everything and never touches audit or metrics', () =>
{
    const guard = new RateLimitGuard()
    assert.equal(guard.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }, { surface: AuditSurface.Upgrade, tenant: 't1', methodOrPath: 'ws' }).Allowed, true)
})

class RejectingSink implements IAccessAuditSink
{
    public Record(): Promise<void>
    {
        return Promise.reject(new Error('sink rejected'))
    }
}

class ThrowingLimiter implements IRateLimiter
{
    public Check(): RateLimitDecision
    {
        throw new Error('limiter broke')
    }
}

test('a rejecting audit sink leaves Check rejecting with a retry hint and raises no unhandledRejection', async () =>
{
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', listener)
    try
    {
        const guard = new RateLimitGuard(new TokenBucketRateLimiter({ perTenant: { Rps: 0.001, Burst: 1 } }), new RejectingSink())
        const request = { scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }
        const context = { surface: AuditSurface.Upgrade, tenant: 't1', methodOrPath: 'ws' }
        guard.Check(request, context)
        const decision = guard.Check(request, context)
        assert.equal(decision.Allowed, false)
        assert.ok(decision.RetryAfterMs > 0)
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(unhandled.length, 0)
    }
    finally
    {
        process.off('unhandledRejection', listener)
    }
})

test('Check is total: an unexpected limiter error allows the request instead of throwing', () =>
{
    const guard = new RateLimitGuard(new ThrowingLimiter())
    assert.equal(guard.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }, { surface: AuditSurface.Upgrade, tenant: 't1', methodOrPath: 'ws' }).Allowed, true)
})

class CapturingLogger implements ILogger
{
    public readonly Errors: Array<{ message: string; fields?: LogFields }> = []

    public Info(): void
    {
    }

    public Warn(): void
    {
    }

    public Error(message: string, fields?: LogFields): void
    {
        this.Errors.push({ message, fields })
    }

    public Child(): ILogger
    {
        return this
    }
}

test('a limiter error fails open observably: allowed, one logged error, rate_limit_errors_total incremented', async () =>
{
    const reader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 2_147_483_647 })
    const observability = Observability.ForTest({ role: ObservabilityRole.Host, serviceName: 'svc' }, new InMemorySpanExporter(), reader)
    const logger = new CapturingLogger()
    const guard = new RateLimitGuard(new ThrowingLimiter(), undefined, undefined, logger, observability.Meter().createCounter(RateLimitGuard.ErrorMetricName()))
    const decision = guard.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }, { surface: AuditSurface.Upgrade, tenant: 't1', methodOrPath: 'ws' })
    assert.equal(decision.Allowed, true)
    assert.equal(logger.Errors.length, 1)
    assert.equal(logger.Errors[0]!.fields?.tenant, 't1')
    const pts = await Points.Of(reader, 'rate_limit_errors_total')
    assert.equal(pts.length, 1)
    assert.equal(pts[0]!.value, 1)
    await observability.Shutdown()
})

test('TooManyRequestsResponse emits whole-second Retry-After, defaulting to 1 for 0 and NaN', () =>
{
    const header = (ms: number): string => /Retry-After: (\S+)\r\n/.exec(RateLimitGuard.TooManyRequestsResponse(ms))![1]!
    assert.equal(header(0), '1')
    assert.equal(header(1), '1')
    assert.equal(header(1500), '2')
    assert.equal(header(Number.NaN), '1')
    assert.ok(RateLimitGuard.TooManyRequestsResponse(1).startsWith('HTTP/1.1 429 Too Many Requests\r\n'))
})
