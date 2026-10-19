import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, IdentityConfig, DelegationDepth, PrivilegeAction, AccessLevel, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { InMemoryTenantConfigStore } from '@pragmatic-tech-ai/todl-identity-host'
import { TenantReadAuthorization } from '../read-filter-source.js'

class ReloadFixture
{
    public static readonly TenantId = 't1'
    public static readonly PrincipalId = 'p1'
    public static readonly Concept = 'acme.Customer'
    public static readonly PackId = 'local'
    public static readonly RootUnit = 'root'
    public static readonly UpdaterRole = 'updater'

    public static Context(): AccessContext
    {
        const tenant = new Tenant(ReloadFixture.TenantId, TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal(ReloadFixture.PrincipalId, ReloadFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(ReloadFixture.PrincipalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, ReloadFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** A config whose SecurityModel grants the principal Update at Organization level on the concept. */
    public static GrantingConfig(): IdentityConfig
    {
        const model: ISecurityModelConfig = {
            businessUnits: [{ id: ReloadFixture.RootUnit, name: 'Root' }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId: ReloadFixture.PrincipalId, homeBusinessUnit: ReloadFixture.RootUnit, teams: [] }] },
            ownershipRules: [{ concept: ReloadFixture.Concept, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: ReloadFixture.RootUnit } }],
            roles: [{ id: ReloadFixture.UpdaterRole, name: 'Updater', privileges: [{ action: PrivilegeAction.Update, concept: ReloadFixture.Concept, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: ReloadFixture.PrincipalId, roles: [ReloadFixture.UpdaterRole] }], teamRoles: [] },
        }
        return new IdentityConfig(ReloadFixture.PackId, DelegationDepth.FullAuthz, new Map(), new Map(), new Map(), model)
    }

    public static async Allows(authz: TenantReadAuthorization): Promise<boolean>
    {
        const writer = await authz.WriteAuthorizerFor(ReloadFixture.Context())
        return writer.Allows(ReloadFixture.Concept, PrivilegeAction.Update)
    }
}

test('a security-model change is live on the next request without restart', async () =>
{
    const store = new InMemoryTenantConfigStore()
    const authz = new TenantReadAuthorization(store)
    // No config yet: fail-closed, the write is denied and the evaluator is now cached.
    assert.equal(await ReloadFixture.Allows(authz), false)
    await store.Save(ReloadFixture.TenantId, ReloadFixture.GrantingConfig())
    // Still denied: the stale cached evaluator has not seen the new model.
    assert.equal(await ReloadFixture.Allows(authz), false)
    authz.Invalidate(ReloadFixture.TenantId)
    // Live reload: the SAME authorizer re-reads the store and now allows the write — no reconstruction.
    assert.equal(await ReloadFixture.Allows(authz), true)
})

test('Invalidate for one tenant does not drop another tenant\'s cached evaluator', async () =>
{
    const store = new InMemoryTenantConfigStore()
    await store.Save(ReloadFixture.TenantId, ReloadFixture.GrantingConfig())
    const authz = new TenantReadAuthorization(store)
    assert.equal(await ReloadFixture.Allows(authz), true)
    authz.Invalidate('other-tenant')
    assert.equal(await ReloadFixture.Allows(authz), true)
})
