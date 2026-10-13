import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Action, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { AuditSurface, AuditOutcome, NullAccessAuditSink } from '../access-audit.js'
import type { AccessAuditEvent } from '../access-audit.js'

const KnownToken = 'sk-super-secret-bearer-0123456789'

test('a serialized event carries no secret substring and no secret-shaped key', () =>
{
    const event: AccessAuditEvent = {
        Timestamp: new Date('2026-01-01T00:00:00.000Z'),
        TenantId: 't1',
        PrincipalId: 'p1',
        Surface: AuditSurface.Rpc,
        MethodOrPath: 'solution/open',
        Action: Action.Administer,
        ResourceKind: ResourceKind.Tenant,
        ResourcePath: 'my-solution',
        Outcome: AuditOutcome.Deny,
        Reason: 'insufficient role',
        CorrelationId: 'abc123',
    }
    const serialized = JSON.stringify(event)
    assert.equal(serialized.includes(KnownToken), false)
    for (const key of Object.keys(event))
    {
        assert.equal(/token|secret|password|credential|fingerprint|verifier|session/i.test(key), false, key)
    }
})

test('an auth-failure event is valid without Action or ResourceKind', () =>
{
    const event: AccessAuditEvent = {
        Timestamp: new Date(),
        TenantId: 't1',
        Surface: AuditSurface.Http,
        MethodOrPath: '/auth/login',
        Outcome: AuditOutcome.AuthFailure,
    }
    assert.equal(event.Action, undefined)
    assert.equal(event.ResourceKind, undefined)
})

test('NullAccessAuditSink.Record resolves and records nothing observable', async () =>
{
    await new NullAccessAuditSink().Record({
        Timestamp: new Date(),
        TenantId: 't1',
        Surface: AuditSurface.Upgrade,
        MethodOrPath: 'ws',
        Outcome: AuditOutcome.Allow,
    })
    assert.ok(true)
})
