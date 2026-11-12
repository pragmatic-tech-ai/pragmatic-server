import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AccessScope } from '@pragmatic-tech-ai/graph'
import { SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessLevel, BaseRole, PrivilegeAction, SystemPrincipal } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteStatus, AssignStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppDeployResultDto, ContributedPackageDto, CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PragmaticServer } from '../../../pragmatic-server.js'
import { EnvironmentFixture } from './environment-fixture.js'
import type { FixturePackageRef } from './environment-fixture.js'
import { Tier1Fx } from './tier1-fixture.js'

/**
 * One app `suite` delivering `hr` and `crm`. hr 1 and 3: Employee (owned; secured Salary and Bonus, profile
 * Compensation reads Salary) and Review (owned) with role Reviewer; hr 2 drops Review and Reviewer, and Compensation
 * also reads Bonus. crm 1: Account not owned, BasicUser reads it organisation-wide; crm 2: Account owned, BasicUser
 * reads it at user depth. `extra` (promoted) adds a secured field. Setting: contoso > sales; alice (sales) BasicUser,
 * Reviewer (overridden to BU depth on Review) and Compensation; admin (contoso) System Administrator.
 */
class DeliveryFx
{
    public static readonly App = 'suite'
    public static readonly OtherApp = 'other'
    public static readonly V1 = '1.0.0'
    public static readonly V2 = '2.0.0'
    public static readonly V3 = '3.0.0'
    public static readonly Hr1 = { id: 'hr', version: '1.0.0' }
    public static readonly Hr2 = { id: 'hr', version: '2.0.0' }
    public static readonly Hr3 = { id: 'hr', version: '3.0.0' }
    public static readonly Crm1 = { id: 'crm', version: '1.0.0' }
    public static readonly Crm2 = { id: 'crm', version: '2.0.0' }
    public static readonly Extra = { id: 'extra', version: '1.0.0' }
    public static readonly ExtraSet = 'extra-set'
    public static readonly Employee = 'hr.Employee'
    public static readonly Review = 'hr.Review'
    public static readonly Reviewer = 'hr.Reviewer'
    public static readonly Compensation = 'hr.Compensation'
    public static readonly Account = 'crm.Account'
    public static readonly Memo = 'extra.Memo'
    public static readonly Bonus = 'Bonus'
    public static readonly Note = 'note'
    public static readonly E1 = 'E1'
    public static readonly A1 = 'A1'
    public static readonly A2 = 'A2'
    public static readonly BonusValue = 5
    public static readonly Contoso = 'contoso'
    public static readonly Sales = 'sales'
    private static readonly ContosoName = 'Contoso'
    private static readonly SalesName = 'Sales'
    private static readonly ModelFile = 'model.json'
    private static readonly Entry = 'index.html'
    private static readonly Page = '<html></html>'
    private static readonly Base64 = 'base64'

    private static readonly Hr1Todl = `namespace hr
{
    concept Employee : todl.system.Owned { name : string?; secured Salary : number?; secured Bonus : number?; }
    concept Review : todl.system.Owned { name : string?; }
    contribute BasicUser { Employee { read = businessUnit; } Review { read = businessUnit; } }
    role Reviewer { Review { read = organization; } }
    profile Compensation { Employee.Salary : read; }
}`
    private static readonly Hr2Todl = `namespace hr
{
    concept Employee : todl.system.Owned { name : string?; secured Salary : number?; secured Bonus : number?; }
    contribute BasicUser { Employee { read = businessUnit; } }
    profile Compensation { Employee.Salary : read; Employee.Bonus : read; }
}`
    private static readonly Crm1Todl = 'namespace crm {\n  concept Account { name : string?; }\n  contribute BasicUser { Account { read = organization; } }\n}\n'
    private static readonly Crm2Todl = 'namespace crm {\n  concept Account : todl.system.Owned { name : string?; }\n  contribute BasicUser { Account { read = user; } }\n}\n'
    private static readonly ExtraTodl = 'namespace extra {\n  concept Memo : todl.system.Owned { secured note : string?; }\n}\n'

    public static readonly ReviewerOverride = Tier1Fx.Override(DeliveryFx.Reviewer, DeliveryFx.Review, PrivilegeAction.Read, AccessLevel.BusinessUnit)
    public static readonly Reviewers = { role: DeliveryFx.Reviewer, principalIds: [Tier1Fx.Alice], teamIds: [] }

    public static Setting(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: DeliveryFx.Contoso, name: DeliveryFx.ContosoName }, { id: DeliveryFx.Sales, name: DeliveryFx.SalesName, parent: DeliveryFx.Contoso }],
            users: [{ principalId: Tier1Fx.Alice, businessUnitId: DeliveryFx.Sales }, { principalId: Tier1Fx.Admin, businessUnitId: DeliveryFx.Contoso }],
            teams: [],
            roleAssignments: [
                { role: BaseRole.BasicUser, principalIds: [Tier1Fx.Alice], teamIds: [] },
                DeliveryFx.Reviewers,
                { role: BaseRole.SystemAdministrator, principalIds: [Tier1Fx.Admin], teamIds: [] },
            ],
            profileAssignments: [{ profile: DeliveryFx.Compensation, principalIds: [Tier1Fx.Alice], teamIds: [] }],
            roleOverrides: [DeliveryFx.ReviewerOverride],
            profileOverrides: [],
        }
    }

    /** Every package compiled, `suite` live on hr 1 + crm 1, the server started with identity and the setting. */
    public static async Run(body: (fx: EnvironmentFixture, server: PragmaticServer) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            for (const [ref, todl] of [[DeliveryFx.Hr1, DeliveryFx.Hr1Todl], [DeliveryFx.Hr2, DeliveryFx.Hr2Todl], [DeliveryFx.Hr3, DeliveryFx.Hr1Todl],
                [DeliveryFx.Crm1, DeliveryFx.Crm1Todl], [DeliveryFx.Crm2, DeliveryFx.Crm2Todl], [DeliveryFx.Extra, DeliveryFx.ExtraTodl]] as const)
            {
                await fx.Package(ref.id, ref.version, todl)
            }
            fx.Live(DeliveryFx.App, DeliveryFx.V1, [DeliveryFx.Hr1, DeliveryFx.Crm1])
            const server = await fx.Start({ Identity: true, SecurityModel: DeliveryFx.Setting() })
            await server.EnvironmentEngine().Engine()
            await body(fx, server)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    public static Contributed(fx: EnvironmentFixture, ref: FixturePackageRef): ContributedPackageDto
    {
        return { id: ref.id, version: ref.version, modelJson: readFileSync(join(fx.PackagesDir, ref.id, ref.version, DeliveryFx.ModelFile), 'utf8') }
    }

    public static Deploy(fx: EnvironmentFixture, app: string, version: string, refs: readonly FixturePackageRef[]): Promise<AppDeployResultDto>
    {
        const params: CypherAppDeployParamsDto = {
            appName: app,
            appVersion: version,
            packages: refs.map(ref => DeliveryFx.Contributed(fx, ref)),
            uiBundle: [{ path: DeliveryFx.Entry, contentBase64: Buffer.from(DeliveryFx.Page).toString(DeliveryFx.Base64) }],
            manifest: { name: app, version, packages: refs.map(ref => ({ id: ref.id, version: ref.version })), ui: { entry: DeliveryFx.Entry, assets: [] } },
        }
        return fx.Server.DeployApplication(params)
    }

    public static async Applied(fx: EnvironmentFixture, version: string, refs: readonly FixturePackageRef[]): Promise<AppDeployResultDto>
    {
        const result = await DeliveryFx.Deploy(fx, DeliveryFx.App, version, refs)
        assert.equal(result.status, AppWriteStatus.Applied, result.reason)
        return result
    }

    public static async Stored(server: PragmaticServer): Promise<ISecurityModelConfig | undefined>
    {
        return (await server.SecuritySetting()).Config()
    }

    /** `member` of `id` under `principalId`'s scope, read by a reader opened now. */
    public static async Read(server: PragmaticServer, principalId: string, id: string, member: string): Promise<unknown>
    {
        const scope = await Tier1Fx.Scope(server, principalId)
        const reader = await (await Tier1Fx.Engine(server)).BeginRead(scope.Scope, { Connector: scope.Connector })
        try
        {
            return await reader.GetProperty(id, member)
        }
        finally
        {
            reader.dispose()
        }
    }

    public static async SystemRead(server: PragmaticServer, id: string, member: string): Promise<unknown>
    {
        const reader = await (await Tier1Fx.Engine(server)).BeginRead(AccessScope.System)
        try
        {
            return await reader.GetProperty(id, member)
        }
        finally
        {
            reader.dispose()
        }
    }
}

describe('delivery security (S4 Task 13)', () =>
{
    test('deploy answers its security changes', async () =>
    {
        await DeliveryFx.Run(async (fx, server) =>
        {
            const result = await DeliveryFx.Applied(fx, DeliveryFx.V2, [DeliveryFx.Hr2, DeliveryFx.Crm1])
            const changes = result.securityChanges
            assert.ok(changes !== undefined)
            assert.equal(changes.delivery, DeliveryFx.App)
            assert.equal(changes.version, DeliveryFx.V2)
            assert.deepEqual(changes.roleOverridesDropped, [DeliveryFx.ReviewerOverride])
            assert.deepEqual(changes.rolesRemoved, [DeliveryFx.Reviewers])
            assert.deepEqual(changes.profileDefaults, [{
                profile: DeliveryFx.Compensation, concept: DeliveryFx.Employee, field: DeliveryFx.Bonus,
                before: null, after: { concept: DeliveryFx.Employee, field: DeliveryFx.Bonus, read: true, update: false, create: false },
            }])
            assert.deepEqual(await server.SecurityChangeLog().List(), [changes], 'the change log holds the same entry')
        })
    })

    test('deploy prunes the setting before the swap', async () =>
    {
        await DeliveryFx.Run(async (fx, server) =>
        {
            const host = server.EnvironmentEngine()
            const running: string[] = []
            const subscription = (await server.SecuritySetting()).Changed.Subscribe(() =>
            {
                const hr = host.RunningSnapshot()?.Catalog.Packages.find(ref => ref.model === DeliveryFx.Hr1.id)
                running.push(hr?.version ?? '')
            })
            try
            {
                await DeliveryFx.Applied(fx, DeliveryFx.V2, [DeliveryFx.Hr2, DeliveryFx.Crm1])
            }
            finally
            {
                subscription.dispose()
            }
            assert.deepEqual(running, [DeliveryFx.Hr1.version], 'the setting changed once, while the old catalog still ran')
            const stored = await DeliveryFx.Stored(server)
            assert.deepEqual(stored?.roleOverrides, [])
            assert.deepEqual(stored?.roleAssignments.map(a => a.role), [BaseRole.BasicUser, BaseRole.SystemAdministrator])
        })
    })

    test('returned concept does not resurrect a dropped override', async () =>
    {
        await DeliveryFx.Run(async (fx, server) =>
        {
            await DeliveryFx.Applied(fx, DeliveryFx.V2, [DeliveryFx.Hr2, DeliveryFx.Crm1])
            const restored = await DeliveryFx.Applied(fx, DeliveryFx.V3, [DeliveryFx.Hr3, DeliveryFx.Crm1])
            const stored = await DeliveryFx.Stored(server)
            assert.deepEqual(stored?.roleOverrides, [], 'the dropped override stays dropped')
            assert.equal(stored?.roleAssignments.some(a => a.role === DeliveryFx.Reviewer), false, 'the removed role keeps no assignments')
            const log = await server.SecurityChangeLog().List()
            assert.deepEqual(log.map(entry => entry.version), [DeliveryFx.V3, DeliveryFx.V2], 'both events, newest first')
            assert.deepEqual(log[1].roleOverridesDropped, [DeliveryFx.ReviewerOverride])
            assert.deepEqual(log[1].rolesRemoved, [DeliveryFx.Reviewers])
            assert.deepEqual(restored.securityChanges?.roleDefaults, [
                { role: BaseRole.BasicUser, concept: DeliveryFx.Review, action: PrivilegeAction.Read, before: AccessLevel.None, after: AccessLevel.BusinessUnit },
                { role: DeliveryFx.Reviewer, concept: DeliveryFx.Review, action: PrivilegeAction.Read, before: AccessLevel.None, after: AccessLevel.Organization },
            ], 'the restored role and contribution are shown as default changes')
            assert.deepEqual(restored.securityChanges?.roleOverridesDropped, [])
        })
    })

    test('in-flight read keeps the old security', async () =>
    {
        await DeliveryFx.Run(async (fx, server) =>
        {
            await fx.Seed([Tier1Fx.Owned(DeliveryFx.Employee, DeliveryFx.E1, Tier1Fx.Alice, DeliveryFx.Sales, { [DeliveryFx.Bonus]: DeliveryFx.BonusValue })])
            const scope = await Tier1Fx.Scope(server, Tier1Fx.Alice)
            const inFlight = await (await Tier1Fx.Engine(server)).BeginRead(scope.Scope, { Connector: scope.Connector })
            try
            {
                assert.equal(await inFlight.GetProperty(DeliveryFx.E1, DeliveryFx.Bonus), null, 'Compensation does not read Bonus yet')
                await DeliveryFx.Applied(fx, DeliveryFx.V2, [DeliveryFx.Hr2, DeliveryFx.Crm1])
                assert.equal(await inFlight.GetProperty(DeliveryFx.E1, DeliveryFx.Bonus), null, 'the reader opened before the deploy keeps the old profile defaults')
            }
            finally
            {
                inFlight.dispose()
            }
            assert.equal(await DeliveryFx.Read(server, Tier1Fx.Alice, DeliveryFx.E1, DeliveryFx.Bonus), DeliveryFx.BonusValue, 'a new reader follows the new ones')
        })
    })

    test('upgrade adding the aspect backfills to the system principal', async () =>
    {
        await DeliveryFx.Run(async (fx, server) =>
        {
            await fx.Seed([
                { Concept: DeliveryFx.Account, Id: DeliveryFx.A1, Properties: { [Tier1Fx.Name]: DeliveryFx.A1 } },
                { Concept: DeliveryFx.Account, Id: DeliveryFx.A2, Properties: { [Tier1Fx.Name]: DeliveryFx.A2 } },
            ])
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Alice, DeliveryFx.Account), [DeliveryFx.A1, DeliveryFx.A2], 'organisation-wide while not owned')
            await DeliveryFx.Applied(fx, DeliveryFx.V2, [DeliveryFx.Hr1, DeliveryFx.Crm2])
            for (const id of [DeliveryFx.A1, DeliveryFx.A2])
            {
                assert.equal(await DeliveryFx.SystemRead(server, id, SystemNames.Owner), SystemPrincipal.IdFor(EnvironmentFixture.TenantId))
                assert.equal(await DeliveryFx.SystemRead(server, id, SystemNames.OwningBusinessUnit), DeliveryFx.Contoso, 'the root business unit')
            }
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Alice, DeliveryFx.Account), [], 'a user-depth BasicUser sees none of the system-owned records')
            const assigned = await server.EnvironmentAssign().Assign(Tier1Fx.Context(Tier1Fx.Admin), { concept: DeliveryFx.Account, id: DeliveryFx.A1, owner: { kind: ShareSubjectKind.Principal, id: Tier1Fx.Alice } })
            assert.equal(assigned.status, AssignStatus.Applied, assigned.reason)
            assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Alice, DeliveryFx.Account), [DeliveryFx.A1], 'visible once assigned')
        })
    })

    test('incompatible deploy leaves the setting untouched', async () =>
    {
        await DeliveryFx.Run(async (fx, server) =>
        {
            const before = await DeliveryFx.Stored(server)
            const result = await DeliveryFx.Deploy(fx, DeliveryFx.OtherApp, DeliveryFx.V1, [DeliveryFx.Hr2])
            assert.equal(result.status, AppWriteStatus.Invalid)
            assert.equal(result.securityChanges, undefined)
            assert.deepEqual(await DeliveryFx.Stored(server), before)
            assert.deepEqual(await server.SecurityChangeLog().List(), [])
        })
    })

    test('promote is logged', async () =>
    {
        await DeliveryFx.Run(async (fx, server) =>
        {
            await server.LoadEnvironmentGraph({ graphName: DeliveryFx.ExtraSet, packages: [DeliveryFx.Contributed(fx, DeliveryFx.Extra)] })
            const log = await server.SecurityChangeLog().List()
            assert.equal(log.length, 1)
            assert.equal(log[0].delivery, DeliveryFx.ExtraSet)
            assert.equal(log[0].version, DeliveryFx.Extra.id + '@' + DeliveryFx.Extra.version)
            assert.deepEqual(log[0].securedFieldsAdded, [{ concept: DeliveryFx.Memo, field: DeliveryFx.Note }])
        })
    })
})
