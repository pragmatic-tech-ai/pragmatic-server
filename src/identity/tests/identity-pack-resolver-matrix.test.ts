import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Action, AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, Principal, PrincipalKind, PresentedSecret, ResourceKind, ResourceRef, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import { ClaimsAccessPolicy } from '@pragmatic-tech-ai/todl-identity-cloud'
import { IdentityPackResolver } from '../identity-pack-resolver.js'
import { ResolverFixture } from './resolver-fixture.js'

const EntraIssuer = 'https://login.microsoftonline.com/test-tid/v2.0'

class MatrixHarness
{
    public static async Authenticate(fixture: ResolverFixture, depth: DelegationDepth, groupRoleMap: ReadonlyMap<string, Role>)
    {
        const flow = await fixture.Flow('entra', EntraIssuer, fixture.EntraSettings(), depth, groupRoleMap, 'groups')
        const oidc = flow.resolved.pack.AuthenticatorFor(AuthMethod.Oidc)!
        const result = await oidc.Authenticate(new Credential(AuthMethod.Oidc, flow.State), new PresentedSecret(ResolverFixture.AuthCode), flow.tenant)
        assert.ok(result instanceof AuthenticatedResult)
        return { flow, principal: (result as AuthenticatedResult).Principal }
    }
}

test('AuthnDirectory ignores token groups; composite policy is resource RBAC', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const { flow, principal } = await MatrixHarness.Authenticate(fixture, DelegationDepth.AuthnDirectory, new Map())
        assert.deepEqual([...principal.Groups], [])
        assert.equal((await flow.resolved.pack.Grants.GrantsFor(ResolverFixture.Subject, flow.tenant)).length, 0)
        assert.equal(flow.resolved.pack.Policy?.constructor.name, 'ResourceAuthorizationPolicy')
    }
    finally { fixture.Dispose() }
})

test('ExternalGrants maps token groups to stored grants; policy is resource RBAC', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const { flow, principal } = await MatrixHarness.Authenticate(fixture, DelegationDepth.ExternalGrants, new Map([[ResolverFixture.Group, Role.Editor]]))
        assert.deepEqual([...principal.Groups], [ResolverFixture.Group])
        assert.ok((await flow.resolved.pack.Grants.GrantsFor(ResolverFixture.Subject, flow.tenant)).some(g => g.Role === Role.Editor))
        assert.equal(flow.resolved.pack.Policy?.constructor.name, 'ResourceAuthorizationPolicy')
    }
    finally { fixture.Dispose() }
})

test('FullAuthz exposes the cloud ClaimsAccessPolicy that decides by group role', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const { flow } = await MatrixHarness.Authenticate(fixture, DelegationDepth.FullAuthz, new Map([[ResolverFixture.Group, Role.Admin]]))
        const policy = flow.resolved.pack.Policy
        assert.ok(policy instanceof ClaimsAccessPolicy)
        const resource = new ResourceRef(ResourceKind.Model, flow.tenant.Id, [])
        const admin = new AccessContext(new Principal(ResolverFixture.Subject, flow.tenant.Id, PrincipalKind.User, new Map(), [ResolverFixture.Group]), flow.tenant, [], policy)
        assert.equal(policy.Decide(admin, Action.Write, resource).Allowed, true)
        const nobody = new AccessContext(new Principal(ResolverFixture.Subject, flow.tenant.Id, PrincipalKind.User, new Map(), []), flow.tenant, [], policy)
        assert.equal(policy.Decide(nobody, Action.Read, resource).Allowed, false)
    }
    finally { fixture.Dispose() }
})

test('Google config resolves and authenticates through its own issuer', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const flow = await fixture.Flow('google', ResolverFixture.GoogleIssuer, fixture.GoogleSettings(), DelegationDepth.AuthnDirectory, new Map(), 'groups')
        const oidc = flow.resolved.pack.AuthenticatorFor(AuthMethod.Oidc)!
        const result = await oidc.Authenticate(new Credential(AuthMethod.Oidc, flow.State), new PresentedSecret(ResolverFixture.AuthCode), flow.tenant)
        assert.ok(result instanceof AuthenticatedResult)
        assert.equal((result as AuthenticatedResult).Principal.Id, ResolverFixture.Subject)
    }
    finally { fixture.Dispose() }
})

test('a local pack id resolves no OIDC authenticator and no begin handle', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const stores = await fixture.Stores()
        const tenant = new Tenant('t-local', TenantKind.SelfHosted, 'local')
        const config = new IdentityConfig('local', DelegationDepth.FullAuthz, new Map(), new Map(), new Map())
        const resolved = new IdentityPackResolver().Resolve(tenant, config, stores)
        assert.equal(resolved.oidc, undefined)
        assert.equal(resolved.pack.AuthenticatorFor(AuthMethod.Oidc), undefined)
        assert.ok(resolved.pack.AuthenticatorFor(AuthMethod.Local))
    }
    finally { fixture.Dispose() }
})

test('an Entra config without aadTenantId fails closed at resolve', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const stores = await fixture.Stores()
        const tenant = new Tenant('t-bad', TenantKind.Saas, 'bad')
        const settings = new Map([['clientId', ResolverFixture.ClientId], ['redirectUri', ResolverFixture.RedirectUri]])
        const config = new IdentityConfig('entra', DelegationDepth.AuthnDirectory, settings, new Map(), new Map())
        assert.throws(() => new IdentityPackResolver().Resolve(tenant, config, stores), /OIDC provider setting is required: aadTenantId/)
    }
    finally { fixture.Dispose() }
})

test('tenant isolation: one tenant Entra state cannot be completed under another tenant pack', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const a = await fixture.Flow('entra', EntraIssuer, fixture.EntraSettings(), DelegationDepth.AuthnDirectory, new Map(), 'groups')
        const b = await fixture.Flow('google', ResolverFixture.GoogleIssuer, fixture.GoogleSettings(), DelegationDepth.AuthnDirectory, new Map(), 'groups')
        // b's OIDC authenticator has its own flow-state store; a's state is unknown to it -> rejected.
        const result = await b.resolved.pack.AuthenticatorFor(AuthMethod.Oidc)!.Authenticate(new Credential(AuthMethod.Oidc, a.State), new PresentedSecret(ResolverFixture.AuthCode), b.tenant)
        assert.ok(!(result instanceof AuthenticatedResult))
    }
    finally { fixture.Dispose() }
})
