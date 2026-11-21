import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { X509Certificate, createHash } from 'node:crypto'
import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret, PrincipalKind, Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { MachinePrincipalMap } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { IdentityPackResolver } from '../identity-pack-resolver.js'
import { ResolverFixture } from './resolver-fixture.js'

class MachineHarness
{
    public static readonly CertPath = 'src/tests/fixtures/tls/machine-client.pem'
    public static readonly PrincipalId = 'svc-1'
    public static readonly LocalPackId = 'local'
    public static readonly EntraPackId = 'entra'
    private static readonly EntraIssuer = 'https://login.microsoftonline.com/test-tid/v2.0'
    private static readonly EnvironmentId = 't-machine'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HexEncoding = 'hex'
    private static readonly Group = 'robots'

    public static Fingerprint(): string
    {
        const der = new X509Certificate(readFileSync(MachineHarness.CertPath)).raw
        return createHash(MachineHarness.HashAlgorithm).update(der).digest(MachineHarness.HexEncoding)
    }

    public static Map(): MachinePrincipalMap
    {
        return new MachinePrincipalMap(new Map([[MachineHarness.Fingerprint(), { PrincipalId: MachineHarness.PrincipalId, Groups: [MachineHarness.Group] }]]))
    }

    public static Realm(packId: string): Realm
    {
        return new Realm(MachineHarness.EnvironmentId, RealmKind.SelfHosted, packId)
    }

    public static LocalConfig(): IdentityConfig
    {
        return new IdentityConfig(MachineHarness.LocalPackId, DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map())
    }

    public static async EntraResolver(): Promise<IdentityPackResolver>
    {
        const idp = await FakeOidcIdp.Create(MachineHarness.EntraIssuer)
        return new IdentityPackResolver(new FakeOidcHttpClient(idp), new InMemoryOidcFlowStateStore())
    }

    public static EntraConfig(fixture: ResolverFixture): IdentityConfig
    {
        return new IdentityConfig(MachineHarness.EntraPackId, DelegationDepth.AuthnDirectory, fixture.EntraSettings(), new Map(), new Map())
    }
}

test('a Local realm with a machine map authenticates a mapped fingerprint as a Machine principal', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const stores = await fixture.Stores()
        const realm = MachineHarness.Realm(MachineHarness.LocalPackId)
        const resolved = new IdentityPackResolver().Resolve(realm, MachineHarness.LocalConfig(), stores, MachineHarness.Map())
        const auth = resolved.Pack.AuthenticatorFor(AuthMethod.Machine)
        assert.ok(auth !== undefined)
        const result = await auth.Authenticate(new Credential(AuthMethod.Machine, MachineHarness.Fingerprint()), new PresentedSecret(''), realm)
        assert.ok(result instanceof AuthenticatedResult)
        assert.equal(result.Principal.Kind, PrincipalKind.Machine)
        assert.equal(result.Principal.Id, MachineHarness.PrincipalId)
    }
    finally
    {
        fixture.Dispose()
    }
})

test('resolving without a machine map leaves no Machine authenticator', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const stores = await fixture.Stores()
        const resolved = new IdentityPackResolver().Resolve(MachineHarness.Realm(MachineHarness.LocalPackId), MachineHarness.LocalConfig(), stores)
        assert.equal(resolved.Pack.AuthenticatorFor(AuthMethod.Machine), undefined)
    }
    finally
    {
        fixture.Dispose()
    }
})

test('an empty machine map adds no Machine authenticator', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const stores = await fixture.Stores()
        const resolved = new IdentityPackResolver().Resolve(MachineHarness.Realm(MachineHarness.LocalPackId), MachineHarness.LocalConfig(), stores, MachinePrincipalMap.Empty)
        assert.equal(resolved.Pack.AuthenticatorFor(AuthMethod.Machine), undefined)
    }
    finally
    {
        fixture.Dispose()
    }
})

test('an Entra realm keeps the OIDC authenticator alongside the Machine one', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const stores = await fixture.Stores()
        const resolver = await MachineHarness.EntraResolver()
        const resolved = resolver.Resolve(MachineHarness.Realm(MachineHarness.EntraPackId), MachineHarness.EntraConfig(fixture), stores, MachineHarness.Map())
        assert.ok(resolved.Pack.AuthenticatorFor(AuthMethod.Oidc) !== undefined)
        assert.ok(resolved.Pack.AuthenticatorFor(AuthMethod.Machine) !== undefined)
        assert.ok(resolved.Oidc !== undefined)
    }
    finally
    {
        fixture.Dispose()
    }
})
