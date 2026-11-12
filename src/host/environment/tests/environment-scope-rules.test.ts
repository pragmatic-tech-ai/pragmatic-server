import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessErrorCode, AccessScope, BindingTable, Cypher, Not, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { CursorStaleError } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessLevel, BaseRole, IdpDirectorySnapshot, IdpUserState, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { CypherLimits } from '../../../config/cypher-limits.js'
import { PagingLimits } from '../../../config/paging-limits.js'
import type { PragmaticServer } from '../../../pragmatic-server.js'
import { EngineCypherQuery } from '../../engine/engine-cypher-query.js'
import { EnvironmentFixture } from './environment-fixture.js'
import { Tier1Fx } from './tier1-fixture.js'

class RulesFx
{
    public static readonly E1 = 'E1'
    public static readonly E2 = 'E2'
    public static readonly P1 = 'P1'
    public static readonly P2 = 'P2'
    public static readonly T1 = 'T1'
    public static readonly A1 = 'A1'
    public static readonly A2 = 'A2'
    public static readonly N1 = 'N1'
    public static readonly HighSalary = 150000
    public static readonly Moved = 'bob'
    public static readonly NewEmployee = 'new'
    public static readonly NoParameters = ''
    public static readonly RichEmployees = 'MATCH (e:`hr.Employee`) WHERE e.Salary > 100000 RETURN e.name AS name'
    public static readonly AbsentProperty = 'MATCH (e:`hr.Employee`) WHERE e.Absent > 100000 RETURN e.name AS name'
    public static readonly Salaries = 'MATCH (e:`hr.Employee`) RETURN e.Salary AS s ORDER BY s'
    public static readonly AssignmentCount = 'MATCH (a:`projects.Assignment`) RETURN count(a) AS c'
    public static readonly Employees = 'MATCH (e:`hr.Employee`) RETURN e.name AS name ORDER BY name'

    /** E1 alice/sales and E2 bob/marketing, both paid well. */
    public static async SeedEmployees(fx: EnvironmentFixture): Promise<void>
    {
        await fx.Seed([
            Tier1Fx.Owned(Tier1Fx.Employee, RulesFx.E1, Tier1Fx.Alice, Tier1Fx.Sales, { [Tier1Fx.Salary]: RulesFx.HighSalary }),
            Tier1Fx.Owned(Tier1Fx.Employee, RulesFx.E2, Tier1Fx.Bob, Tier1Fx.Marketing, { [Tier1Fx.Salary]: RulesFx.HighSalary }),
        ])
    }

    /** P1 pm/sales and P2 bob/marketing. */
    public static async SeedProjects(fx: EnvironmentFixture): Promise<void>
    {
        await fx.Seed([Tier1Fx.Owned(Tier1Fx.Project, RulesFx.P1, Tier1Fx.Pm, Tier1Fx.Sales), Tier1Fx.Owned(Tier1Fx.Project, RulesFx.P2, Tier1Fx.Bob, Tier1Fx.Marketing)])
    }

    public static async Page(server: PragmaticServer, principalId: string, cursor?: string): Promise<{ nextCursor?: string }>
    {
        const limits = new CypherLimits()
        const query = new EngineCypherQuery(server.EnvironmentEngine(), () => server.EnvironmentScopes())
        return query.Run(Tier1Fx.Context(principalId), {
            Source: RulesFx.Employees,
            Parameters: new Map(),
            CanonicalParameters: RulesFx.NoParameters,
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

describe('environment scope rules (tier 1)', () =>
{
    test('role grants rows at its depth', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await RulesFx.SeedEmployees(fx)
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Alice, Tier1Fx.Employee), [RulesFx.E1], 'hr\'s BasicUser contribution reads at BU: Sales rows only')
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Bob, Tier1Fx.Employee), [RulesFx.E2])
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Carol, Tier1Fx.Employee), [], 'no role: nothing')
        })
    })

    test('override narrows a package role', async () =>
    {
        const assigned = [{ role: Tier1Fx.ProjectManager, principalIds: [Tier1Fx.Pm], teamIds: [] }]
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting({ RoleAssignments: assigned }) }, async (fx, server) =>
        {
            await RulesFx.SeedProjects(fx)
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Pm, Tier1Fx.Project), [RulesFx.P1, RulesFx.P2], 'the package default reads organisation-wide')
            const narrowed = Tier1Fx.Override(Tier1Fx.ProjectManager, Tier1Fx.Project, PrivilegeAction.Read, AccessLevel.BusinessUnit)
            await fx.SaveSecurityModel(Tier1Fx.Setting({ RoleAssignments: assigned, RoleOverrides: [narrowed] }))
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Pm, Tier1Fx.Project), [RulesFx.P1], 'the override reads at BU (spec §9.2)')
        })
    })

    test('uncovered concept is system administrator only', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await fx.Seed([Tier1Fx.Owned(Tier1Fx.Note, RulesFx.N1, Tier1Fx.Alice, Tier1Fx.Sales)])
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Alice, Tier1Fx.Note), [], 'no role covers projects.Note, not even its owner\'s')
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Admin, Tier1Fx.Note), [RulesFx.N1])
        })
    })

    test('system administrator is unrestricted', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await RulesFx.SeedEmployees(fx)
            await RulesFx.SeedProjects(fx)
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Admin, Tier1Fx.Employee), [RulesFx.E1, RulesFx.E2])
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Admin, Tier1Fx.Project), [RulesFx.P1, RulesFx.P2])
            const scope = (await Tier1Fx.Scope(server, Tier1Fx.Admin)).Scope
            assert.deepEqual(await Tier1Fx.Column(server, scope, RulesFx.Salaries), [RulesFx.HighSalary, RulesFx.HighSalary], 'every secured field too')
        })
    })

    test('secured field without read is nonexistent', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await RulesFx.SeedEmployees(fx)
            const alice = (await Tier1Fx.Scope(server, Tier1Fx.Alice)).Scope
            assert.deepEqual(await Tier1Fx.Column(server, alice, RulesFx.RichEmployees), [], 'Salary is hidden: the predicate matches nothing')
            assert.deepEqual(await Tier1Fx.Column(server, alice, RulesFx.RichEmployees), await Tier1Fx.Column(server, alice, RulesFx.AbsentProperty), 'the same answer as an absent property')
            assert.ok(alice.Hidden.get(Tier1Fx.Employee)?.has(Tier1Fx.Salary))
            const profiled = Tier1Fx.Setting({ ProfileAssignments: [{ profile: Tier1Fx.Compensation, principalIds: [Tier1Fx.Alice], teamIds: [] }] })
            await fx.SaveSecurityModel(profiled)
            const withProfile = (await Tier1Fx.Scope(server, Tier1Fx.Alice)).Scope
            assert.deepEqual(await Tier1Fx.Column(server, withProfile, RulesFx.RichEmployees), [RulesFx.E1], 'the Compensation profile reads it')
        })
    })

    test('external concept is outside the scope', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (_fx, server) =>
        {
            const scope = (await Tier1Fx.Scope(server, Tier1Fx.Carol)).Scope
            assert.equal(scope.Rows.get(Tier1Fx.Customer), undefined, 'no tier-1 entry on the connector concept')
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Carol, Tier1Fx.Customer), [Tier1Fx.Acme], 'a principal holding nothing reads connector rows')
            const identity = (await server.EnvironmentEngine().Snapshot()).Catalog.Identity
            const vendor = identity.ReadOnly()[0]!
            assert.deepEqual(scope.Writes.get(vendor.Binding.Concept)?.Create, new Not(new OwnerIs(new Set([vendor.Model]))), 'the read-only binding guard still applies')
        })
    })

    // R28 regression (relocated from the deleted tier1-engine-catalog suite): TODL composes every environment with an
    // engine-storage default connector; the tier-1 compiler must still govern engine-stored concepts over the real
    // catalog (guarding the fail-open the retired Tier1EngineCatalog adapter covered).
    test('an engine-stored concept is governed over a real environment catalog', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            const catalog = (await server.EnvironmentEngine().Snapshot()).Catalog
            assert.equal(catalog.Description.DefaultConnector, BindingTable.EngineStorage, 'TODL composes with an engine-storage default')
            await fx.Seed([{ Concept: Tier1Fx.Account, Id: Tier1Fx.Acme, Properties: { [Tier1Fx.Name]: Tier1Fx.Acme } }])
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Carol, Tier1Fx.Account), [], 'a principal with no role cannot read crm.Account')
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Admin, Tier1Fx.Account), [Tier1Fx.Acme])
        })
    })

    test('no setting stored is deny all', async () =>
    {
        await Tier1Fx.Run({ Identity: true }, async (fx, server) =>
        {
            await RulesFx.SeedEmployees(fx)
            for (const principal of [Tier1Fx.Alice, Tier1Fx.Admin])
            {
                assert.deepEqual(await Tier1Fx.Names(server, principal, Tier1Fx.Employee), [], principal)
                assert.deepEqual(await Tier1Fx.Names(server, principal, Tier1Fx.Account), [], principal)
            }
        })
    })

    test('disabled identity has no access', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await RulesFx.SeedEmployees(fx)
            assert.equal((await Tier1Fx.Names(server, Tier1Fx.Admin, Tier1Fx.Employee)).length, 2)
            const snapshot = new IdpDirectorySnapshot(new Date(), true, new Map([[Tier1Fx.Admin, IdpUserState.Disabled]]), new Map())
            await (await server.Pack()).IdpDirectory.Save(EnvironmentFixture.TenantId, snapshot)
            ;(await server.SecuritySetting()).Invalidate()
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Admin, Tier1Fx.Employee), [], 'a disabled System Administrator holds nothing')
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Admin, Tier1Fx.Account), [])
        })
    })

    test('security edit stales the cursor', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await fx.Seed([1, 2, 3].map(i => Tier1Fx.Owned(Tier1Fx.Employee, RulesFx.E1 + i, Tier1Fx.Admin, Tier1Fx.Contoso)))
            const first = await RulesFx.Page(server, Tier1Fx.Admin)
            assert.ok(first.nextCursor !== undefined)
            const second = await RulesFx.Page(server, Tier1Fx.Admin, first.nextCursor)
            assert.ok(second.nextCursor !== undefined, 'without an edit the chain continues')
            await fx.SaveSecurityModel(Tier1Fx.Setting({ RoleOverrides: [Tier1Fx.Override(BaseRole.Reader, Tier1Fx.Employee, PrivilegeAction.Read, AccessLevel.User)] }))
            assert.equal(await RulesFx.CodeOf(RulesFx.Page(server, Tier1Fx.Admin, second.nextCursor)), CursorStaleError.Code, 'the next page under the edited setting is stale')
        })
    })

    test('placement stamps owner and home unit', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (_fx, server) =>
        {
            const engine = await Tier1Fx.Engine(server)
            const scope = await Tier1Fx.Scope(server, Tier1Fx.Alice)
            const place = scope.Placement().Place(Tier1Fx.Employee, new Map<string, CellValue>([[Tier1Fx.Name, RulesFx.NewEmployee]]))
            assert.equal(place.Defaults?.get(SystemNames.Owner), Tier1Fx.Alice)
            assert.equal(place.Defaults?.get(SystemNames.OwningBusinessUnit), Tier1Fx.Sales, 'the home unit of the acting principal (C3)')
            const transaction = await engine.Begin(scope.Scope)
            transaction.CreateNode(place.PublicId, Tier1Fx.Employee, { Owner: place.Owner })
            transaction.SetProperty(place.PublicId, Tier1Fx.Name, RulesFx.NewEmployee)
            for (const [member, value] of place.Defaults ?? []) transaction.SetDefault(place.PublicId, member, value)
            await transaction.Commit()
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Alice, Tier1Fx.Employee), [RulesFx.NewEmployee], 'the stamped record is in alice\'s BU')
        })
    })

    test('system fields are read-only for a system administrator', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await RulesFx.SeedEmployees(fx)
            const scope = (await Tier1Fx.Scope(server, Tier1Fx.Admin)).Scope
            const set = new Cypher.CypherEngine(await Tier1Fx.Engine(server)).Execute(scope, 'MATCH (e:`hr.Employee` {name: \'E1\'}) SET e.owner = \'bob\'')
            await assert.rejects(set, (error: unknown) => Tier1Fx.Denied(AccessErrorCode.MemberReadOnly)((error as Error).cause), 'PR1: only assign writes the system fields')
            await Tier1Fx.Update(await Tier1Fx.Engine(server), scope, RulesFx.E1, Tier1Fx.Name, RulesFx.Moved)
        })
    })

    test('a team-held role judges business-unit depth at the team\'s unit', async () =>
    {
        const setting = Tier1Fx.Setting({
            Teams: [Tier1Fx.MarketingTeamOf(Tier1Fx.Alice)],
            RoleAssignments: [{ role: Tier1Fx.ProjectManager, principalIds: [], teamIds: [Tier1Fx.MarketingTeam] }],
            RoleOverrides: [Tier1Fx.Override(Tier1Fx.ProjectManager, Tier1Fx.Project, PrivilegeAction.Read, AccessLevel.BusinessUnit)],
        })
        await Tier1Fx.Run({ Identity: true, SecurityModel: setting }, async (fx, server) =>
        {
            await RulesFx.SeedProjects(fx)
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Alice, Tier1Fx.Project), [RulesFx.P2], 'a Sales user reads Marketing\'s projects through the Marketing team (PR5)')
        })
    })

    test('an edge to a hidden record is invisible', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await fx.Seed([
                Tier1Fx.Owned(Tier1Fx.Project, RulesFx.P1, Tier1Fx.Alice, Tier1Fx.Sales),
                Tier1Fx.Owned(Tier1Fx.Project, RulesFx.P2, Tier1Fx.Bob, Tier1Fx.Marketing),
                Tier1Fx.Owned(Tier1Fx.Task, RulesFx.T1, Tier1Fx.Alice, Tier1Fx.Sales),
                { Concept: Tier1Fx.Assignment, Id: RulesFx.A1 },
                { Concept: Tier1Fx.Assignment, Id: RulesFx.A2 },
            ])
            const engine = await Tier1Fx.Engine(server)
            for (const [edge, project] of [[RulesFx.A1, RulesFx.P1], [RulesFx.A2, RulesFx.P2]])
            {
                await Tier1Fx.Link(engine, AccessScope.System, edge, Tier1Fx.From, RulesFx.T1)
                await Tier1Fx.Link(engine, AccessScope.System, edge, Tier1Fx.To, project)
            }
            const alice = (await Tier1Fx.Scope(server, Tier1Fx.Alice)).Scope
            assert.deepEqual(await Tier1Fx.Column(server, alice, RulesFx.AssignmentCount), [1n], 'the assignment to bob\'s project is not counted (PR4)')
            const admin = (await Tier1Fx.Scope(server, Tier1Fx.Admin)).Scope
            assert.deepEqual(await Tier1Fx.Column(server, admin, RulesFx.AssignmentCount), [2n])
        })
    })

    test('linking needs append and appendTo', async () =>
    {
        const setting = Tier1Fx.Setting({ RoleAssignments: [
            { role: Tier1Fx.TaskEditor, principalIds: [Tier1Fx.Carol], teamIds: [] },
            { role: Tier1Fx.TaskLinker, principalIds: [Tier1Fx.Pm], teamIds: [] },
        ] })
        await Tier1Fx.Run({ Identity: true, SecurityModel: setting }, async (fx, server) =>
        {
            await fx.Seed([Tier1Fx.Owned(Tier1Fx.Project, RulesFx.P1, Tier1Fx.Bob, Tier1Fx.Marketing), Tier1Fx.Owned(Tier1Fx.Task, RulesFx.T1, Tier1Fx.Bob, Tier1Fx.Marketing)])
            const engine = await Tier1Fx.Engine(server)
            const editor = (await Tier1Fx.Scope(server, Tier1Fx.Carol)).Scope
            await Tier1Fx.Update(engine, editor, RulesFx.T1, Tier1Fx.Name, RulesFx.Moved)
            await assert.rejects(Tier1Fx.Link(engine, editor, RulesFx.T1, Tier1Fx.ProjectMember, RulesFx.P1), Tier1Fx.Denied(AccessErrorCode.AppendDenied), 'an Update-only grant no longer links (PR3)')
            await Tier1Fx.Link(engine, (await Tier1Fx.Scope(server, Tier1Fx.Pm)).Scope, RulesFx.T1, Tier1Fx.ProjectMember, RulesFx.P1)
        })
    })
})
