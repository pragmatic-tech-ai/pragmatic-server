import { AccessScope, EdgeDirection } from '@pragmatic-tech-ai/graph'
import type { CellValue, INodeView } from '@pragmatic-tech-ai/graph'
import { SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ShareParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessLevel, OwnershipSourceKind, Principal, PrincipalKind, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import type { IGraphScope } from '../../engine/access-scope-source.js'
import { EnvironmentFixture } from './environment-fixture.js'

/**
 * A runtime tenant with identity delivering `crm` (crm.Account, engine-stored, owned through its `owner` field) through
 * `crm-app` and `ext` (ext.Customer bound over the fixture's MemorySourceAdapter, one row k1) through `ext-app`;
 * accounts r1 and r2 are owned by p1. Security: p1 holds Read / Update / Delete / Share / Assign on its own accounts
 * (User level); p2 and p3 hold Read and Update on their own only (no Share, no Assign); team t1 exists.
 */
export class ShareFx
{
    public static readonly App = 'crm-app'
    public static readonly ExtApp = 'ext-app'
    public static readonly AppVersion = '1.0.0'
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; owner : string?; }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { id : string?; name : string?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n'
        + '  model Ext : ext { connect src; populate Customer key cust_id { name = "nm"; } }\n}\n'
    public static readonly Account = 'crm.Account'
    public static readonly Customer = 'ext.Customer'
    public static readonly CustomerSource = 'Customer'
    public static readonly CustomerKey = 'cust_id'
    public static readonly NameField = 'nm'
    public static readonly K1 = 'k1'
    public static readonly Acme = 'Acme'
    public static readonly Name = 'name'
    public static readonly Owner = 'owner'
    public static readonly R1 = 'r1'
    public static readonly R2 = 'r2'
    public static readonly P1 = 'p1'
    public static readonly P2 = 'p2'
    public static readonly P3 = 'p3'
    public static readonly T1 = 't1'
    public static readonly Root = 'root'
    public static readonly RootName = 'Root'
    public static readonly OwnerRole = 'owner-role'
    public static readonly ReaderRole = 'reader-role'
    public static readonly Accounts = 'MATCH (a:`crm.Account`) RETURN a.name AS name ORDER BY name'
    public static readonly ExternalReason = 'external records are outside platform security'

    public static Model(): ISecurityModelConfig
    {
        const privileges = (actions: readonly PrivilegeAction[]) => actions.map(action => ({ action, level: AccessLevel.User, concept: ShareFx.Account }))
        const member = (principalId: string) => ({ principalId, homeBusinessUnit: ShareFx.Root, teams: [] })
        return {
            businessUnits: [{ id: ShareFx.Root, name: ShareFx.RootName }],
            teams: [{ id: ShareFx.T1, name: ShareFx.T1, owningBusinessUnit: ShareFx.Root }],
            membership: { claimsMapping: [], overrides: [member(ShareFx.P1), member(ShareFx.P2), member(ShareFx.P3)] },
            ownershipRules: [{ concept: ShareFx.Account, owner: { kind: OwnershipSourceKind.FromField, value: ShareFx.Owner }, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: ShareFx.Root } }],
            roles: [
                { id: ShareFx.OwnerRole, name: ShareFx.OwnerRole, privileges: privileges([PrivilegeAction.Read, PrivilegeAction.Update, PrivilegeAction.Delete, PrivilegeAction.Share, PrivilegeAction.Assign]) },
                { id: ShareFx.ReaderRole, name: ShareFx.ReaderRole, privileges: privileges([PrivilegeAction.Read, PrivilegeAction.Update]) },
            ],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: ShareFx.P1, roles: [ShareFx.OwnerRole] },
                { principalId: ShareFx.P2, roles: [ShareFx.ReaderRole] },
                { principalId: ShareFx.P3, roles: [ShareFx.ReaderRole] },
            ] },
        }
    }

    public static Principal(id: string): Principal
    {
        return new Principal(id, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), [])
    }

    public static Context(fx: EnvironmentFixture, id: string): AccessContext
    {
        return fx.ContextFor(ShareFx.Principal(id))
    }

    /** crm and ext live, k1 in the Customer source, r1 and r2 owned by p1, the server started with identity. */
    public static async Run(body: (fx: EnvironmentFixture) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            await fx.Package(ShareFx.Crm.id, ShareFx.Crm.version, ShareFx.CrmTodl)
            await fx.Package(ShareFx.Ext.id, ShareFx.Ext.version, ShareFx.ExtTodl)
            fx.Live(ShareFx.App, ShareFx.AppVersion, [ShareFx.Crm])
            fx.Live(ShareFx.ExtApp, ShareFx.AppVersion, [ShareFx.Ext])
            fx.Source.Adapter.Seed(ShareFx.CustomerSource, [{ [ShareFx.CustomerKey]: ShareFx.K1, [ShareFx.NameField]: ShareFx.Acme }])
            await fx.Start({ Identity: true, SecurityModel: ShareFx.Model() })
            await ShareFx.SeedAccounts(fx, [ShareFx.R1, ShareFx.R2])
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    /** One account per id, owned by p1 and named by its id (System transaction). */
    public static SeedAccounts(fx: EnvironmentFixture, ids: readonly string[]): Promise<bigint>
    {
        return fx.Seed(ids.map(id => ({ Concept: ShareFx.Account, Id: id, Properties: { [ShareFx.Name]: id, [ShareFx.Owner]: ShareFx.P1 } })))
    }

    /** Share params of account `id` to principal `subject` (or a team) with `rights`. */
    public static Params(id: string, subject: string, rights: readonly string[], kind: ShareSubjectKind = ShareSubjectKind.Principal, concept: string = ShareFx.Account): ShareParams
    {
        return { concept, id, subject: { kind, id: subject }, rights: [...rights] }
    }

    /** The account names `principal` reads through the environment's `cypher/query`. */
    public static async Names(fx: EnvironmentFixture, principal: string): Promise<unknown[]>
    {
        const client = await fx.Connect(ShareFx.Principal(principal))
        return (await client.CypherQuery(ShareFx.Accounts)).items.map(row => row[0])
    }

    public static async Scope(fx: EnvironmentFixture, principal: string): Promise<IGraphScope>
    {
        return (await fx.Server.EnvironmentScopes()).ScopeFor(ShareFx.Context(fx, principal))
    }

    /** The node as a System reader sees it. */
    public static async Node(fx: EnvironmentFixture, id: string): Promise<INodeView | undefined>
    {
        const reader = await (await fx.Server.EnvironmentEngine().Engine()).BeginRead(AccessScope.System)
        try
        {
            return await reader.ReadNode(id)
        }
        finally
        {
            reader.dispose()
        }
    }

    public static async Property(fx: EnvironmentFixture, id: string, member: string): Promise<CellValue | undefined>
    {
        return (await ShareFx.Node(fx, id))?.Properties.get(member)
    }

    /** The ids of the nodes linking `record` as their `record` (System reader). */
    public static async GrantsOf(fx: EnvironmentFixture, record: string): Promise<string[]>
    {
        const reader = await (await fx.Server.EnvironmentEngine().Engine()).BeginRead(AccessScope.System)
        try
        {
            return (await reader.Links(record, EdgeDirection.In, SystemNames.Record)).map(link => link.PublicId)
        }
        finally
        {
            reader.dispose()
        }
    }

    /** The public id of the Customer row keyed `key`. */
    public static async CustomerId(fx: EnvironmentFixture, key: string): Promise<string>
    {
        const identity = (await fx.Server.EnvironmentEngine().Snapshot()).Catalog.Identity
        return identity.Mint(identity.CreateTarget(ShareFx.Customer)!, key)
    }
}
