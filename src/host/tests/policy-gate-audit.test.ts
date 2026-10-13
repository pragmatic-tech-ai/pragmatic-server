import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, Action, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { LanguageProtocol, SolutionProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { trace } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { Observability, ObservabilityRole } from '../../observability/observability.js'
import { PolicyGate } from '../policy-gate.js'
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

class RejectingSink implements IAccessAuditSink
{
    public Record(): Promise<void>
    {
        return Promise.reject(new Error('sink rejected'))
    }
}

class Fixtures
{
    public static Context(role: Role | null): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = role === null ? [] : [new Grant('p1', role, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }
}

test('an allowed Authorize emits one Allow event with action, kind, principal and tenant', () =>
{
    const sink = new CapturingSink()
    const gate = new PolicyGate(Fixtures.Context(Role.Viewer), () => ['my-solution'], sink)
    const decision = gate.Authorize(LanguageProtocol.CompletionsAt.method)
    assert.equal(decision.Allowed, true)
    assert.equal(sink.Events.length, 1)
    const event = sink.Events[0]!
    assert.equal(event.Outcome, AuditOutcome.Allow)
    assert.equal(event.Surface, AuditSurface.Rpc)
    assert.equal(event.TenantId, 't1')
    assert.equal(event.PrincipalId, 'p1')
    assert.equal(event.MethodOrPath, LanguageProtocol.CompletionsAt.method)
    assert.equal(event.Action, Action.Read)
    assert.equal(event.ResourceKind, ResourceKind.Model)
    assert.equal(event.ResourcePath, 'my-solution')
})

test('a denied Authorize emits one Deny event', () =>
{
    const sink = new CapturingSink()
    const gate = new PolicyGate(Fixtures.Context(Role.Viewer), () => [], sink)
    assert.equal(gate.Authorize(SolutionProtocol.OpenSolution.method).Allowed, false)
    assert.equal(sink.Events.length, 1)
    assert.equal(sink.Events[0]!.Outcome, AuditOutcome.Deny)
})

test('an untabled method emits a Deny event without Action or ResourceKind', () =>
{
    const sink = new CapturingSink()
    const gate = new PolicyGate(Fixtures.Context(Role.Owner), () => [], sink)
    assert.equal(gate.Authorize('bogus/method').Allowed, false)
    assert.equal(sink.Events[0]!.Outcome, AuditOutcome.Deny)
    assert.equal(sink.Events[0]!.Action, undefined)
    assert.equal(sink.Events[0]!.ResourceKind, undefined)
})

test('a sink that throws does not change the AccessDecision and does not escape', () =>
{
    const gate = new PolicyGate(Fixtures.Context(Role.Viewer), () => [], new ThrowingSink())
    assert.equal(gate.Authorize(LanguageProtocol.CompletionsAt.method).Allowed, true)
    assert.equal(gate.Authorize(SolutionProtocol.OpenSolution.method).Allowed, false)
})

test('a sink that rejects does not change the AccessDecision and raises no unhandled rejection', async () =>
{
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', listener)
    try
    {
        const gate = new PolicyGate(Fixtures.Context(Role.Viewer), () => [], new RejectingSink())
        assert.equal(gate.Authorize(LanguageProtocol.CompletionsAt.method).Allowed, true)
        assert.equal(gate.Authorize(SolutionProtocol.OpenSolution.method).Allowed, false)
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(unhandled.length, 0)
    }
    finally
    {
        process.off('unhandledRejection', listener)
    }
})

test('CanRead does not emit', () =>
{
    const sink = new CapturingSink()
    const gate = new PolicyGate(Fixtures.Context(Role.Viewer), () => [], sink)
    gate.CanRead()
    assert.equal(sink.Events.length, 0)
})

test('with an active valid span the event carries its trace id; with none it is undefined', async () =>
{
    const sink = new CapturingSink()
    const gate = new PolicyGate(Fixtures.Context(Role.Viewer), () => [], sink)
    gate.Authorize(LanguageProtocol.CompletionsAt.method)
    assert.equal(sink.Events[0]!.CorrelationId, undefined)

    const metricReader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 2_147_483_647 })
    const observability = Observability.ForTest({ role: ObservabilityRole.Host, serviceName: 'svc' }, new InMemorySpanExporter(), metricReader)
    try
    {
        let traceId: string | undefined
        observability.Tracer().startActiveSpan('t', span =>
        {
            traceId = trace.getActiveSpan()?.spanContext().traceId
            gate.Authorize(LanguageProtocol.CompletionsAt.method)
            span.end()
        })
        assert.notEqual(traceId, undefined)
        assert.equal(sink.Events[1]!.CorrelationId, traceId)
    }
    finally
    {
        await observability.Shutdown()
    }
})
