import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Action, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { AuditSurface, AuditOutcome, NullAccessAuditSink } from '../access-audit.js'
import type { AccessAuditEvent } from '../access-audit.js'

const SecretKeyShape = /token|secret|password|credential|fingerprint|verifier|session/i

const ExpectedFieldNames: readonly string[] = [
    'Timestamp',
    'TenantId',
    'PrincipalId',
    'Surface',
    'MethodOrPath',
    'Action',
    'ResourceKind',
    'ResourcePath',
    'Outcome',
    'Reason',
    'CorrelationId',
]

test('a fully-populated event has exactly the expected field set, none secret-shaped', () =>
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
        Reason: 'insufficient-role',
        CorrelationId: 'abc123',
    }
    const keys = Object.keys(event)
    assert.deepEqual([...keys].sort(), [...ExpectedFieldNames].sort())
    for (const key of keys)
    {
        assert.equal(SecretKeyShape.test(key), false, key)
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

test('NullAccessAuditSink.Record resolves to undefined', async () =>
{
    const sink = new NullAccessAuditSink()
    const event: AccessAuditEvent = {
        Timestamp: new Date(),
        TenantId: 't1',
        Surface: AuditSurface.Upgrade,
        MethodOrPath: 'ws',
        Outcome: AuditOutcome.Allow,
    }
    assert.equal(await sink.Record(event), undefined)
})
