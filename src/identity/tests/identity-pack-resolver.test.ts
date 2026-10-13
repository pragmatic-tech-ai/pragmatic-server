import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, PresentedSecret, Role } from '@pragmatic-tech-ai/todl-identity'
import { ResolverFixture } from './resolver-fixture.js'

const EntraIssuer = 'https://login.microsoftonline.com/test-tid/v2.0'
const GroupsClaim = 'groups'

test('Entra config resolves a composite pack that authenticates end to end (ExternalGrants)', async () =>
{
    const fixture = new ResolverFixture()
    try
    {
        const { resolved, tenant, State } = await fixture.Flow('entra', EntraIssuer, fixture.EntraSettings(), DelegationDepth.ExternalGrants, new Map([[ResolverFixture.Group, Role.Editor]]), GroupsClaim)
        assert.ok(resolved.pack.AuthenticatorFor(AuthMethod.Local), 'composite pack keeps local password auth')
        assert.ok(resolved.pack.AuthenticatorFor(AuthMethod.ServiceToken))
        const oidc = resolved.pack.AuthenticatorFor(AuthMethod.Oidc)!
        const result = await oidc.Authenticate(new Credential(AuthMethod.Oidc, State), new PresentedSecret(ResolverFixture.AuthCode), tenant)
        assert.ok(result instanceof AuthenticatedResult)
        const principal = (result as AuthenticatedResult).Principal
        assert.equal(principal.Id, ResolverFixture.Subject)
        assert.deepEqual([...principal.Groups], [ResolverFixture.Group])
        const grants = await resolved.pack.Grants.GrantsFor(ResolverFixture.Subject, tenant)
        assert.ok(grants.some(g => g.Role === Role.Editor))
        const session = await resolved.pack.Sessions.Issue(principal)
        assert.ok(await resolved.pack.Sessions.Validate(session.Id))
        assert.equal(resolved.pack.DelegationDepth, DelegationDepth.ExternalGrants)
    }
    finally
    {
        fixture.Dispose()
    }
})
