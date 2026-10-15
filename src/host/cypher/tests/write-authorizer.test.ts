import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Principal, PrincipalKind, PrivilegeAction, AccessLevel } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { TenantReadAuthorization, AllowAllWriteAuthorizerSource } from '../read-filter-source.js'

class Fixture
{
    private static readonly TenantId = 't1'
    private static readonly OrderConcept = 'shop.Order'
    private static readonly RoleId = 'writer'
    private static readonly ClaimName = 'r'

    public static readonly Order = Fixture.OrderConcept
    public static readonly Other = 'shop.Other'

    // Role "writer" may Create shop.Order (level User); nothing else.
    public static Config(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: 'root', name: 'Root' }],
            teams: [],
            membership: { claimsMapping: [], overrides: [] },
            ownershipRules: [],
            roles: [{ id: Fixture.RoleId, name: 'Writer', privileges: [{ action: PrivilegeAction.Create, concept: Fixture.OrderConcept, level: AccessLevel.User }] }],
            roleAssignment:
            {
                claimsMapping: [{ claim: Fixture.ClaimName, value: Fixture.RoleId, roles: [Fixture.RoleId] }],
                overrides: [],
                teamRoles: [],
            },
        }
    }

    public static ConfigStore(): { Get(id: string): Promise<{ SecurityModel: ISecurityModelConfig }> }
    {
        return { Get: async () => ({ SecurityModel: Fixture.Config() }) }
    }

    public static Context(): unknown
    {
        const principal = new Principal('u1', Fixture.TenantId, PrincipalKind.User, new Map([[Fixture.ClaimName, Fixture.RoleId]]), [])
        return { Tenant: { Id: Fixture.TenantId }, Principal: principal }
    }
}

test('tenant write authorizer allows a granted create and denies an ungranted delete', async () =>
{
    const auth = new TenantReadAuthorization(Fixture.ConfigStore() as never)
    const writer = await auth.WriteAuthorizerFor(Fixture.Context() as never)
    assert.equal(writer.Allows(Fixture.Order, PrivilegeAction.Create), true)
    assert.equal(writer.Allows(Fixture.Order, PrivilegeAction.Delete), false)
    assert.equal(writer.Allows(Fixture.Other, PrivilegeAction.Create), false)
})

test('allow-all write authorizer source allows everything', async () =>
{
    const writer = await AllowAllWriteAuthorizerSource.Instance.WriteAuthorizerFor()
    assert.equal(writer.Allows('any.Concept', PrivilegeAction.Delete), true)
})

// AccessDepthEvaluator is exercised indirectly; this guards the import graph.
test('AccessDepthEvaluator is importable', () =>
{
    assert.equal(typeof AccessDepthEvaluator.DenyAll, 'function')
})
