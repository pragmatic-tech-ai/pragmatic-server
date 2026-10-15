import { randomBytes } from 'node:crypto'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, IdentityConfig, PrivilegeAction, AccessLevel, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import type { PragmaticServer } from '../../../pragmatic-server.js'

export class PpSecurityHarness
{
    public static readonly KeyEnv = 'PS_SP3B_KEY'
    public static readonly TenantId = 't1'
    public static readonly Concept = 'Widget'
    public static readonly OwningBuField = 'owningBu'
    public static readonly SalesBu = 'sales'
    public static readonly RootBu = 'root'
    private static readonly TenantName = 'Tenant One'
    private static readonly RootName = 'Root'
    private static readonly SalesName = 'Sales'
    private static readonly ReaderId = 'reader'
    private static readonly ReaderName = 'Reader'
    private static readonly NotSeededError = 'tenant config was not seeded on boot'

    public static SetKey(): void
    {
        process.env[PpSecurityHarness.KeyEnv] = randomBytes(32).toString('base64')
    }

    public static ClearKey(): void
    {
        delete process.env[PpSecurityHarness.KeyEnv]
    }

    public static Identity(identityRoot: string)
    {
        return {
            identityRoot,
            masterKey: { base64Env: PpSecurityHarness.KeyEnv },
            tenant: { id: PpSecurityHarness.TenantId, displayName: PpSecurityHarness.TenantName },
        }
    }

    public static Context(principalId: string): AccessContext
    {
        const tenant = new Tenant(PpSecurityHarness.TenantId, TenantKind.SelfHosted, PpSecurityHarness.TenantName)
        const principal = new Principal(principalId, PpSecurityHarness.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(principalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, PpSecurityHarness.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** The principal lives in BU `sales`; role `reader` grants Read at BusinessUnit level on Widget; ownership from field `owningBu`. */
    public static BuSecurityModel(principalId: string): ISecurityModelConfig
    {
        return PpSecurityHarness.ModelAt(principalId, AccessLevel.BusinessUnit)
    }

    /** Org-level grant = allow-all on the depth axis (for compose tests isolating the predicate axis). */
    public static OrgSecurityModel(principalId: string): ISecurityModelConfig
    {
        return PpSecurityHarness.ModelAt(principalId, AccessLevel.Organization)
    }

    public static async Seed(server: PragmaticServer, model: ISecurityModelConfig): Promise<void>
    {
        const store = await server.TenantConfigStore()
        const seeded = await store.Get(PpSecurityHarness.TenantId)
        if (seeded === null)
        {
            throw new Error(PpSecurityHarness.NotSeededError)
        }
        const merged = new IdentityConfig(seeded.PackId, seeded.DelegationDepth, seeded.ProviderSettings, seeded.GroupRoleMap, seeded.ClaimsMapping, model)
        await store.Save(PpSecurityHarness.TenantId, merged)
    }

    private static ModelAt(principalId: string, level: AccessLevel): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: PpSecurityHarness.RootBu, name: PpSecurityHarness.RootName }, { id: PpSecurityHarness.SalesBu, name: PpSecurityHarness.SalesName, parent: PpSecurityHarness.RootBu }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] }] },
            ownershipRules: [{ concept: PpSecurityHarness.Concept, owningBusinessUnit: { kind: OwnershipSourceKind.FromField, value: PpSecurityHarness.OwningBuField } }],
            roles: [{ id: PpSecurityHarness.ReaderId, name: PpSecurityHarness.ReaderName, privileges: [{ action: PrivilegeAction.Read, concept: PpSecurityHarness.Concept, level }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId, roles: [PpSecurityHarness.ReaderId] }], teamRoles: [] },
        }
    }
}
