import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessError, AccessErrorCode, AccessScope, Cypher, Not, OwnerIs, TruePredicate } from '@pragmatic-tech-ai/graph'
import type { CellValue, GraphEngine } from '@pragmatic-tech-ai/graph'
import { ShareRight, ShareSubject, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { CursorStaleError } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, AccessLevel, Grant, OwnershipSourceKind, Principal, PrincipalKind, PrivilegeAction, ResourceAuthorizationPolicy, ResourceKind, ResourceRef, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { IPrivilegeConfig, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { CypherLimits } from '../../../config/cypher-limits.js'
import { PagingLimits } from '../../../config/paging-limits.js'
import type { PragmaticServer } from '../../../pragmatic-server.js'
import type { IGraphScope } from '../../engine/access-scope-source.js'
import { EngineCypherQuery } from '../../engine/engine-cypher-query.js'
import { EngineInstanceView } from '../../engine/engine-instance-view.js'
import { EnvironmentFixture } from './environment-fixture.js'
import type { IEnvironmentFixtureOptions } from './environment-fixture.js'

/**
 * A runtime tenant delivering `crm` (crm.Account with an owner field, a seeded `crm.seeded1`, and crm.Fake, a concept
 * shaped like a share grant) and `ext` (ext.Customer bound writable with a text id member, ext.Vendor bound
 * read-only). The security model gives p1 and p2 User-level access to crm.Account and p2 Organization reads of
 * crm.Fake; p2 is in team-a; p3 holds nothing.
 */
class ScopeFx
{
    public static readonly CrmApp = 'crm-app'
    public static readonly ExtApp = 'ext-app'
    public static readonly AppVersion = '1.0.0'
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; owner : string?; }\n  concept Fake { record : todl.Element?; subjectKind : string?; subjectId : string?; read : boolean?; }\n  model Crm : crm { Account seeded1 { } }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { id : string?; name : string?; }\n  concept Vendor { name : string?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n'
        + '  model Ext : ext { connect src; populate Customer key cust_id { name = "nm"; } populate Vendor key vend_id { name = "nm"; read-only; } }\n}\n'
    public static readonly Account = 'crm.Account'
    public static readonly Fake = 'crm.Fake'
    public static readonly Customer = 'ext.Customer'
    public static readonly Vendor = 'ext.Vendor'
    public static readonly Seeded = 'crm.seeded1'
    public static readonly Name = 'name'
    public static readonly Owner = 'owner'
    public static readonly IdMember = 'id'
    public static readonly P1 = 'p1'
    public static readonly P2 = 'p2'
    public static readonly P3 = 'p3'
    public static readonly TeamA = 'team-a'
    public static readonly Root = 'root'
    public static readonly UserRole = 'user-role'
    public static readonly FakeRole = 'fake-role'
    public static readonly Acme = 'Acme'
    public static readonly VendorName = 'Vend'
    public static readonly Changed = 'changed'
    public static readonly Accounts = 'MATCH (a:`crm.Account`) RETURN a.name AS name ORDER BY name'
    public static readonly Customers = 'MATCH (c:`ext.Customer`) RETURN c.name AS name ORDER BY name'
    public static readonly Grants = 'MATCH (g:`todl.system.ShareGrant`) RETURN g.subjectId AS subject ORDER BY subject'
    public static readonly CustomerSource = 'Customer'
    public static readonly CustomerKey = 'cust_id'
    public static readonly NameField = 'nm'

    public static Model(privileges: readonly IPrivilegeConfig[] = ScopeFx.UserPrivileges()): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: ScopeFx.Root, name: 'Root' }],
            teams: [{ id: ScopeFx.TeamA, name: 'A' }],
            membership: { claimsMapping: [], overrides: [
                { principalId: ScopeFx.P1, homeBusinessUnit: ScopeFx.Root, teams: [] },
                { principalId: ScopeFx.P2, homeBusinessUnit: ScopeFx.Root, teams: [ScopeFx.TeamA] },
                { principalId: ScopeFx.P3, homeBusinessUnit: ScopeFx.Root, teams: [] },
            ] },
            ownershipRules: [{ concept: ScopeFx.Account, owner: { kind: OwnershipSourceKind.FromField, value: ScopeFx.Owner }, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: ScopeFx.Root } }],
            roles: [
                { id: ScopeFx.UserRole, name: 'User', privileges: [...privileges] },
                { id: ScopeFx.FakeRole, name: 'Fake', privileges: [{ action: PrivilegeAction.Read, level: AccessLevel.Organization, concept: ScopeFx.Fake }] },
            ],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: ScopeFx.P1, roles: [ScopeFx.UserRole] },
                { principalId: ScopeFx.P2, roles: [ScopeFx.UserRole, ScopeFx.FakeRole] },
            ] },
        }
    }

    public static UserPrivileges(level: AccessLevel = AccessLevel.User): IPrivilegeConfig[]
    {
        return [PrivilegeAction.Read, PrivilegeAction.Create, PrivilegeAction.Update, PrivilegeAction.Delete].map(action => ({ action, level, concept: ScopeFx.Account }))
    }

    public static Context(principalId: string): AccessContext
    {
        const tenant = new Tenant(EnvironmentFixture.TenantId, TenantKind.SelfHosted, 'Environment One')
        const principal = new Principal(principalId, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(principalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, EnvironmentFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** crm and ext live, the ext Customer source holding one row, the server started with `options`. */
    public static async Run(options: IEnvironmentFixtureOptions, body: (fx: EnvironmentFixture, server: PragmaticServer) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            await fx.Package(ScopeFx.Crm.id, ScopeFx.Crm.version, ScopeFx.CrmTodl)
            await fx.Package(ScopeFx.Ext.id, ScopeFx.Ext.version, ScopeFx.ExtTodl)
            fx.Live(ScopeFx.CrmApp, ScopeFx.AppVersion, [ScopeFx.Crm])
            fx.Live(ScopeFx.ExtApp, ScopeFx.AppVersion, [ScopeFx.Ext])
            fx.Source.Adapter.Seed(ScopeFx.CustomerSource, [{ [ScopeFx.CustomerKey]: 'k1', [ScopeFx.NameField]: ScopeFx.Acme }])
            const server = await fx.Start(options)
            await body(fx, server)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    public static async Scope(server: PragmaticServer, principalId: string): Promise<IGraphScope>
    {
        return (await server.EnvironmentScopes()).ScopeFor(ScopeFx.Context(principalId))
    }

    /** The first column of `query` under `scope`. */
    public static async Column(server: PragmaticServer, scope: AccessScope, query: string): Promise<unknown[]>
    {
        const result = await new Cypher.CypherEngine(await server.EnvironmentEngine().Engine()).Execute(scope, query)
        return result.Rows.map(row => (row[0] as Cypher.ScalarValue).Value)
    }

    /** One account per row, `[name, owner]`. */
    public static SeedAccounts(fx: EnvironmentFixture, rows: readonly (readonly [string, string])[]): Promise<bigint>
    {
        return fx.Seed(rows.map(([name, owner]) => ({ Concept: ScopeFx.Account, Id: name, Properties: { [ScopeFx.Name]: name, [ScopeFx.Owner]: owner } })))
    }

    /** A share grant of `record` to `subject`, holding `rights` (System transaction). */
    public static async Grant(server: PragmaticServer, id: string, record: string, kind: ShareSubject, subject: string, rights: readonly ShareRight[], concept: string = SystemNames.ShareGrant): Promise<void>
    {
        const engine = await server.EnvironmentEngine().Engine()
        const transaction = await engine.Begin(AccessScope.System)
        transaction.CreateNode(id, concept, { Owner: concept === SystemNames.ShareGrant ? SystemNames.Model : ScopeFx.Crm.id })
        transaction.SetProperty(id, SystemNames.SubjectKind, kind)
        transaction.SetProperty(id, SystemNames.SubjectId, subject)
        for (const right of rights) transaction.SetProperty(id, right, true)
        transaction.Link(id, SystemNames.Record, record)
        await transaction.Commit()
    }

    /** A create of `concept` through the scope's placement, committed under the scope. */
    public static async Create(engine: GraphEngine, scope: IGraphScope, concept: string, properties: Readonly<Record<string, CellValue>>): Promise<Cypher.INodePlace>
    {
        const values = new Map<string, CellValue>(Object.entries(properties))
        const place = scope.Placement().Place(concept, values)
        const transaction = await engine.Begin(scope.Scope)
        transaction.CreateNode(place.PublicId, concept, { Owner: place.Owner })
        for (const [member, value] of values) transaction.SetProperty(place.PublicId, member, value)
        for (const [member, value] of place.Defaults ?? new Map<string, CellValue>()) transaction.SetDefault(place.PublicId, member, value)
        await transaction.Commit()
        return place
    }

    public static async Update(engine: GraphEngine, scope: AccessScope, id: string, member: string, value: CellValue): Promise<void>
    {
        const transaction = await engine.Begin(scope)
        transaction.SetProperty(id, member, value)
        await transaction.Commit()
    }

    public static Denied(code: AccessErrorCode): (error: unknown) => boolean
    {
        return error => error instanceof AccessError && error.Code === code
    }

    public static async Page(server: PragmaticServer, principalId: string, cursor?: string): Promise<{ nextCursor?: string }>
    {
        const limits = new CypherLimits()
        const query = new EngineCypherQuery(server.EnvironmentEngine(), () => server.EnvironmentScopes())
        return query.Run(ScopeFx.Context(principalId), {
            Source: ScopeFx.Accounts,
            Parameters: new Map(),
            CanonicalParameters: '',
            Page: { Params: { pageSize: 1, cursor }, Limits: new PagingLimits(), RowCap: limits.RowCap },
            TimeoutMs: limits.TimeoutMs,
            MaxVarLength: limits.MaxVarLength,
        })
    }

    public static async CodeOf(attempt: Promise<unknown>): Promise<number | undefined>
    {
        try
        {
            await attempt
        }
        catch (error)
        {
            return (error as { code?: number }).code
        }
        return undefined
    }
}

describe('environment scope rules', () =>
{
    test('governed concept gets depth', async () =>
    {
        await ScopeFx.Run({ Identity: true, SecurityModel: ScopeFx.Model() }, async (fx, server) =>
        {
            await ScopeFx.SeedAccounts(fx, [['a1', ScopeFx.P1], ['a2', ScopeFx.P2]])
            assert.deepEqual(await ScopeFx.Column(server, (await ScopeFx.Scope(server, ScopeFx.P1)).Scope, ScopeFx.Accounts), ['a1'], 'User level: own rows only')
            assert.deepEqual(await ScopeFx.Column(server, (await ScopeFx.Scope(server, ScopeFx.P3)).Scope, ScopeFx.Accounts), [], 'no privilege: nothing')
        })
    })

    test('placement stamps defaults', async () =>
    {
        await ScopeFx.Run({ Identity: true, SecurityModel: ScopeFx.Model() }, async (_fx, server) =>
        {
            const engine = await server.EnvironmentEngine().Engine()
            const scope = await ScopeFx.Scope(server, ScopeFx.P1)
            const place = await ScopeFx.Create(engine, scope, ScopeFx.Account, { [ScopeFx.Name]: 'mine' })
            assert.equal(place.Owner, ScopeFx.Crm.id, 'the node is owned by the home package')
            assert.equal(place.Defaults?.get(ScopeFx.Owner), ScopeFx.P1, 'the owner member is the principal')
            const reader = await engine.BeginRead(scope.Scope)
            try
            {
                const node = await reader.ReadNode(place.PublicId)
                assert.equal(node?.Owner, ScopeFx.Crm.id)
                assert.equal(node?.Properties.get(ScopeFx.Owner), ScopeFx.P1)
                const view = await EngineInstanceView.Of(reader, place.PublicId)
                assert.equal(view?.Concept, ScopeFx.Account)
                assert.equal(view?.Field(ScopeFx.Owner), ScopeFx.P1, 'the evaluator view reads the stamped owner')
            }
            finally
            {
                reader.dispose()
            }
        })
    })

    test('external concept is outside the scope', async () =>
    {
        await ScopeFx.Run({ Identity: true, SecurityModel: ScopeFx.Model() }, async (fx, server) =>
        {
            const engine = await server.EnvironmentEngine().Engine()
            const scope = await ScopeFx.Scope(server, ScopeFx.P3)
            assert.equal(scope.Scope.Rows.get(ScopeFx.Customer), TruePredicate.Instance, 'no row restriction on the bound concept')
            assert.equal(scope.Scope.Writes.get(ScopeFx.Customer)?.Create, TruePredicate.Instance, 'no write restriction on the writable binding')
            assert.deepEqual(await ScopeFx.Column(server, scope.Scope, ScopeFx.Customers), [ScopeFx.Acme], 'a principal holding nothing reads the rows')
            const place = await ScopeFx.Create(engine, scope, ScopeFx.Customer, { [ScopeFx.Name]: 'New' })
            const key = place.Defaults?.get(ScopeFx.IdMember)
            assert.equal(typeof key, 'string', 'the text id member defaults to the placed key (R112)')
            assert.ok(fx.Source.Adapter.Batches.length > 0, 'the create wrote through to the source')
            assert.deepEqual(await ScopeFx.Column(server, scope.Scope, ScopeFx.Customers), [ScopeFx.Acme, 'New'])
        })
    })

    test('read-only binding refuses writes', async () =>
    {
        await ScopeFx.Run({ Identity: true, SecurityModel: ScopeFx.Model() }, async (_fx, server) =>
        {
            const engine = await server.EnvironmentEngine().Engine()
            const identity = (await server.EnvironmentEngine().Snapshot()).Catalog.Identity
            const vendor = identity.ReadOnly().find(binding => binding.Binding.Concept === ScopeFx.Vendor)!
            const scope = await ScopeFx.Scope(server, ScopeFx.P3)
            const create = scope.Scope.Writes.get(ScopeFx.Vendor)?.Create
            assert.deepEqual(create, new Not(new OwnerIs(new Set([vendor.Model]))), 'the guard names the read-only binding model only')
            await assert.rejects(ScopeFx.Create(engine, scope, ScopeFx.Vendor, { [ScopeFx.Name]: ScopeFx.VendorName }), ScopeFx.Denied(AccessErrorCode.CreateDenied))
        })
    })

    test('seeded node is read-only (no identity allows reads)', async () =>
    {
        await ScopeFx.Run({}, async (fx, server) =>
        {
            await ScopeFx.SeedAccounts(fx, [['a1', ScopeFx.P1], ['a2', ScopeFx.P2]])
            const engine = await server.EnvironmentEngine().Engine()
            const scope = (await ScopeFx.Scope(server, ScopeFx.P1)).Scope
            assert.equal((await ScopeFx.Column(server, scope, ScopeFx.Accounts)).length, 3, 'no identity: every row, the seeded one too')
            await assert.rejects(ScopeFx.Update(engine, scope, ScopeFx.Seeded, ScopeFx.Name, ScopeFx.Changed), ScopeFx.Denied(AccessErrorCode.UpdateDenied))
            await ScopeFx.Update(engine, scope, 'a2', ScopeFx.Name, ScopeFx.Changed)
        })
    })

    test('shared record is visible through a grant', async () =>
    {
        await ScopeFx.Run({ Identity: true, SecurityModel: ScopeFx.Model() }, async (fx, server) =>
        {
            await ScopeFx.SeedAccounts(fx, [['r1', ScopeFx.P1], ['r2', ScopeFx.P1], ['r3', ScopeFx.P1], ['r4', ScopeFx.P1]])
            await ScopeFx.Grant(server, 'g1', 'r1', ShareSubject.Principal, ScopeFx.P2, [ShareRight.Read])
            await ScopeFx.Grant(server, 'g2', 'r2', ShareSubject.Team, ScopeFx.TeamA, [ShareRight.Read])
            await ScopeFx.Grant(server, 'g3', 'r3', ShareSubject.Principal, ScopeFx.P2, [ShareRight.Update])
            await ScopeFx.Grant(server, 'g4', 'r4', ShareSubject.Principal, ScopeFx.P3, [ShareRight.Read])
            const scope = (await ScopeFx.Scope(server, ScopeFx.P2)).Scope
            assert.deepEqual(await ScopeFx.Column(server, scope, ScopeFx.Accounts), ['r1', 'r2'], 'principal and team grants with read widen; a grant without read does not')
            assert.deepEqual(await ScopeFx.Column(server, scope, ScopeFx.Grants), [ScopeFx.P2, ScopeFx.P2, ScopeFx.TeamA], 'grant rows are the principal\'s own')
            const engine = await server.EnvironmentEngine().Engine()
            await assert.rejects(ScopeFx.Update(engine, scope, 'g1', ShareRight.Delete, true), ScopeFx.Denied(AccessErrorCode.UpdateDenied), 'grants are not writable through the caller scope')
        })
    })

    test('lookalike grant concept does not widen', async () =>
    {
        await ScopeFx.Run({ Identity: true, SecurityModel: ScopeFx.Model() }, async (fx, server) =>
        {
            await ScopeFx.SeedAccounts(fx, [['r1', ScopeFx.P1]])
            await ScopeFx.Grant(server, 'fake1', 'r1', ShareSubject.Principal, ScopeFx.P2, [ShareRight.Read], ScopeFx.Fake)
            const scope = (await ScopeFx.Scope(server, ScopeFx.P2)).Scope
            assert.equal((await ScopeFx.Column(server, scope, 'MATCH (f:`crm.Fake`) RETURN f.subjectId AS s')).length, 1, 'the lookalike is visible to p2')
            assert.deepEqual(await ScopeFx.Column(server, scope, ScopeFx.Accounts), [], 'but it widens nothing (R114 ConceptIs guard)')
        })
    })

    test('no security model is deny all', async () =>
    {
        await ScopeFx.Run({ Identity: true }, async (fx, server) =>
        {
            await ScopeFx.SeedAccounts(fx, [['a1', ScopeFx.P1], ['a2', ScopeFx.P1]])
            await ScopeFx.Grant(server, 'g1', 'a2', ShareSubject.Principal, ScopeFx.P1, [ShareRight.Read])
            const engine = await server.EnvironmentEngine().Engine()
            const scope = await ScopeFx.Scope(server, ScopeFx.P1)
            assert.deepEqual(await ScopeFx.Column(server, scope.Scope, ScopeFx.Accounts), ['a2'], 'only the shared record: a grant under DenyAll still widens (parity)')
            await assert.rejects(ScopeFx.Create(engine, scope, ScopeFx.Account, { [ScopeFx.Name]: 'x' }), ScopeFx.Denied(AccessErrorCode.CreateDenied))
            assert.deepEqual(await ScopeFx.Column(server, scope.Scope, ScopeFx.Customers), [ScopeFx.Acme], 'connector concepts stay outside platform security')
        })
    })

    test('binding an app does not change the scope', async () =>
    {
        await ScopeFx.Run({ Identity: true, SecurityModel: ScopeFx.Model() }, async (fx, server) =>
        {
            await ScopeFx.SeedAccounts(fx, [['a1', ScopeFx.P1], ['a2', ScopeFx.P2]])
            const before = await ScopeFx.Scope(server, ScopeFx.P1)
            const visible = await ScopeFx.Column(server, before.Scope, ScopeFx.Accounts)
            for (const app of [ScopeFx.CrmApp, ScopeFx.ExtApp])
            {
                const client = await fx.Connect(ScopeFx.Context(ScopeFx.P1).Principal)
                await client.OpenApplication(app)
                const after = await ScopeFx.Scope(server, ScopeFx.P1)
                assert.equal(after.Digest, before.Digest, app)
                assert.deepEqual(await ScopeFx.Column(server, after.Scope, ScopeFx.Accounts), visible, app)
            }
        })
    })

    test('security-model edit stales the cursor', async () =>
    {
        await ScopeFx.Run({ Identity: true, SecurityModel: ScopeFx.Model() }, async (fx, server) =>
        {
            await ScopeFx.SeedAccounts(fx, [['a1', ScopeFx.P1], ['a2', ScopeFx.P1], ['a3', ScopeFx.P1]])
            const first = await ScopeFx.Page(server, ScopeFx.P1)
            assert.ok(first.nextCursor !== undefined)
            const second = await ScopeFx.Page(server, ScopeFx.P1, first.nextCursor)
            assert.ok(second.nextCursor !== undefined, 'without an edit the chain continues')
            await fx.SaveSecurityModel(ScopeFx.Model(ScopeFx.UserPrivileges(AccessLevel.Organization)))
            ;(await server.SecurityModelReload()).Invalidate(EnvironmentFixture.TenantId)
            assert.equal(await ScopeFx.CodeOf(ScopeFx.Page(server, ScopeFx.P1, second.nextCursor)), CursorStaleError.Code)
        })
    })
})
