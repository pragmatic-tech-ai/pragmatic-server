import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import { OidcSettingKeys } from '@pragmatic-tech-ai/todl-identity-cloud'
import { IdentityPackResolver } from '../identity-pack-resolver.js'
import { ResolverFixture } from './resolver-fixture.js'

const GenericIssuer = 'https://idp.example.test'
const GroupsClaim = 'groups'
const GenericPackId = 'generic-oidc'

test('generic-oidc config resolves a pack that authenticates end to end at an explicit issuer', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const { resolved, tenant, State } = await fixture.Flow(GenericPackId, GenericIssuer, fixture.GenericSettings(GenericIssuer), DelegationDepth.AuthnDirectory, new Map([[ResolverFixture.Group, Role.Editor]]), GroupsClaim)
        const oidc = resolved.Pack.AuthenticatorFor(AuthMethod.Oidc)!
        const result = await oidc.Authenticate(new Credential(AuthMethod.Oidc, State), new PresentedSecret(ResolverFixture.AuthCode), tenant)
        assert.ok(result instanceof AuthenticatedResult)
        assert.equal((result as AuthenticatedResult).Principal.Id, ResolverFixture.Subject)
        assert.deepEqual([...(result as AuthenticatedResult).Principal.Groups], [], 'AuthnDirectory strips groups')
    }
    finally
    {
        fixture.Dispose()
    }
})

test('generic-oidc at ExternalGrants maps the groups claim via ClaimArrayGroupStrategy', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const { resolved, tenant, State } = await fixture.Flow(GenericPackId, GenericIssuer, fixture.GenericSettings(GenericIssuer), DelegationDepth.ExternalGrants, new Map([[ResolverFixture.Group, Role.Editor]]), GroupsClaim)
        const oidc = resolved.Pack.AuthenticatorFor(AuthMethod.Oidc)!
        const result = await oidc.Authenticate(new Credential(AuthMethod.Oidc, State), new PresentedSecret(ResolverFixture.AuthCode), tenant)
        assert.ok(result instanceof AuthenticatedResult)
        assert.deepEqual([...(result as AuthenticatedResult).Principal.Groups], [ResolverFixture.Group])
    }
    finally
    {
        fixture.Dispose()
    }
})

test('generic-oidc missing the discovery url fails closed at Resolve', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const settings = fixture.GenericSettings(GenericIssuer)
        settings.delete(OidcSettingKeys.DiscoveryUrl)
        const config = new IdentityConfig(GenericPackId, DelegationDepth.AuthnDirectory, settings, new Map(), new Map())
        const tenant = new Tenant('t-generic', TenantKind.Saas, GenericPackId)
        const stores = await fixture.Stores()
        assert.throws(() => new IdentityPackResolver().Resolve(tenant, config, stores), /OIDC provider setting is required/)
    }
    finally
    {
        fixture.Dispose()
    }
})
