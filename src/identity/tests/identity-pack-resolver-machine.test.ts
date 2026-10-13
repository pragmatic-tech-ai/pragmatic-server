import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { X509Certificate, createHash } from 'node:crypto'
import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret, PrincipalKind, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import { FakeOidcHttpClient, FakeOidcIdp, InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'
import { MachinePrincipalMap } from '../../host/machine-principal-map.js'
import { IdentityPackResolver } from '../identity-pack-resolver.js'
import { ResolverFixture } from './resolver-fixture.js'

class MachineHarness
{
    public static readonly CertPath = 'src/tests/fixtures/tls/machine-client.pem'
    public static readonly PrincipalId = 'svc-1'
    private static readonly LocalPackId = 'local'
    private static readonly EntraPackId = 'entra'
    private static readonly EntraIssuer = 'https://login.microsoftonline.com/test-tid/v2.0'
    private static readonly TenantId = 't-machine'
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

    public static Tenant(packId: string): Tenant
    {
        return new Tenant(MachineHarness.TenantId, TenantKind.SelfHosted, packId)
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

test('a Local tenant with a machine map authenticates a mapped fingerprint as a Machine principal', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const stores = await fixture.Stores()
        const tenant = MachineHarness.Tenant('local')
        const resolved = new IdentityPackResolver().Resolve(tenant, MachineHarness.LocalConfig(), stores, MachineHarness.Map())
        const auth = resolved.Pack.AuthenticatorFor(AuthMethod.Machine)
        assert.ok(auth !== undefined)
        const result = await auth.Authenticate(new Credential(AuthMethod.Machine, MachineHarness.Fingerprint()), new PresentedSecret(''), tenant)
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
        const resolved = new IdentityPackResolver().Resolve(MachineHarness.Tenant('local'), MachineHarness.LocalConfig(), stores)
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
        const resolved = new IdentityPackResolver().Resolve(MachineHarness.Tenant('local'), MachineHarness.LocalConfig(), stores, MachinePrincipalMap.Empty)
        assert.equal(resolved.Pack.AuthenticatorFor(AuthMethod.Machine), undefined)
    }
    finally
    {
        fixture.Dispose()
    }
})

test('an Entra tenant keeps the OIDC authenticator alongside the Machine one', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const stores = await fixture.Stores()
        const resolver = await MachineHarness.EntraResolver()
        const resolved = resolver.Resolve(MachineHarness.Tenant('entra'), MachineHarness.EntraConfig(fixture), stores, MachineHarness.Map())
        assert.ok(resolved.Pack.AuthenticatorFor(AuthMethod.Oidc) !== undefined)
        assert.ok(resolved.Pack.AuthenticatorFor(AuthMethod.Machine) !== undefined)
        assert.ok(resolved.Oidc !== undefined)
    }
    finally
    {
        fixture.Dispose()
    }
})
