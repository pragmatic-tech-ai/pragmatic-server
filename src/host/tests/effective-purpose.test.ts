import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, ResourceAuthorizationPolicy, ScopedAccessContext, TokenScope } from '@pragmatic-tech-ai/pragmatic-identity'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import { InMemoryEnvironmentCoordinator } from '../../environments/environment-coordinator.js'
import { InMemoryEnvironmentProvisioning, EnvironmentRegistry } from '../../environments/environment-registry.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { EffectivePurposeResolver } from '../effective-purpose-resolver.js'

class PurposeRoutingFixture
{
    private static readonly KeyEnv = 'PS_C1_KEY'
    private static readonly BaseDir = 'base'
    private static readonly EnvironmentId = 't1'
    private static readonly Display = 'T'

    public static Server(provisioning: { purpose?: EnvironmentPurpose, runtimeCoHosted?: boolean }): PragmaticServer
    {
        const registry = new EnvironmentRegistry(PurposeRoutingFixture.BaseDir, { base64Env: PurposeRoutingFixture.KeyEnv }, new InMemoryEnvironmentProvisioning(new Map()), new InMemoryEnvironmentCoordinator())
        return new PragmaticServer(registry.OptionsFor(PurposeRoutingFixture.EnvironmentId, { displayName: PurposeRoutingFixture.Display, ...provisioning }))
    }

    public static Dual(): PragmaticServer
    {
        return PurposeRoutingFixture.Server({ purpose: EnvironmentPurpose.Development, runtimeCoHosted: true })
    }

    public static Context(scopes: readonly string[] | null): AccessContext
    {
        const realm = new Realm(PurposeRoutingFixture.EnvironmentId, RealmKind.SelfHosted, PurposeRoutingFixture.Display)
        const principal = new Principal('p1', PurposeRoutingFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const base = new AccessContext(principal, realm, [], new ResourceAuthorizationPolicy())
        return scopes === null ? base : new ScopedAccessContext(base, scopes)
    }

    /** The shared `cypher/query` engine a connection reaches, composed exactly as the hosts compose it. */
    public static Reached(server: PragmaticServer, purpose: EnvironmentPurpose): unknown
    {
        const runtime = ServerConnectionHandler.RuntimeAttachArgs(server, purpose)
        const development = ServerConnectionHandler.DevelopmentAttachArgs(server, purpose)
        return runtime.cypherQuery ?? development.cypherQuery
    }
}

test('Develop-scoped context on a dual server resolves Development and reaches the dev engine only', () =>
{
    const server = PurposeRoutingFixture.Dual()
    const purpose = EffectivePurposeResolver.Resolve(PurposeRoutingFixture.Context([TokenScope.Develop]), false, server)
    assert.equal(purpose, EnvironmentPurpose.Development)
    assert.equal(ServerConnectionHandler.RuntimeAttachArgs(server, purpose).cypherQuery, undefined)
    assert.equal(ServerConnectionHandler.RuntimeAttachArgs(server, purpose).applications, undefined)
    assert.ok(ServerConnectionHandler.DevelopmentAttachArgs(server, purpose).devGraphService !== undefined)
    assert.equal(PurposeRoutingFixture.Reached(server, purpose), server.DevCypher())
})

test('RunTest-scoped context on a dual server resolves Runtime and reaches the environment engine only', () =>
{
    const server = PurposeRoutingFixture.Dual()
    const purpose = EffectivePurposeResolver.Resolve(PurposeRoutingFixture.Context([TokenScope.RunTest]), false, server)
    assert.equal(purpose, EnvironmentPurpose.Runtime)
    const development = ServerConnectionHandler.DevelopmentAttachArgs(server, purpose)
    assert.equal(development.cypherQuery, undefined)
    assert.equal(development.devGraphService, undefined)
    assert.equal(PurposeRoutingFixture.Reached(server, purpose), server.EnvironmentCypher())
})

test('a cookie session on a dual server resolves Runtime', () =>
{
    const server = PurposeRoutingFixture.Dual()
    const purpose = EffectivePurposeResolver.Resolve(PurposeRoutingFixture.Context(null), true, server)
    assert.equal(purpose, EnvironmentPurpose.Runtime)
    assert.equal(PurposeRoutingFixture.Reached(server, purpose), server.EnvironmentCypher())
})

test('RunTest wins over Develop when both scopes are present', () =>
{
    const server = PurposeRoutingFixture.Dual()
    assert.equal(EffectivePurposeResolver.Resolve(PurposeRoutingFixture.Context([TokenScope.Develop, TokenScope.RunTest]), false, server), EnvironmentPurpose.Runtime)
})

test('an unscoped session falls back to the server purpose', () =>
{
    assert.equal(EffectivePurposeResolver.Resolve(PurposeRoutingFixture.Context(null), false, PurposeRoutingFixture.Dual()), EnvironmentPurpose.Development)
    assert.equal(EffectivePurposeResolver.Resolve(PurposeRoutingFixture.Context(null), false, PurposeRoutingFixture.Server({ purpose: EnvironmentPurpose.Runtime })), EnvironmentPurpose.Runtime)
})

test('on a pure dev server a RunTest-scoped context still gets no runtime args', () =>
{
    const server = PurposeRoutingFixture.Server({ purpose: EnvironmentPurpose.Development })
    const purpose = EffectivePurposeResolver.Resolve(PurposeRoutingFixture.Context([TokenScope.RunTest]), false, server)
    assert.equal(purpose, EnvironmentPurpose.Runtime)
    const runtime = ServerConnectionHandler.RuntimeAttachArgs(server, purpose)
    assert.equal(runtime.cypherQuery, undefined)
    assert.equal(runtime.applications, undefined)
    assert.equal(runtime.dataChanges, undefined)
})

test('a develop connection never reaches the runtime stack on a pure runtime server', () =>
{
    const server = PurposeRoutingFixture.Server({ purpose: EnvironmentPurpose.Runtime })
    const development = ServerConnectionHandler.DevelopmentAttachArgs(server, EnvironmentPurpose.Development)
    assert.equal(development.cypherQuery, undefined)
    assert.equal(development.devGraphService, undefined)
})
