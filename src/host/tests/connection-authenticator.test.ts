import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { PrincipalKind, Realm, RealmKind, Principal, PresentedSecret, SystemPrincipal } from '@pragmatic-tech-ai/pragmatic-identity'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ServerIdentityPack } from '@pragmatic-tech-ai/pragmatic-identity-store'
import { ConnectionAuthenticator } from '../connection-authenticator.js'

class AuthenticatorFixture
{
    public static readonly OtherEnvironment = 'env-1'

    public static Realm1(): Realm
    {
        return new Realm('t1', RealmKind.SelfHosted, 'Environment One')
    }
}

test('resolves a valid service token to a Service principal context', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = AuthenticatorFixture.Realm1()
    const { Token } = await pack.Tokens.Issue(realm, 'svc1', [], null)
    const context = await new ConnectionAuthenticator().ResolveAsync(Token, realm, pack)
    assert.equal(context?.Principal.Id, 'svc1')
    assert.equal(context?.Principal.Kind, PrincipalKind.Service)
})

test('resolves a valid session token to the account principal', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = AuthenticatorFixture.Realm1()
    await pack.Registrar.Register(realm, 'a@x.io', 'p1', new PresentedSecret('pw-123456'))
    const session = await pack.Sessions.Issue(new Principal('p1', 't1', PrincipalKind.User, new Map(), []))
    const context = await new ConnectionAuthenticator().ResolveAsync(session.Id, realm, pack)
    assert.equal(context?.Principal.Id, 'p1')
    assert.equal(context?.Principal.Kind, PrincipalKind.User)
})

test('returns null for unknown, empty and wrong-environment tokens', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = AuthenticatorFixture.Realm1()
    const other = new Realm('t2', RealmKind.SelfHosted, 'Other')
    const { Token } = await pack.Tokens.Issue(realm, 'svc1', [], null)
    const authenticator = new ConnectionAuthenticator()
    assert.equal(await authenticator.ResolveAsync('garbage', realm, pack), null)
    assert.equal(await authenticator.ResolveAsync('', realm, pack), null)
    assert.equal(await authenticator.ResolveAsync(Token, other, pack), null)
})

test('returns null for a valid session presented under the wrong environment', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = AuthenticatorFixture.Realm1()
    const other = new Realm('t2', RealmKind.SelfHosted, 'Other')
    await pack.Registrar.Register(realm, 'a@x.io', 'p1', new PresentedSecret('pw-123456'))
    const session = await pack.Sessions.Issue(new Principal('p1', 't1', PrincipalKind.User, new Map(), []))
    assert.equal(await new ConnectionAuthenticator().ResolveAsync(session.Id, other, pack), null)
})

test('IdP principal cannot claim the system id', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = AuthenticatorFixture.Realm1()
    const authenticator = new ConnectionAuthenticator()
    for (const id of [SystemPrincipal.IdFor(realm.Id), SystemPrincipal.IdFor(AuthenticatorFixture.OtherEnvironment)])
    {
        const { Token } = await pack.Tokens.Issue(realm, id, [], null)
        assert.equal(await authenticator.ResolveAsync(Token, realm, pack), null, id + ' is refused like an unknown credential')
    }
})
