import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ServerIdentityPack } from '@pragmatic-tech-ai/pragmatic-identity-store'
import { ConnectionAuthenticator } from '../connection-authenticator.js'
import { AuditSurface, AuditOutcome, type IAccessAuditSink, type AccessAuditEvent } from '@pragmatic-tech-ai/pragmatic-env-cluster'

class CapturingSink implements IAccessAuditSink
{
    public Drain(): Promise<void> { return Promise.resolve() }
    public readonly Events: AccessAuditEvent[] = []

    public Record(event: AccessAuditEvent): Promise<void>
    {
        this.Events.push(event)
        return Promise.resolve()
    }
}

class RejectingSink implements IAccessAuditSink
{
    public Drain(): Promise<void> { return Promise.resolve() }
    public Record(): Promise<void>
    {
        return Promise.reject(new Error('sink rejected'))
    }
}

class ThrowingSink implements IAccessAuditSink
{
    public Drain(): Promise<void> { return Promise.resolve() }
    public Record(): Promise<void>
    {
        throw new Error('sink down')
    }
}

test('a resolved token emits an Upgrade Allow event carrying the principal id', async () =>
{
    const sink = new CapturingSink()
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = new Realm('t1', RealmKind.SelfHosted, 'Environment One')
    const { Token } = await pack.Tokens.Issue(realm, 'svc1', [], null)
    const context = await new ConnectionAuthenticator(undefined, sink).ResolveAsync(Token, realm, pack)
    assert.equal(context?.Principal.Id, 'svc1')
    assert.equal(sink.Events.length, 1)
    assert.equal(sink.Events[0]!.Surface, AuditSurface.Upgrade)
    assert.equal(sink.Events[0]!.Outcome, AuditOutcome.Allow)
    assert.equal(sink.Events[0]!.PrincipalId, 'svc1')
    assert.equal(sink.Events[0]!.EnvironmentId, 't1')
})

test('an unresolved token emits an Upgrade AuthFailure event without a principal', async () =>
{
    const sink = new CapturingSink()
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = new Realm('t1', RealmKind.SelfHosted, 'Environment One')
    assert.equal(await new ConnectionAuthenticator(undefined, sink).ResolveAsync('garbage', realm, pack), null)
    assert.equal(sink.Events.length, 1)
    assert.equal(sink.Events[0]!.Outcome, AuditOutcome.AuthFailure)
    assert.equal(sink.Events[0]!.PrincipalId, undefined)
})

test('a throwing sink does not change the auth result', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = new Realm('t1', RealmKind.SelfHosted, 'Environment One')
    assert.equal(await new ConnectionAuthenticator(undefined, new ThrowingSink()).ResolveAsync('garbage', realm, pack), null)
})

test('a rejecting sink does not change the auth result and raises no unhandled rejection', async () =>
{
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', listener)
    try
    {
        const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
        const realm = new Realm('t1', RealmKind.SelfHosted, 'Environment One')
        const { Token } = await pack.Tokens.Issue(realm, 'svc1', [], null)
        const authenticator = new ConnectionAuthenticator(undefined, new RejectingSink())
        assert.equal((await authenticator.ResolveAsync(Token, realm, pack))?.Principal.Id, 'svc1')
        assert.equal(await authenticator.ResolveAsync('garbage', realm, pack), null)
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(unhandled.length, 0)
    }
    finally
    {
        process.off('unhandledRejection', listener)
    }
})

test('a throwing sink on the success path leaves the returned context unchanged', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = new Realm('t1', RealmKind.SelfHosted, 'Environment One')
    const { Token } = await pack.Tokens.Issue(realm, 'svc1', [], null)
    const context = await new ConnectionAuthenticator(undefined, new ThrowingSink()).ResolveAsync(Token, realm, pack)
    assert.equal(context?.Principal.Id, 'svc1')
})
