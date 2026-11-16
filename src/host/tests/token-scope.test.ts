import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { PrincipalKind, Realm, RealmKind, Principal, PresentedSecret } from '@pragmatic-tech-ai/todl-identity'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { ApplicationDeployProtocol, GraphProtocol, PragmaticAppProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { TokenScope, TokenScopeGate, ScopedAccessContext } from '../token-scope.js'
import { ConnectionAuthenticator } from '../connection-authenticator.js'

class ScopeFixture
{
    public static readonly Custom = 'custom'
    public static readonly EnvironmentId = 't1'
    public static readonly EnvironmentName = 'Environment One'
    public static readonly ServiceId = 'svc1'
    public static readonly Email = 'a@x.io'
    public static readonly Password = 'pw-123456'
    public static readonly UserId = 'p1'

    public static Realm1(): Realm
    {
        return new Realm(ScopeFixture.EnvironmentId, RealmKind.SelfHosted, ScopeFixture.EnvironmentName)
    }
}

test('the deploy scope allows only application/deploy', () =>
{
    const gate = TokenScopeGate.For([TokenScope.ApplicationDeploy])
    assert.equal(gate.Allows(ApplicationDeployProtocol.Deploy.method), true)
    assert.equal(gate.Allows(GraphProtocol.Create.method), false)
})

test('the contribute scope allows graph/contribute and graph/list only', () =>
{
    const gate = TokenScopeGate.For([TokenScope.GraphContribute])
    assert.equal(gate.Allows(GraphProtocol.Contribute.method), true)
    assert.equal(gate.Allows(GraphProtocol.List.method), true)
    assert.equal(gate.Allows(ApplicationDeployProtocol.Deploy.method), false)
    assert.equal(gate.Allows(GraphProtocol.Delete.method), false)
})

test('the inspect scope allows only the three read methods', () =>
{
    const gate = TokenScopeGate.For([TokenScope.Inspect])
    assert.equal(TokenScope.Inspect, 'environment-inspect')
    assert.equal(gate.Allows(PragmaticAppProtocol.List.method), true)
    assert.equal(gate.Allows(GraphProtocol.List.method), true)
    assert.equal(gate.Allows(GraphProtocol.Loaded.method), true)
    assert.equal(gate.Allows(ApplicationDeployProtocol.Deploy.method), false)
    assert.equal(gate.Allows(GraphProtocol.Contribute.method), false)
})

test('known scopes combine as a union', () =>
{
    const gate = TokenScopeGate.For([TokenScope.GraphContribute, TokenScope.ApplicationDeploy])
    assert.equal(gate.Allows(GraphProtocol.Contribute.method), true)
    assert.equal(gate.Allows(ApplicationDeployProtocol.Deploy.method), true)
    assert.equal(gate.Allows(GraphProtocol.Create.method), false)
})

test('no known scope allows everything', () =>
{
    assert.equal(TokenScopeGate.For([]).Allows(GraphProtocol.Create.method), true)
    assert.equal(TokenScopeGate.For([ScopeFixture.Custom]).Allows(GraphProtocol.Create.method), true)
})

test('a service-token context carries its scopes; a session context is unscoped even with matching groups', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const realm = ScopeFixture.Realm1()
    const { Token } = await pack.Tokens.Issue(realm, ScopeFixture.ServiceId, [TokenScope.GraphContribute], null)
    const serviceContext = await new ConnectionAuthenticator().ResolveAsync(Token, realm, pack)
    assert.ok(serviceContext instanceof ScopedAccessContext)
    assert.equal(TokenScopeGate.ForContext(serviceContext).Allows(GraphProtocol.Delete.method), false)
    assert.equal(TokenScopeGate.ForContext(serviceContext).Allows(GraphProtocol.Contribute.method), true)

    await pack.Registrar.Register(realm, ScopeFixture.Email, ScopeFixture.UserId, new PresentedSecret(ScopeFixture.Password))
    const session = await pack.Sessions.Issue(new Principal(ScopeFixture.UserId, ScopeFixture.EnvironmentId, PrincipalKind.User, new Map(), [TokenScope.ApplicationDeploy]))
    const sessionContext = await new ConnectionAuthenticator().ResolveAsync(session.Id, realm, pack)
    assert.ok(sessionContext !== null && !(sessionContext instanceof ScopedAccessContext))
    assert.equal(TokenScopeGate.ForContext(sessionContext).Allows(GraphProtocol.Delete.method), true)
})
