import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { StoragePackageSource } from '@pragmatic-tech-ai/todl'
import { DeliveryChannel, EnvironmentCatalogComposer } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { AccessLevel, BaseRole, IdpDirectorySnapshot, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { SecurityDeployDiff } from '../security-deploy-diff.js'
import { EnvironmentFixture } from './environment-fixture.js'
import type { FixturePackageRef } from './environment-fixture.js'
import { Tier1Fx } from './tier1-fixture.js'

/**
 * The Tier1Fx packages plus their redeploys: hr 2 (BasicUser reads Employee at user depth, a secured Bonus), hr 3
 * (Salary no longer secured), projects 2 (Note and the TaskEditor role gone), crm 2 (Account bound to a connector) and
 * crm 3 (Account owned).
 */
class DiffFx
{
    public static readonly Hr2 = { id: 'hr', version: '2.0.0' }
    public static readonly Hr3 = { id: 'hr', version: '3.0.0' }
    public static readonly Projects2 = { id: 'projects', version: '2.0.0' }
    public static readonly Crm2 = { id: 'crm', version: '2.0.0' }
    public static readonly Crm3 = { id: 'crm', version: '3.0.0' }
    public static readonly Bonus = 'Bonus'
    public static readonly Hr2Todl = `namespace hr
{
    concept Employee : todl.system.Owned { name : string?; secured Salary : number?; secured Bonus : number?; }
    contribute BasicUser { Employee { read = user; create = businessUnit; update = businessUnit; append = businessUnit; appendTo = businessUnit; share = user; assign = businessUnit; } }
    contribute Reader { Employee { read = organization; } }
    profile Compensation { Employee.Salary : read; }
}`
    public static readonly Hr3Todl = `namespace hr
{
    concept Employee : todl.system.Owned { name : string?; Salary : number?; secured Bonus : number?; }
    contribute BasicUser { Employee { read = businessUnit; create = businessUnit; update = businessUnit; append = businessUnit; appendTo = businessUnit; share = user; assign = businessUnit; } }
    contribute Reader { Employee { read = organization; } }
    profile Compensation { Employee.Bonus : read; }
}`
    public static readonly Projects2Todl = `namespace projects
{
    concept Project : todl.system.Owned { name : string?; secured budget : number?; }
    concept Task : todl.system.Owned { name : string?; project : Project?; }
    concept Assignment { from : Task; to : Project; }
    operator ==> : Assignment (from, to);
    role ProjectManager { Project { read = organization; update = businessUnit; append = businessUnit; appendTo = businessUnit; assign = businessUnit; share = businessUnit; } }
    role TaskLinker { Task { read = organization; update = organization; append = organization; } Project { read = organization; appendTo = organization; } }
    profile Staffing { Project.budget : read; }
    contribute BasicUser { Project { read = user; } Task { read = user; update = user; append = user; appendTo = user; } }
}`
    public static readonly Crm2Todl = 'namespace crm {\n  concept Account { name : string?; }\n  datasource src { kind = sql; connection = "crm-db"; }\n'
        + '  model Crm : crm { connect src; populate Account key acc_id { name = "nm"; } }\n}\n'
    public static readonly Crm3Todl = 'namespace crm {\n  concept Account : todl.system.Owned { name : string?; }\n  role AccountReader { Account { read = organization; } }\n}\n'

    public static readonly V1: readonly FixturePackageRef[] = [Tier1Fx.Hr, Tier1Fx.Projects, Tier1Fx.Crm, Tier1Fx.Ext]

    public static async Compose(fx: EnvironmentFixture, refs: readonly FixturePackageRef[]): Promise<IEnvironmentCatalog>
    {
        return EnvironmentCatalogComposer.Compose({
            Deliveries: [{ Channel: DeliveryChannel.Deploy, Name: Tier1Fx.AppName, Packages: refs.map(ref => ({ model: ref.id, version: ref.version })) }],
            Packages: new StoragePackageSource(new NodeFsStorage(fx.PackagesDir)),
        })
    }

    /** `refs` with the package of `replacement`'s id replaced by it. */
    public static With(replacement: FixturePackageRef): FixturePackageRef[]
    {
        return DiffFx.V1.map(ref => ref.id === replacement.id ? replacement : ref)
    }

    public static Diff(current: IEnvironmentCatalog, prospective: IEnvironmentCatalog, setting: ISecurityModelConfig): SecurityDeployDiff
    {
        const model = TenantSecurityModel.FromConfig(setting, IdpDirectorySnapshot.NonAuthoritative(new Date()))
        return SecurityDeployDiff.Compute(current, prospective, setting, model)
    }

    /** The base setting plus the kept override (ProjectManager reads Project at BU depth, §9.2). */
    public static Setting(options: Parameters<typeof Tier1Fx.Setting>[0] = {}): ISecurityModelConfig
    {
        return Tier1Fx.Setting({ ...options, RoleOverrides: [DiffFx.Kept, ...(options.RoleOverrides ?? [])] })
    }

    public static readonly Kept = Tier1Fx.Override(Tier1Fx.ProjectManager, Tier1Fx.Project, PrivilegeAction.Read, AccessLevel.BusinessUnit)
}

describe('security deploy diff', () =>
{
    const fx = new EnvironmentFixture()
    let v1: IEnvironmentCatalog

    before(async () =>
    {
        for (const [ref, todl] of [[Tier1Fx.Hr, Tier1Fx.HrTodl], [Tier1Fx.Projects, Tier1Fx.ProjectsTodl], [Tier1Fx.Crm, Tier1Fx.CrmTodl], [Tier1Fx.Ext, Tier1Fx.ExtTodl],
            [DiffFx.Hr2, DiffFx.Hr2Todl], [DiffFx.Hr3, DiffFx.Hr3Todl], [DiffFx.Projects2, DiffFx.Projects2Todl], [DiffFx.Crm2, DiffFx.Crm2Todl], [DiffFx.Crm3, DiffFx.Crm3Todl]] as const)
        {
            await fx.Package(ref.id, ref.version, todl)
        }
        v1 = await DiffFx.Compose(fx, DiffFx.V1)
    })

    after(async () =>
    {
        await fx.Dispose()
    })

    test('unchanged deploy has an empty diff', async () =>
    {
        const diff = DiffFx.Diff(v1, await DiffFx.Compose(fx, DiffFx.V1), DiffFx.Setting())
        assert.equal(diff.IsEmpty, true)
        assert.deepEqual(diff.NewlyOwned, [])
    })

    test('changed contribution is a role default change and a new secured field is listed', async () =>
    {
        const diff = DiffFx.Diff(v1, await DiffFx.Compose(fx, DiffFx.With(DiffFx.Hr2)), DiffFx.Setting())
        assert.deepEqual(diff.Changes.roleDefaults, [{ role: BaseRole.BasicUser, concept: Tier1Fx.Employee, action: PrivilegeAction.Read, before: AccessLevel.BusinessUnit, after: AccessLevel.User }])
        assert.deepEqual(diff.Changes.securedFieldsAdded, [{ concept: Tier1Fx.Employee, field: DiffFx.Bonus }])
        assert.deepEqual(diff.Changes.securedFieldsRemoved, [])
    })

    test('removed secured flag is listed and its profile override dropped', async () =>
    {
        const salary = { profile: Tier1Fx.Compensation, concept: Tier1Fx.Employee, field: Tier1Fx.Salary, read: true, update: true, create: false }
        const setting = DiffFx.Setting({ ProfileOverrides: [salary] })
        const diff = DiffFx.Diff(v1, await DiffFx.Compose(fx, DiffFx.With(DiffFx.Hr3)), setting)
        assert.deepEqual(diff.Changes.securedFieldsRemoved, [{ concept: Tier1Fx.Employee, field: Tier1Fx.Salary }])
        assert.deepEqual(diff.Changes.profileOverridesDropped, [salary])
        assert.deepEqual(diff.Pruned(setting).profileOverrides, [])
    })

    test('override on a removed concept is dropped; a role no longer shipped is removed with its assignments', async () =>
    {
        const onNote = Tier1Fx.Override(Tier1Fx.ProjectManager, Tier1Fx.Note, PrivilegeAction.Read, AccessLevel.Organization)
        const onEditor = Tier1Fx.Override(Tier1Fx.TaskEditor, Tier1Fx.Task, PrivilegeAction.Read, AccessLevel.BusinessUnit)
        const editors = { role: Tier1Fx.TaskEditor, principalIds: [Tier1Fx.Carol], teamIds: [] }
        const base = Tier1Fx.Setting().roleAssignments
        const setting = DiffFx.Setting({ RoleOverrides: [onNote, onEditor], RoleAssignments: [...base, editors] })
        const diff = DiffFx.Diff(v1, await DiffFx.Compose(fx, DiffFx.With(DiffFx.Projects2)), setting)
        assert.deepEqual(diff.Changes.roleOverridesDropped, [onNote, onEditor])
        assert.deepEqual(diff.Changes.rolesRemoved, [editors])
        const pruned = diff.Pruned(setting)
        assert.deepEqual(pruned.roleOverrides, [DiffFx.Kept], 'kept overrides survive')
        assert.deepEqual(pruned.roleAssignments, base)
        assert.deepEqual(pruned.businessUnits, setting.businessUnits, 'nothing else is pruned')
    })

    test('override on a concept that became external is dropped', async () =>
    {
        const onAccount = Tier1Fx.Override(BaseRole.BasicUser, Tier1Fx.Account, PrivilegeAction.Read, AccessLevel.Organization)
        const setting = DiffFx.Setting({ RoleOverrides: [onAccount] })
        const diff = DiffFx.Diff(v1, await DiffFx.Compose(fx, DiffFx.With(DiffFx.Crm2)), setting)
        assert.deepEqual(diff.Changes.roleOverridesDropped, [onAccount])
        assert.deepEqual(diff.Pruned(setting).roleOverrides, [DiffFx.Kept])
    })

    test('newly owned concept is reported', async () =>
    {
        const diff = DiffFx.Diff(v1, await DiffFx.Compose(fx, DiffFx.With(DiffFx.Crm3)), DiffFx.Setting())
        assert.deepEqual(diff.NewlyOwned, [Tier1Fx.Account])
        assert.deepEqual(diff.Changes.roleOverridesDropped, [])
    })
})
