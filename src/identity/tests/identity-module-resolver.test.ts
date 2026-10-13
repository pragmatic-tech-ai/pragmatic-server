import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret } from '@pragmatic-tech-ai/todl-identity'
import { FakeOidcHttpClient, FakeOidcIdp, InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'
import { PragmaticServer } from '../../pragmatic-server.js'
import type { PragmaticServerIdentityOptions } from '../../pragmatic-server.js'
import { MachinePrincipalMap } from '../../host/machine-principal-map.js'
import { ProvisionedSecretSource } from '../../config/provisioned-secret-source.js'
import { OidcSettingKeys } from '@pragmatic-tech-ai/todl-identity-cloud'
import { ResolverFixture } from './resolver-fixture.js'

class ModuleFixture
{
    public static readonly Issuer = 'https://idp.module.test'
    public static readonly GenericPackId = 'generic-oidc'
    public static readonly LocalPackId = 'local'
    private static readonly KeyEnv = 'PS_MODULE_RESOLVER_KEY'

    private readonly identityRoot = mkdtempSync(join(tmpdir(), 'ps-mr-id-'))
    private readonly packagesRoot = mkdtempSync(join(tmpdir(), 'ps-mr-pkg-'))

    public constructor()
    {
        process.env[ModuleFixture.KeyEnv] = randomBytes(32).toString('base64')
    }

    public Identity(extra: Partial<PragmaticServerIdentityOptions>): PragmaticServerIdentityOptions
    {
        return {
            identityRoot: this.identityRoot,
            masterKey: { base64Env: ModuleFixture.KeyEnv },
            tenant: { id: 't1', displayName: 'Tenant One' },
            ...extra,
        }
    }

    public Server(identity: PragmaticServerIdentityOptions): PragmaticServer
    {
        return new PragmaticServer({ packagesRoot: this.packagesRoot, identity })
    }

    public Dispose(): void
    {
        rmSync(this.identityRoot, { recursive: true, force: true })
        rmSync(this.packagesRoot, { recursive: true, force: true })
        delete process.env[ModuleFixture.KeyEnv]
    }
}

test('a generic-oidc identityConfig yields an OIDC front door that authenticates end to end', async () =>
{
    const fixture = new ModuleFixture()
    const idp = await FakeOidcIdp.Create(ModuleFixture.Issuer)
    const http = new FakeOidcHttpClient(idp)
    const flowStates = new InMemoryOidcFlowStateStore()
    const resolverFixture = new ResolverFixture()
    const config = new IdentityConfig(ModuleFixture.GenericPackId, DelegationDepth.AuthnDirectory, resolverFixture.GenericSettings(ModuleFixture.Issuer), new Map(), new Map())
    const server = fixture.Server(fixture.Identity({ identityConfig: config, httpClient: http, flowStateStore: flowStates }))
    try
    {
        await server.Start()
        const oidc = server.Oidc()
        assert.ok(oidc !== undefined)
        const begun = await oidc.BeginAuthorization(server.Tenant())
        const nonce = flowStates.Peek(begun.State)!.Nonce
        http.NextTokenResponse = {
            id_token: await idp.MintIdToken({ sub: ResolverFixture.Subject, aud: ResolverFixture.ClientId, nonce, email: ResolverFixture.Email, groups: [] }),
            token_type: ResolverFixture.BearerType,
        }
        const result = await oidc.AuthenticatorFor(AuthMethod.Oidc)!.Authenticate(new Credential(AuthMethod.Oidc, begun.State), new PresentedSecret(ResolverFixture.AuthCode), server.Tenant())
        assert.ok(result instanceof AuthenticatedResult)
        assert.equal(result.Principal.Id, ResolverFixture.Subject)
        const pack = await server.Pack()
        assert.ok(pack.AuthenticatorFor(AuthMethod.Local))
        assert.ok(pack.AuthenticatorFor(AuthMethod.Oidc))
    }
    finally
    {
        await server.Dispose()
        resolverFixture.Dispose()
        fixture.Dispose()
    }
})

test('a machine map adds the Machine authenticator to the server pack', async () =>
{
    const fixture = new ModuleFixture()
    const machine = new MachinePrincipalMap(new Map([['fp-1', { PrincipalId: 'svc-1', Groups: [] }]]))
    const server = fixture.Server(fixture.Identity({ machine }))
    try
    {
        await server.Start()
        const pack = await server.Pack()
        assert.ok(pack.AuthenticatorFor(AuthMethod.Machine))
        assert.ok(pack.AuthenticatorFor(AuthMethod.Local))
        assert.equal(server.Oidc(), undefined)
    }
    finally
    {
        await server.Dispose()
        fixture.Dispose()
    }
})

test('a tenant with no identityConfig and no oidc falls back to a local-only pack', async () =>
{
    const fixture = new ModuleFixture()
    const server = fixture.Server(fixture.Identity({}))
    try
    {
        await server.Start()
        const pack = await server.Pack()
        assert.ok(pack.AuthenticatorFor(AuthMethod.Local))
        assert.equal(pack.AuthenticatorFor(AuthMethod.Oidc), undefined)
        assert.equal(server.Oidc(), undefined)
    }
    finally
    {
        await server.Dispose()
        fixture.Dispose()
    }
})

test('legacy flat oidc options without an identityConfig still yield a working OIDC front door', async () =>
{
    const fixture = new ModuleFixture()
    const idp = await FakeOidcIdp.Create(ModuleFixture.Issuer)
    const http = new FakeOidcHttpClient(idp)
    const flowStates = new InMemoryOidcFlowStateStore()
    const oidc = {
        issuer: ModuleFixture.Issuer,
        clientId: ResolverFixture.ClientId,
        clientSecretRef: 't1/oidc/client-secret',
        discoveryUrl: ModuleFixture.Issuer + '/.well-known/openid-configuration',
        redirectUri: ResolverFixture.RedirectUri,
        provider: 'generic',
    }
    const server = fixture.Server(fixture.Identity({ oidc, httpClient: http, flowStateStore: flowStates }))
    try
    {
        await server.Start()
        const front = server.Oidc()
        assert.ok(front !== undefined)
        const begun = await front.BeginAuthorization(server.Tenant())
        const nonce = flowStates.Peek(begun.State)!.Nonce
        http.NextTokenResponse = {
            id_token: await idp.MintIdToken({ sub: ResolverFixture.Subject, aud: ResolverFixture.ClientId, nonce, email: ResolverFixture.Email, groups: [] }),
            token_type: ResolverFixture.BearerType,
        }
        const result = await front.AuthenticatorFor(AuthMethod.Oidc)!.Authenticate(new Credential(AuthMethod.Oidc, begun.State), new PresentedSecret(ResolverFixture.AuthCode), server.Tenant())
        assert.ok(result instanceof AuthenticatedResult)
        assert.equal(result.Principal.Id, ResolverFixture.Subject)
    }
    finally
    {
        await server.Dispose()
        fixture.Dispose()
    }
})

test('the OIDC secret ref in ProviderSettings is written through from the provisioned source', async () =>
{
    const fixture = new ModuleFixture()
    const resolverFixture = new ResolverFixture()
    const secretRef = 't1/oidc/client-secret'
    const settings = resolverFixture.GenericSettings(ModuleFixture.Issuer)
    settings.set(OidcSettingKeys.SecretRef, secretRef)
    const config = new IdentityConfig(ModuleFixture.GenericPackId, DelegationDepth.AuthnDirectory, settings, new Map(), new Map())
    const provisionedSecrets = ProvisionedSecretSource.FromText(JSON.stringify({ [secretRef]: 'oidc-secret-xyz' }))
    const server = fixture.Server(fixture.Identity({ identityConfig: config, provisionedSecrets }))
    try
    {
        await server.Start()
        const pack = await server.Pack()
        assert.equal(await pack.Secrets.Get(secretRef), 'oidc-secret-xyz')
    }
    finally
    {
        await server.Dispose()
        resolverFixture.Dispose()
        fixture.Dispose()
    }
})
