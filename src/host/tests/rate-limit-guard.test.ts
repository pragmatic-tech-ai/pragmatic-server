import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import type { DataPoint } from '@opentelemetry/sdk-metrics'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { Observability, ObservabilityRole } from '../../observability/observability.js'
import { RateLimitScope, TokenBucketRateLimiter, NullRateLimiter } from '../rate-limiter.js'
import { RateLimitGuard } from '../rate-limit-guard.js'
import { AuditSurface, AuditOutcome } from '../access-audit.js'
import type { IAccessAuditSink, AccessAuditEvent } from '../access-audit.js'

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
