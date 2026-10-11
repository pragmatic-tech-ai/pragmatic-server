import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { PrincipalKind, Tenant, TenantKind, Principal, PresentedSecret } from '@pragmatic-tech-ai/todl-identity'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { ConnectionAuthenticator } from '../connection-authenticator.js'

class AuthenticatorFixture
{
    public static Tenant1(): Tenant
    {
        return new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
    }
}

test('resolves a valid service token to a Service principal context', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const tenant = AuthenticatorFixture.Tenant1()
    const { Token } = await pack.Tokens.Issue(tenant, 'svc1', [], null)
    const context = await new ConnectionAuthenticator().ResolveAsync(Token, tenant, pack)
    assert.equal(context?.Principal.Id, 'svc1')
    assert.equal(context?.Principal.Kind, PrincipalKind.Service)
})

test('resolves a valid session token to the account principal', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const tenant = AuthenticatorFixture.Tenant1()
    await pack.Registrar.Register(tenant, 'a@x.io', 'p1', new PresentedSecret('pw-123456'))
    const session = await pack.Sessions.Issue(new Principal('p1', 't1', PrincipalKind.User, new Map(), []))
    const context = await new ConnectionAuthenticator().ResolveAsync(session.Id, tenant, pack)
    assert.equal(context?.Principal.Id, 'p1')
    assert.equal(context?.Principal.Kind, PrincipalKind.User)
})

test('returns null for unknown, empty and wrong-tenant tokens', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const tenant = AuthenticatorFixture.Tenant1()
    const other = new Tenant('t2', TenantKind.SelfHosted, 'Other')
    const { Token } = await pack.Tokens.Issue(tenant, 'svc1', [], null)
    const authenticator = new ConnectionAuthenticator()
    assert.equal(await authenticator.ResolveAsync('garbage', tenant, pack), null)
    assert.equal(await authenticator.ResolveAsync('', tenant, pack), null)
    assert.equal(await authenticator.ResolveAsync(Token, other, pack), null)
})

test('returns null for a valid session presented under the wrong tenant', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const tenant = AuthenticatorFixture.Tenant1()
    const other = new Tenant('t2', TenantKind.SelfHosted, 'Other')
    await pack.Registrar.Register(tenant, 'a@x.io', 'p1', new PresentedSecret('pw-123456'))
    const session = await pack.Sessions.Issue(new Principal('p1', 't1', PrincipalKind.User, new Map(), []))
    assert.equal(await new ConnectionAuthenticator().ResolveAsync(session.Id, other, pack), null)
})
