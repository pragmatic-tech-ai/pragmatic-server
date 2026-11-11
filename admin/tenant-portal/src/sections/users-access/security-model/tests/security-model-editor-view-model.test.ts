import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantApiError } from '../../../../tenant-api-client.js'
import type { SecurityModelDto } from '../../../../tenant-types.js'
import { PendingWork } from '../../../../shell/holds-pending-work.js'
import { PageState } from '../../../../shell/tenant-page-view-model.js'
import { FakeTenantApi, TenantTestHost, Tick } from '../../../../shell/tests/tenant-test-fixtures.js'
import { UsersAccessSectionService } from '../../users-access-section-service.js'
import { AccessLevel, PrivilegeAction } from '../security-model-enums.js'
import { SecurityModelEditorViewModel } from '../security-model-editor-view-model.js'
import { SecurityFixtures } from './security-fixtures.js'

// SetSecurityModel waits until Release(), so a test can act while a save is in flight.
class GatedSaveApi extends FakeTenantApi
{
    private release: (() => void) | undefined
    private gate: Promise<void> | undefined

    public Hold(): void
    {
        this.gate = new Promise<void>(resolve => { this.release = resolve })
    }

    public Release(): void
    {
        this.release?.()
        this.gate = undefined
    }

    public override async SetSecurityModel(env: string, model: SecurityModelDto): Promise<void>
    {
        if (this.gate !== undefined)
        {
            await this.gate
        }
        await super.SetSecurityModel(env, model)
    }
}

class Fixture
{
    public static async Editor(api: FakeTenantApi = Fixture.Api(), capabilities: { access: boolean } | null = { access: true }): Promise<SecurityModelEditorViewModel>
    {
        const host = new TenantTestHost(api, capabilities === null ? null : { envs: true, adopt: true, access: capabilities.access, settings: true })
        const editor = new SecurityModelEditorViewModel(host.Session, new UsersAccessSectionService(host.Provider))
        await editor.UseEnvironment('alpha')
        return editor
    }

    public static Api(model: SecurityModelDto | null = SecurityFixtures.Model(), api: FakeTenantApi = new FakeTenantApi()): FakeTenantApi
    {
        api.WithEnvironment('alpha').WithEnvironment('beta')
        api.SecurityModels.set('alpha', model)
        api.SecurityCatalogs.set('alpha', SecurityFixtures.Catalog())
        return api
    }

    public static Select(editor: SecurityModelEditorViewModel, role: string): void
    {
        editor.SelectedRole = editor.Roles.ToArray().find(r => r.Id === role)
    }
}

describe('SecurityModelEditorViewModel', () =>
{
    it('loads the setting and the catalog together into the role, field and org surfaces', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        assert.equal(editor.State, PageState.Populated)
        assert.deepEqual(api.Calls.filter(c => c[0] === 'GetSecurityModel' || c[0] === 'GetSecurityCatalog'),
            [['GetSecurityModel', 'alpha'], ['GetSecurityCatalog', 'alpha']])
        assert.deepEqual(editor.Roles.ToArray().map(r => r.Label), [
            'SystemAdministrator \u00b7 0 direct', 'BasicUser \u00b7 0 direct', 'Reader \u00b7 0 direct',
            'projects.ProjectManager \u00b7 1 direct', 'projects.ProjectMember \u00b7 0 direct'])
        assert.equal(editor.SelectedRole?.Id, 'SystemAdministrator')
        Fixture.Select(editor, 'BasicUser')
        assert.deepEqual(editor.PrivilegeRows.ToArray().map(r => r.Concept), ['hr.Department', 'hr.Employee', 'projects.Project'])
        assert.equal(editor.PrivilegeRows.ToArray()[1].Read.Level, AccessLevel.User)
        assert.equal(editor.PrivilegeRows.ToArray()[1].Sentence, 'Can read at user level.')
        assert.equal(editor.SelectedProfile?.Label, 'hr.Payroll')
        assert.equal(editor.FieldRows.ToArray()[0].Label, 'hr.Employee.Salary')
        assert.equal(editor.FieldRows.ToArray()[0].CanRead, true)
        assert.equal(editor.FieldRows.ToArray()[0].CanUpdate, true)
        assert.deepEqual(editor.BusinessUnitRows.ToArray().map(r => [r.Name, r.Depth]), [['Contoso', 0], ['Sales', 1]])
        assert.equal(editor.TeamRows.ToArray()[0].SelectedUnit.Label, 'Sales')
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.SaveStateText, 'No unsaved changes')
        assert.equal(editor.Legend.Count, 5)
    })

    it('loads an environment without a setting as an empty, still editable one', async () =>
    {
        const editor = await Fixture.Editor(Fixture.Api(null))
        assert.equal(editor.State, PageState.Populated)
        assert.equal(editor.HasRoles, true)
        assert.equal(editor.HasNoBusinessUnits, true)
        editor.NewBusinessUnitName = 'Sales'
        editor.AddBusinessUnitCommand.Execute()
        assert.equal(editor.BusinessUnitRows.Count, 1)
        assert.equal(editor.IsDirty, true)
    })

    it('is Empty with no environment and reloads per environment', async () =>
    {
        const api = Fixture.Api()
        const host = new TenantTestHost(api)
        const editor = new SecurityModelEditorViewModel(host.Session, new UsersAccessSectionService(host.Provider))
        await editor.Refresh()
        assert.equal(editor.State, PageState.Empty)
        await editor.UseEnvironment('alpha')
        assert.equal(editor.Roles.Count, 5)
        await editor.UseEnvironment('beta')
        assert.equal(editor.Roles.Count, 0)
        assert.deepEqual(api.Calls.filter(c => c[0] === 'GetSecurityModel').map(c => c[1]), ['alpha', 'beta'])
    })

    it('a matrix cell cycles the levels its concept allows; back at the default the override clears', async () =>
    {
        const editor = await Fixture.Editor()
        Fixture.Select(editor, 'projects.ProjectManager')
        const project = editor.PrivilegeRows.ToArray()[2]
        const cell = project.Read
        assert.equal(cell.Level, AccessLevel.BusinessUnitAndChildren)
        const seen: AccessLevel[] = []
        for (let i = 0; i < 5; i++)
        {
            cell.CycleCommand.Execute()
            seen.push(cell.Level)
            if (i === 0)
            {
                assert.equal(editor.IsDirty, true)
                assert.equal(editor.HasPendingWork, true)
                assert.equal(editor.SaveStateText, 'Unsaved changes')
                assert.equal(editor.SaveCommand.CanExecute(), true)
            }
        }
        assert.deepEqual(seen, [AccessLevel.Organization, AccessLevel.None, AccessLevel.User, AccessLevel.BusinessUnit, AccessLevel.BusinessUnitAndChildren])
        assert.deepEqual(editor.Draft?.ToDto().roleOverrides.filter(r => r.role === 'projects.ProjectManager'), [])
        const department = editor.PrivilegeRows.ToArray()[0].Cell(PrivilegeAction.Invoke)
        department.Cycle()
        assert.equal(department.Level, AccessLevel.Organization)
        department.Cycle()
        assert.equal(department.Level, AccessLevel.None)
    })

    it('offers a unit no parent among itself or its descendants and refuses a cycle', async () =>
    {
        const editor = await Fixture.Editor()
        const [root, child] = editor.BusinessUnitRows.ToArray()
        assert.deepEqual(root.ParentOptions.ToArray().map(o => o.Label), ['(none)'])
        assert.deepEqual(child.ParentOptions.ToArray().map(o => o.Label), ['(none)', 'Contoso'])
        const rows = editor.BusinessUnitRows
        root.SelectedParent = child.SelectedParent
        assert.equal(root.Parent, undefined)
        assert.equal(editor.IsDirty, false)
        child.SelectedParent = child.ParentOptions.ToArray()[0]
        assert.equal(child.Parent, undefined)
        assert.equal(child.Depth, 0)
        assert.equal(editor.BusinessUnitRows, rows)
        assert.deepEqual(root.ParentOptions.ToArray().map(o => o.Label), ['(none)', 'Sales'])
        assert.equal(editor.IsDirty, true)
    })

    it('a rename edits in place and relabels the unit everywhere else', async () =>
    {
        const editor = await Fixture.Editor()
        const rows = editor.BusinessUnitRows
        const child = rows.ToArray()[1]
        child.Name = 'Engineering'
        assert.equal(editor.BusinessUnitRows, rows)
        assert.equal(child.Name, 'Engineering')
        assert.equal(editor.TeamRows.ToArray()[0].SelectedUnit.Label, 'Engineering')
        assert.equal(editor.IsDirty, true)
        const teams = editor.TeamRows
        teams.ToArray()[0].Name = 'Platform'
        assert.equal(editor.TeamRows, teams)
        Fixture.Select(editor, 'projects.ProjectManager')
        assert.deepEqual(editor.RoleAssignment.TeamRows.ToArray().map(r => r.TeamName), ['Platform'])
    })

    it('removing a team drops its role grants', async () =>
    {
        const editor = await Fixture.Editor()
        Fixture.Select(editor, 'projects.ProjectManager')
        assert.equal(editor.RoleAssignment.TeamRows.Count, 1)
        // The root, and Sales (a team and a placed user sit in it), cannot be removed.
        assert.deepEqual(editor.BusinessUnitRows.ToArray().map(r => r.RemoveCommand.CanExecute()), [false, false])
        assert.deepEqual(editor.TeamRows.ToArray()[0].UnitOptions.ToArray().map(o => o.Label), ['Contoso', 'Sales'])
        editor.TeamRows.ToArray()[0].RemoveCommand.Execute()
        assert.equal(editor.TeamRows.Count, 0)
        assert.equal(editor.RoleAssignment.TeamRows.Count, 0)
        assert.deepEqual(editor.Draft?.ToDto().roleAssignments, [{ role: 'projects.ProjectManager', principalIds: ['alice'], teamIds: [] }])
    })

    it('system administrator is not editable', async () =>
    {
        const editor = await Fixture.Editor()
        assert.equal(editor.SelectedRole?.Id, 'SystemAdministrator')
        assert.equal(editor.IsSystemAdministrator, true)
        assert.equal(editor.ShowsMatrix, false)
        assert.equal(editor.SystemAdministratorText, 'Full access to every record and field in this environment. Not editable.')
        const cell = editor.PrivilegeRows.ToArray()[1].Read
        assert.equal(cell.CycleCommand.CanExecute(), false)
        assert.equal(cell.ResetCommand.CanExecute(), false)
        cell.CycleCommand.Execute()
        cell.Cycle()
        cell.Reset()
        assert.equal(editor.IsDirty, false)
        assert.deepEqual(editor.Draft?.ToDto().roleOverrides.filter(r => r.role === 'SystemAdministrator'), [])
        Fixture.Select(editor, 'BasicUser')
        assert.equal(editor.IsSystemAdministrator, false)
        assert.equal(editor.ShowsMatrix, true)
    })

    it('edits are refused without the users-and-access capability', async () =>
    {
        const editor = await Fixture.Editor(Fixture.Api(), { access: false })
        Fixture.Select(editor, 'BasicUser')
        const cell = editor.PrivilegeRows.ToArray()[1].Read
        assert.equal(cell.IsOverridden, true)
        assert.equal(cell.CycleCommand.CanExecute(), false)
        assert.equal(cell.ResetCommand.CanExecute(), false)
        cell.Cycle()
        cell.Reset()
        assert.equal(cell.Level, AccessLevel.User)
        assert.equal(editor.IsDirty, false)
    })

    it('cross-package override is allowed', async () =>
    {
        const editor = await Fixture.Editor()
        Fixture.Select(editor, 'projects.ProjectManager')
        const cell = editor.PrivilegeRows.ToArray()[1].Read
        assert.equal(editor.PrivilegeRows.ToArray()[1].Concept, 'hr.Employee')
        assert.equal(cell.Level, AccessLevel.None)
        cell.Cycle()
        assert.equal(cell.Level, AccessLevel.User)
        assert.equal(cell.IsOverridden, true)
        assert.equal(cell.DefaultText, 'Default: None')
        assert.deepEqual(editor.Draft?.ToDto().roleOverrides.filter(r => r.role === 'projects.ProjectManager'),
            [{ role: 'projects.ProjectManager', concept: 'hr.Employee', action: 'read', level: 'user' }])
    })

    it('organisation-owned concept cycles none and organization only', async () =>
    {
        const editor = await Fixture.Editor()
        Fixture.Select(editor, 'BasicUser')
        const cell = editor.PrivilegeRows.ToArray()[0].Read
        assert.equal(editor.PrivilegeRows.ToArray()[0].Concept, 'hr.Department')
        const seen: AccessLevel[] = []
        for (let i = 0; i < 3; i++)
        {
            cell.Cycle()
            seen.push(cell.Level)
        }
        assert.deepEqual(seen, [AccessLevel.Organization, AccessLevel.None, AccessLevel.Organization])
    })

    it('cycling to the default clears the override', async () =>
    {
        const editor = await Fixture.Editor()
        Fixture.Select(editor, 'BasicUser')
        const cell = editor.PrivilegeRows.ToArray()[1].Read
        assert.equal(cell.IsOverridden, true)
        assert.equal(cell.ResetCommand.CanExecute(), true)
        cell.Cycle()
        assert.equal(cell.Level, AccessLevel.BusinessUnit)
        assert.equal(cell.IsOverridden, false)
        assert.equal(cell.ResetCommand.CanExecute(), false)
        assert.deepEqual(editor.Draft?.ToDto().roleOverrides.filter(r => r.role === 'BasicUser'), [])
    })

    it('assignment editors add and remove people and teams for the selected role and profile', async () =>
    {
        const editor = await Fixture.Editor()
        const people = editor.RoleAssignment
        Fixture.Select(editor, 'Reader')
        assert.equal(people.HasNoAssignments, true)
        people.NewPrincipal = 'p-2'
        people.AddPersonCommand.Execute()
        assert.deepEqual(people.PrincipalRows.ToArray().map(r => r.PrincipalId), ['p-2'])
        assert.equal(editor.Roles.ToArray()[2].Label, 'Reader \u00b7 1 direct')
        assert.deepEqual(people.TeamOptions.ToArray().map(o => o.Label), ['Alpha'])
        people.AddTeamCommand.Execute()
        assert.deepEqual(people.TeamRows.ToArray().map(r => r.TeamName), ['Alpha'])
        assert.equal(people.TeamOptions.Count, 0)
        assert.deepEqual(editor.Draft?.ToDto().roleAssignments.find(a => a.role === 'Reader'), { role: 'Reader', principalIds: ['p-2'], teamIds: ['team-a'] })
        people.PrincipalRows.ToArray()[0].RemoveCommand.Execute()
        people.TeamRows.ToArray()[0].RemoveCommand.Execute()
        assert.equal(people.HasNoAssignments, true)
        assert.equal(editor.Draft?.ToDto().roleAssignments.some(a => a.role === 'Reader'), false)
        editor.ProfileAssignment.NewPrincipal = 'p-7'
        editor.ProfileAssignment.AddPersonCommand.Execute()
        assert.deepEqual(editor.ProfileAssignment.PrincipalRows.ToArray().map(r => r.PrincipalId), ['carol', 'p-7'])
    })

    it('a field checkbox stores a profile override; back at the default it clears', async () =>
    {
        const editor = await Fixture.Editor(Fixture.Api(SecurityFixtures.Empty()))
        const row = editor.FieldRows.ToArray()[0]
        row.CanCreate = true
        assert.equal(row.CanCreate, true)
        assert.deepEqual(editor.Draft?.ToDto().profileOverrides, [{ profile: 'hr.Payroll', concept: 'hr.Employee', field: 'Salary', read: true, update: false, create: true }])
        row.CanCreate = false
        assert.deepEqual(editor.Draft?.ToDto().profileOverrides, [])
    })

    it('Save PUTs the whole setting and rebases (clean after, selections kept)', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        Fixture.Select(editor, 'projects.ProjectManager')
        editor.PrivilegeRows.ToArray()[2].Delete.Cycle()
        editor.NewTeamName = 'Beta'
        editor.AddTeamCommand.Execute()
        editor.SaveCommand.Execute()
        await Tick.Settle()
        const put = api.Calls.find(c => c[0] === 'SetSecurityModel')
        assert.equal(put?.[1], 'alpha')
        const saved = put?.[2] as SecurityModelDto
        assert.deepEqual(saved.roleOverrides.find(r => r.role === 'projects.ProjectManager'), { role: 'projects.ProjectManager', concept: 'projects.Project', action: 'delete', level: 'user' })
        assert.deepEqual(saved.teams.map(t => [t.name, t.businessUnitId]), [['Alpha', 'sales'], ['Beta', 'root']])
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.HasPendingWork, false)
        assert.equal(editor.SelectedRole?.Id, 'projects.ProjectManager')
        assert.equal(editor.SaveCommand.CanExecute(), false)
    })

    it('Discard reloads from the server and drops the edits', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        editor.NewBusinessUnitName = 'Temp'
        editor.AddBusinessUnitCommand.Execute()
        assert.equal(editor.BusinessUnitRows.Count, 3)
        editor.DiscardCommand.Execute()
        await Tick.Settle()
        assert.equal(editor.BusinessUnitRows.Count, 2)
        assert.equal(editor.IsDirty, false)
        assert.equal(api.Count('GetSecurityModel'), 2)
    })

    it('a background reload keeps unsaved work', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        editor.NewBusinessUnitName = 'Temp'
        editor.AddBusinessUnitCommand.Execute()
        await editor.Refresh()
        assert.equal(editor.BusinessUnitRows.Count, 3)
        assert.equal(editor.IsDirty, true)
    })

    it('reports pending work while dirty, and an environment change drops the draft', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        assert.equal(PendingWork.IsHolder(editor), true)
        assert.equal(PendingWork.IsHeldBy(editor), false)
        Fixture.Select(editor, 'BasicUser')
        editor.PrivilegeRows.ToArray()[0].Create.Cycle()
        assert.equal(PendingWork.IsHeldBy(editor), true)
        await editor.UseEnvironment('beta')
        assert.equal(editor.HasPendingWork, false)
        assert.equal(PendingWork.IsHeldBy(editor), false)
        assert.equal(editor.Roles.Count, 0)
        await editor.UseEnvironment('alpha')
        assert.equal(editor.PrivilegeRows.ToArray()[0].Create.Level, AccessLevel.None)
    })

    it('ignores every edit while a save is in flight', async () =>
    {
        const api = Fixture.Api(SecurityFixtures.Model(), new GatedSaveApi()) as GatedSaveApi
        const editor = await Fixture.Editor(api)
        Fixture.Select(editor, 'Reader')
        const cell = editor.PrivilegeRows.ToArray()[2].Create
        cell.Cycle()
        api.Hold()
        editor.SaveCommand.Execute()
        await Tick.Next()
        assert.equal(editor.IsBusy, true)
        assert.equal(editor.SaveCommand.CanExecute(), false)
        cell.Cycle()
        editor.NewBusinessUnitName = 'Late'
        editor.AddBusinessUnitCommand.Execute()
        editor.BusinessUnitRows.ToArray()[0].Name = 'Renamed'
        editor.SelectedRole = editor.Roles.ToArray()[1]
        assert.equal(cell.Level, AccessLevel.User)
        assert.equal(editor.BusinessUnitRows.Count, 2)
        assert.equal(editor.BusinessUnitRows.ToArray()[0].Name, 'Contoso')
        assert.equal(editor.SelectedRole?.Id, 'Reader')
        api.Release()
        await Tick.Settle()
        assert.equal(editor.IsBusy, false)
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.Draft?.Org.BusinessUnits.length, 2)
    })

    it('without the permission: visible, save disabled, edits ignored, reason shown', async () =>
    {
        const editor = await Fixture.Editor(Fixture.Api(), { access: false })
        assert.equal(editor.State, PageState.Populated)
        assert.equal(editor.CanEdit, false)
        assert.match(editor.DeniedReason, /Manage users & access/)
        assert.equal(editor.AddBusinessUnitCommand.CanExecute(), false)
        assert.equal(editor.BusinessUnitRows.ToArray()[0].RemoveCommand.CanExecute(), false)
        editor.NewBusinessUnitName = 'X'
        editor.AddBusinessUnitCommand.Execute()
        editor.BusinessUnitRows.ToArray()[0].Name = 'Renamed'
        editor.FieldRows.ToArray()[0].CanCreate = true
        editor.RoleAssignment.NewPrincipal = 'p-9'
        editor.RoleAssignment.AddPersonCommand.Execute()
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.BusinessUnitRows.Count, 2)
        assert.equal(editor.BusinessUnitRows.ToArray()[0].Name, 'Contoso')
        assert.equal(editor.FieldRows.ToArray()[0].CanCreate, false)
        assert.equal(editor.SaveCommand.CanExecute(), false)
        assert.equal(editor.DiscardCommand.CanExecute(), false)
        editor.SelectedRole = editor.Roles.ToArray()[1]
        assert.equal(editor.SelectedRole?.Id, 'BasicUser')
    })

    it('a 403 on load or on save shows Denied', async () =>
    {
        const api = Fixture.Api()
        api.FailOn.set('GetSecurityModel', new TenantApiError(403, 'forbidden'))
        const denied = await Fixture.Editor(api)
        assert.equal(denied.State, PageState.Denied)

        const saveApi = Fixture.Api()
        const editor = await Fixture.Editor(saveApi)
        Fixture.Select(editor, 'BasicUser')
        editor.PrivilegeRows.ToArray()[0].Create.Cycle()
        saveApi.FailOn.set('SetSecurityModel', new TenantApiError(403, 'forbidden'))
        editor.SaveCommand.Execute()
        await Tick.Settle()
        assert.equal(editor.State, PageState.Denied)
        assert.equal(editor.HasPendingWork, false)
    })

    it('another save failure keeps the edits and reports it', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        Fixture.Select(editor, 'BasicUser')
        editor.PrivilegeRows.ToArray()[0].Create.Cycle()
        api.FailOn.set('SetSecurityModel', new TenantApiError(409, 'conflict'))
        editor.SaveCommand.Execute()
        await Tick.Settle()
        assert.equal(editor.State, PageState.Populated)
        assert.equal(editor.CommandErrorText, 'conflict')
        assert.equal(editor.IsDirty, true)
    })

    it('a load error shows Error with the message', async () =>
    {
        const api = Fixture.Api()
        api.FailOn.set('GetSecurityCatalog', new Error('boom'))
        const editor = await Fixture.Editor(api)
        assert.equal(editor.State, PageState.Error)
        assert.equal(editor.ErrorText, 'boom')
    })

    it('mode and tab labels map to their flags', async () =>
    {
        const editor = await Fixture.Editor()
        assert.deepEqual(editor.ModeLabels.ToArray(), ['Roles', 'Field profiles', 'Organization', 'Changes'])
        assert.equal(editor.IsRolesMode, true)
        editor.SelectedMode = 'Field profiles'
        assert.equal(editor.IsProfilesMode, true)
        editor.SelectedProfileTab = 'People'
        assert.equal(editor.IsProfilePeopleTab, true)
        editor.SelectedMode = 'Changes'
        assert.equal(editor.IsChangesMode, true)
        editor.SelectedMode = 'Organization'
        assert.equal(editor.IsOrganizationMode, true)
        editor.SelectedOrgTab = 'Teams'
        assert.equal(editor.IsTeamsTab, true)
        editor.SelectedRoleTab = 'People'
        assert.equal(editor.IsPeopleTab, true)
        editor.SelectedRoleTab = undefined as unknown as string
        assert.equal(editor.SelectedRoleTab, 'People')
    })
})
