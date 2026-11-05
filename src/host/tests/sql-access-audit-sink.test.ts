import test from 'node:test'
import assert from 'node:assert/strict'
import { AuditEvent, AuditEventKind, Action, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { IAuditSink } from '@pragmatic-tech-ai/todl-identity'
import { AuditSurface, AuditOutcome } from '../access-audit.js'
import { SqlAuditAccessSink } from '../sql-access-audit-sink.js'
import type { ILogger, LogFields } from '../../observability/logger.js'

class CapturingStore implements IAuditSink
{
    public readonly Events: AuditEvent[] = []
    public Record(event: AuditEvent): Promise<void> { this.Events.push(event); return Promise.resolve() }
}

class CapturingLogger implements ILogger
{
    public readonly Errors: Array<{ message: string; fields?: LogFields }> = []
    public Info(): void {}
    public Warn(): void {}
    public Error(message: string, fields?: LogFields): void { this.Errors.push({ message, fields }) }
    public Child(): ILogger { return this }
}

class RejectingStore implements IAuditSink
{
    public Record(): Promise<void> { return Promise.reject(new Error('db rejected')) }
}

class ThrowingStore implements IAuditSink
{
    public Record(): Promise<void> { throw new Error('db down') }
}

test('bridges a policy decision to an AccessDecision AuditEvent with a secret-free Detail map', async () =>
{
    const store = new CapturingStore()
    await new SqlAuditAccessSink(store).Record({
        Timestamp: new Date('2026-01-01T00:00:00.000Z'),
        TenantId: 't1',
        PrincipalId: 'p1',
        Surface: AuditSurface.Rpc,
        MethodOrPath: 'solution/open',
        Action: Action.Administer,
        ResourceKind: ResourceKind.Tenant,
        Outcome: AuditOutcome.Deny,
        Reason: 'insufficient role',
        CorrelationId: 'trace-abc',
    })
    assert.equal(store.Events.length, 1)
    const event = store.Events[0]!
    assert.equal(event.Kind, AuditEventKind.AccessDecision)
    assert.equal(event.TenantId, 't1')
    assert.equal(event.PrincipalId, 'p1')
    assert.equal(event.Detail.get('surface'), 'rpc')
    assert.equal(event.Detail.get('method'), 'solution/open')
    assert.equal(event.Detail.get('outcome'), 'deny')
    assert.equal(event.Detail.get('action'), 'Administer')
    for (const key of event.Detail.keys())
    {
        assert.equal(/token|secret|password|credential|fingerprint/i.test(key), false, key)
    }
})

test('maps an http auth event to an Authentication AuditEvent with a null principal when absent', async () =>
{
    const store = new CapturingStore()
    await new SqlAuditAccessSink(store).Record({
        Timestamp: new Date(),
        TenantId: 't1',
        Surface: AuditSurface.Http,
        MethodOrPath: '/auth/login',
        Outcome: AuditOutcome.AuthFailure,
    })
    assert.equal(store.Events[0]!.Kind, AuditEventKind.Authentication)
    assert.equal(store.Events[0]!.PrincipalId, null)
})

test('maps optional fields into Detail when present and omits them when absent', async () =>
{
    const store = new CapturingStore()
    const sink = new SqlAuditAccessSink(store)
    await sink.Record({
        Timestamp: new Date(),
        TenantId: 't1',
        Surface: AuditSurface.Rpc,
        MethodOrPath: 'x',
        ResourcePath: 'my-solution',
        Outcome: AuditOutcome.Deny,
        Reason: 'insufficient-role',
        CorrelationId: 'trace-abc',
    })
    await sink.Record({ Timestamp: new Date(), TenantId: 't1', Surface: AuditSurface.Rpc, MethodOrPath: 'x', Outcome: AuditOutcome.Allow })
    const present = store.Events[0]!.Detail
    assert.equal(present.get('resourcePath'), 'my-solution')
    assert.equal(present.get('reason'), 'insufficient-role')
    assert.equal(present.get('correlationId'), 'trace-abc')
    const absent = store.Events[1]!.Detail
    for (const key of ['resourcePath', 'reason', 'correlationId', 'action', 'resourceKind'])
    {
        assert.equal(absent.has(key), false, key)
    }
})

test('a synchronously throwing store is swallowed and logged', async () =>
{
    const logger = new CapturingLogger()
    await new SqlAuditAccessSink(new ThrowingStore(), logger).Record({
        Timestamp: new Date(),
        TenantId: 't1',
        Surface: AuditSurface.Rpc,
        MethodOrPath: 'x',
        Outcome: AuditOutcome.Allow,
    })
    assert.equal(logger.Errors.length, 1)
    assert.equal(logger.Errors[0]!.fields?.surface, 'rpc')
})

test('a rejecting store is swallowed and logged', async () =>
{
    const logger = new CapturingLogger()
    await new SqlAuditAccessSink(new RejectingStore(), logger).Record({
        Timestamp: new Date(),
        TenantId: 't1',
        Surface: AuditSurface.Rpc,
        MethodOrPath: 'x',
        Outcome: AuditOutcome.Allow,
    })
    assert.equal(logger.Errors.length, 1)
})

// Holds every insert until Release(), as a slow database would.
class HeldStore implements IAuditSink
{
    public Written = 0
    private release: () => void = () => undefined
    private readonly gate = new Promise<void>(resolve => { this.release = resolve })

    public async Record(): Promise<void>
    {
        await this.gate
        this.Written++
    }

    public Release(): void
    {
        this.release()
    }
}

test('Drain resolves only after every fire-and-forget insert has finished (the last events survive a shutdown)', async () =>
{
    const store = new HeldStore()
    const sink = new SqlAuditAccessSink(store)
    const event = { Timestamp: new Date(), TenantId: 't1', Surface: AuditSurface.Rpc, MethodOrPath: 'x', Outcome: AuditOutcome.Allow }
    void sink.Record(event)
    void sink.Record(event)
    let drained = false
    const drain = sink.Drain().then(() => { drained = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(drained, false)
    store.Release()
    await drain
    assert.equal(store.Written, 2)
})

test('Drain with nothing in flight resolves at once, and a failed insert does not make it reject', async () =>
{
    await new SqlAuditAccessSink(new CapturingStore()).Drain()
    const sink = new SqlAuditAccessSink(new RejectingStore(), new CapturingLogger())
    void sink.Record({ Timestamp: new Date(), TenantId: 't1', Surface: AuditSurface.Rpc, MethodOrPath: 'x', Outcome: AuditOutcome.Allow })
    await sink.Drain()
})
