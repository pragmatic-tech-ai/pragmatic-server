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
    public static Model(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: 'bu-root', name: 'Root' }, { id: 'bu-child', name: 'Child', parent: 'bu-root' }],
            teams: [{ id: 'team-a', name: 'Alpha', owningBusinessUnit: 'bu-child' }],
            membership: {
                claimsMapping: [{ claim: 'dept', value: 'eng', homeBusinessUnit: 'bu-child', teams: ['team-a'] }],
                overrides: [{ principalId: 'p-9', homeBusinessUnit: 'bu-root' }],
            },
            ownershipRules: [{ concept: 'capability', owningBusinessUnit: { kind: 'claim', value: 'bu-root' } }],
            roles: [
                { id: 'role-reader', name: 'Reader', privileges: [{ action: 'read', concept: 'capability', level: 'user' }] },
                { id: 'role-writer', name: 'Writer', privileges: [] },
            ],
            roleAssignment: { claimsMapping: [{ claim: 'grp', value: 'r', roles: ['role-reader'] }], overrides: [{ principalId: 'p-1', roles: ['role-reader'] }], teamRoles: [{ teamId: 'team-a', roles: ['role-reader'] }] },
            fieldSecurity: {
                securedFields: [{ concept: 'capability', field: 'cost' }],
                profiles: [{ id: 'profile-finance-1', name: 'Finance', grants: [{ concept: 'capability', field: 'cost', read: true }] }],
                profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] },
            },
        }
    }

    public static async Editor(api: FakeTenantApi = Fixture.Api(), capabilities: { access: boolean } | null = { access: true }): Promise<SecurityModelEditorViewModel>
    {
        const host = new TenantTestHost(api, capabilities === null ? null : { envs: true, adopt: true, access: capabilities.access, settings: true })
        const editor = new SecurityModelEditorViewModel(host.Session, new UsersAccessSectionService(host.Provider))
        await editor.UseEnvironment('alpha')
        return editor
    }

    public static Api(model: SecurityModelDto | null = Fixture.Model()): FakeTenantApi
    {
        const api = new FakeTenantApi().WithEnvironment('alpha').WithEnvironment('beta')
        api.SecurityModels.set('alpha', model)
        return api
    }
}

describe('SecurityModelEditorViewModel', () =>
{
    it('loads the selected environment into the role, field and org surfaces', async () =>
    {
        const editor = await Fixture.Editor()
        assert.equal(editor.State, PageState.Populated)
        assert.deepEqual(editor.Roles.ToArray().map(r => r.Label), ['Reader \u00b7 1 direct', 'Writer \u00b7 0 direct'])
        assert.equal(editor.SelectedRole?.Id, 'role-reader')
        assert.deepEqual(editor.PrivilegeRows.ToArray().map(r => r.Concept), ['capability'])
        assert.equal(editor.PrivilegeRows.ToArray()[0].Read.Level, AccessLevel.User)
        assert.equal(editor.PrivilegeRows.ToArray()[0].Sentence, 'Can read at user level.')
        assert.equal(editor.SelectedProfile?.Label, 'Finance')
        assert.equal(editor.FieldRows.ToArray()[0].Label, 'capability.cost')
        assert.equal(editor.FieldRows.ToArray()[0].CanRead, true)
        assert.deepEqual(editor.BusinessUnitRows.ToArray().map(r => [r.Name, r.Depth]), [['Root', 0], ['Child', 1]])
        assert.equal(editor.TeamRows.ToArray()[0].SelectedUnit.Label, 'Child')
        assert.equal(editor.RoleHoldersHeadline, '1 assigned directly, also granted by 1 claim rule and 1 team')
        assert.equal(editor.RecordSharingRows.ToArray()[0].ScopeText, 'only records they own (user) (records owned per the ownership rules)')
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.SaveStateText, 'No unsaved changes')
        assert.equal(editor.Legend.Count, 5)
    })

    it('loads an environment without a model as an empty, still editable model', async () =>
    {
        const editor = await Fixture.Editor(Fixture.Api(null))
        assert.equal(editor.State, PageState.Populated)
        assert.equal(editor.HasNoRoles, true)
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
        assert.equal(editor.Roles.Count, 2)
        await editor.UseEnvironment('beta')
        assert.equal(editor.Roles.Count, 0)
        assert.deepEqual(api.Calls.filter(c => c[0] === 'GetSecurityModel').map(c => c[1]), ['alpha', 'beta'])
    })

    it('a matrix cell cycles None -> User -> ... -> Organization -> None and marks dirty', async () =>
    {
        const editor = await Fixture.Editor()
        const cell = editor.PrivilegeRows.ToArray()[0].Create
        const seen: AccessLevel[] = []
        for (let i = 0; i < 5; i++)
        {
            cell.CycleCommand.Execute()
            seen.push(cell.Level)
        }
        assert.deepEqual(seen, [AccessLevel.User, AccessLevel.BusinessUnit, AccessLevel.BusinessUnitAndChildren, AccessLevel.Organization, AccessLevel.None])
        cell.CycleCommand.Execute()
        assert.equal(cell.Glyph, '\u25d4')
        assert.equal(editor.IsDirty, true)
        assert.equal(editor.HasPendingWork, true)
        assert.equal(editor.SaveStateText, 'Unsaved changes')
        assert.equal(editor.SaveCommand.CanExecute(), true)
        assert.match(editor.PrivilegeRows.ToArray()[0].Sentence, /^Can create at user level and read at user level\.$/)
    })

    it('a cell edit keeps the matrix rows and refreshes record sharing', async () =>
    {
        const editor = await Fixture.Editor()
        const rows = editor.PrivilegeRows
        rows.ToArray()[0].Cell(PrivilegeAction.Share).Cycle()
        assert.equal(editor.PrivilegeRows, rows)
        assert.equal(editor.RecordSharingRows.ToArray()[0].CanShare, true)
    })

    it('adds and deletes roles; selection falls back and the matrix follows', async () =>
    {
        const editor = await Fixture.Editor()
        editor.NewRoleName = '  Auditor  '
        editor.AddRoleCommand.Execute()
        assert.equal(editor.Roles.Count, 3)
        assert.equal(editor.SelectedRoleName, 'Auditor')
        assert.equal(editor.NewRoleName, '')
        editor.NewRoleName = '   '
        editor.AddRoleCommand.Execute()
        assert.equal(editor.Roles.Count, 3)
        editor.DeleteRoleCommand.Execute()
        assert.deepEqual(editor.Roles.ToArray().map(r => r.Id), ['role-reader', 'role-writer'])
        assert.equal(editor.SelectedRole?.Id, 'role-reader')
        editor.SelectedRole = editor.Roles.ToArray()[1]
        assert.equal(editor.SelectedRoleName, 'Writer')
        assert.equal(editor.PrivilegeRows.ToArray()[0].Read.Level, AccessLevel.None)
        assert.equal(editor.RoleHoldersHeadline, 'No one is assigned this role yet.')
    })

    it('adds a concept to the matrix', async () =>
    {
        const editor = await Fixture.Editor()
        editor.NewConceptName = 'process'
        editor.AddConceptCommand.Execute()
        assert.deepEqual(editor.PrivilegeRows.ToArray().map(r => r.Concept), ['capability', 'process'])
        assert.equal(editor.NewConceptName, '')
    })

    it('removing a business unit cascades to teams, membership and ownership rules', async () =>
    {
        const editor = await Fixture.Editor()
        editor.BusinessUnitRows.ToArray()[0].RemoveCommand.Execute()
        assert.deepEqual(editor.BusinessUnitRows.ToArray().map(r => [r.Name, r.Depth, r.SelectedParent?.Label]), [['Child', 0, '(none)']])
        assert.equal(editor.MembershipOverrideRows.ToArray()[0].SelectedHomeUnit.Label, '(none)')
        assert.equal(editor.OwnershipRuleRows.ToArray()[0].OwningValue, '')
        assert.equal(editor.IsDirty, true)
    })

    it('removing a team cascades to membership and role grants', async () =>
    {
        const editor = await Fixture.Editor()
        assert.equal(editor.MembershipRuleRows.ToArray()[0].TeamToggles.ToArray()[0].IsChecked, true)
        editor.TeamRows.ToArray()[0].RemoveCommand.Execute()
        assert.equal(editor.TeamRows.Count, 0)
        assert.equal(editor.MembershipRuleRows.ToArray()[0].TeamToggles.Count, 0)
        assert.equal(editor.RoleAssignment.TeamRows.Count, 0)
        assert.equal(editor.RoleHoldersHeadline, '1 assigned directly, also granted by 1 claim rule')
    })

    it('offers a unit no parent among itself or its descendants and refuses a cycle', async () =>
    {
        const editor = await Fixture.Editor()
        const [root, child] = editor.BusinessUnitRows.ToArray()
        assert.deepEqual(root.ParentOptions.ToArray().map(o => o.Label), ['(none)'])
        assert.deepEqual(child.ParentOptions.ToArray().map(o => o.Label), ['(none)', 'Root'])
        const rows = editor.BusinessUnitRows
        root.SelectedParent = child.SelectedParent
        assert.equal(root.Parent, undefined)
        assert.equal(editor.IsDirty, false)
        child.SelectedParent = child.ParentOptions.ToArray()[0]
        assert.equal(child.Parent, undefined)
        assert.equal(child.Depth, 0)
        assert.equal(editor.BusinessUnitRows, rows)
        assert.deepEqual(root.ParentOptions.ToArray().map(o => o.Label), ['(none)', 'Child'])
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
        assert.equal(editor.MembershipRuleRows.ToArray()[0].TeamToggles.ToArray()[0].TeamName, 'Platform')
    })

    it('assignment editors add and remove people, claims and teams for the selected role', async () =>
    {
        const editor = await Fixture.Editor()
        const people = editor.RoleAssignment
        editor.SelectedRole = editor.Roles.ToArray()[1]
        assert.equal(people.HasNoAssignments, true)
        people.NewPrincipal = 'p-2'
        people.AddPersonCommand.Execute()
        assert.deepEqual(people.PrincipalRows.ToArray().map(r => r.PrincipalId), ['p-2'])
        assert.equal(editor.Roles.ToArray()[1].Label, 'Writer \u00b7 1 direct')
        people.AddClaimCommand.Execute()
        const claim = people.ClaimRows.ToArray()[0]
        claim.Claim = 'dept'
        claim.Value = 'ops'
        assert.equal(people.ClaimRows.ToArray()[0], claim)
        assert.deepEqual(people.TeamOptions.ToArray().map(o => o.Label), ['Alpha'])
        people.AddTeamCommand.Execute()
        assert.deepEqual(people.TeamRows.ToArray().map(r => r.TeamName), ['Alpha'])
        assert.equal(people.TeamOptions.Count, 0)
        assert.equal(editor.RoleHoldersHeadline, '1 assigned directly, also granted by 1 claim rule and 1 team')
        const saved = editor.Draft?.ToDto().roleAssignment
        assert.deepEqual(saved?.claimsMapping.find(c => c.roles.includes('role-writer')), { claim: 'dept', value: 'ops', roles: ['role-writer'] })
        people.PrincipalRows.ToArray()[0].RemoveCommand.Execute()
        people.TeamRows.ToArray()[0].RemoveCommand.Execute()
        people.ClaimRows.ToArray()[0].RemoveCommand.Execute()
        assert.equal(people.HasNoAssignments, true)
    })

    it('field profiles: add, toggle a grant, add and remove a secured field, delete', async () =>
    {
        const editor = await Fixture.Editor()
        const row = editor.FieldRows.ToArray()[0]
        row.CanUpdate = true
        assert.equal(row.CanUpdate, true)
        editor.NewFieldConcept = 'process'
        editor.NewFieldName = 'owner'
        editor.AddSecuredFieldCommand.Execute()
        assert.deepEqual(editor.FieldRows.ToArray().map(r => r.Label), ['capability.cost', 'process.owner'])
        editor.FieldRows.ToArray()[1].RemoveCommand.Execute()
        assert.equal(editor.FieldRows.Count, 1)
        editor.NewProfileName = 'HR'
        editor.AddProfileCommand.Execute()
        assert.equal(editor.SelectedProfile?.Label, 'HR')
        assert.equal(editor.FieldRows.ToArray()[0].CanRead, false)
        editor.ProfileAssignment.NewPrincipal = 'p-7'
        editor.ProfileAssignment.AddPersonCommand.Execute()
        assert.deepEqual(editor.ProfileAssignment.PrincipalRows.ToArray().map(r => r.PrincipalId), ['p-7'])
        editor.DeleteProfileCommand.Execute()
        assert.equal(editor.SelectedProfile?.Label, 'Finance')
    })

    it('membership and ownership rows edit in place; adds and removes rebuild', async () =>
    {
        const editor = await Fixture.Editor()
        const rules = editor.MembershipRuleRows
        rules.ToArray()[0].Claim = 'department'
        rules.ToArray()[0].TeamToggles.ToArray()[0].IsChecked = false
        assert.equal(editor.MembershipRuleRows, rules)
        assert.equal(editor.Draft?.Org.Membership.claimsMapping[0].claim, 'department')
        assert.equal(editor.Draft?.Org.Membership.claimsMapping[0].teams, undefined)
        editor.AddMembershipRuleCommand.Execute()
        editor.AddMembershipOverrideCommand.Execute()
        assert.equal(editor.MembershipRuleRows.Count, 2)
        assert.equal(editor.MembershipOverrideRows.Count, 2)
        editor.MembershipRuleRows.ToArray()[0].RemoveCommand.Execute()
        editor.MembershipRuleRows.ToArray()[0].Value = 'v2'
        assert.equal(editor.Draft?.Org.Membership.claimsMapping[0].value, 'v2')
        editor.NewOwnershipConcept = 'process'
        editor.AddOwnershipRuleCommand.Execute()
        const rule = editor.OwnershipRuleRows.ToArray()[1]
        rule.OwnerKind = 'claim'
        rule.OwnerValue = 'sub'
        assert.deepEqual(editor.Draft?.Org.OwnershipRules[1].owner, { kind: 'claim', value: 'sub' })
        rule.RemoveCommand.Execute()
        assert.equal(editor.OwnershipRuleRows.Count, 1)
    })

    it('Save PUTs the whole model and rebases (clean after, selections kept)', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        editor.SelectedRole = editor.Roles.ToArray()[1]
        editor.PrivilegeRows.ToArray()[0].Delete.Cycle()
        editor.NewTeamName = 'Beta'
        editor.AddTeamCommand.Execute()
        editor.SaveCommand.Execute()
        await Tick.Settle()
        const put = api.Calls.find(c => c[0] === 'SetSecurityModel')
        assert.equal(put?.[1], 'alpha')
        const saved = put?.[2] as SecurityModelDto
        assert.deepEqual(saved.roles?.[1].privileges, [{ action: 'delete', concept: 'capability', level: 'user' }])
        assert.deepEqual(saved.teams.map(t => t.name), ['Alpha', 'Beta'])
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.HasPendingWork, false)
        assert.equal(editor.SelectedRole?.Id, 'role-writer')
        assert.equal(editor.SaveCommand.CanExecute(), false)
    })

    it('Discard reloads from the server and drops the edits', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        editor.NewRoleName = 'Temp'
        editor.AddRoleCommand.Execute()
        assert.equal(editor.Roles.Count, 3)
        editor.DiscardCommand.Execute()
        await Tick.Settle()
        assert.equal(editor.Roles.Count, 2)
        assert.equal(editor.IsDirty, false)
        assert.equal(api.Count('GetSecurityModel'), 2)
    })

    it('a background reload keeps unsaved work', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        editor.NewRoleName = 'Temp'
        editor.AddRoleCommand.Execute()
        await editor.Refresh()
        assert.equal(editor.Roles.Count, 3)
        assert.equal(editor.IsDirty, true)
    })

    it('reports pending work while dirty, and an environment change drops the draft', async () =>
    {
        const api = Fixture.Api()
        const editor = await Fixture.Editor(api)
        assert.equal(PendingWork.IsHolder(editor), true)
        assert.equal(PendingWork.IsHeldBy(editor), false)
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
        const api = new GatedSaveApi().WithEnvironment('alpha')
        api.SecurityModels.set('alpha', Fixture.Model())
        const editor = await Fixture.Editor(api)
        const cell = editor.PrivilegeRows.ToArray()[0].Create
        cell.Cycle()
        api.Hold()
        editor.SaveCommand.Execute()
        await Tick.Next()
        assert.equal(editor.IsBusy, true)
        assert.equal(editor.SaveCommand.CanExecute(), false)
        cell.Cycle()
        editor.NewRoleName = 'Late'
        editor.AddRoleCommand.Execute()
        editor.BusinessUnitRows.ToArray()[0].Name = 'Renamed'
        editor.SelectedRole = editor.Roles.ToArray()[1]
        assert.equal(cell.Level, AccessLevel.User)
        assert.equal(editor.Roles.Count, 2)
        assert.equal(editor.BusinessUnitRows.ToArray()[0].Name, 'Root')
        assert.equal(editor.SelectedRole?.Id, 'role-reader')
        api.Release()
        await Tick.Settle()
        assert.equal(editor.IsBusy, false)
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.Draft?.Roles.length, 2)
    })

    it('without the permission: visible, save disabled, edits ignored, reason shown', async () =>
    {
        const editor = await Fixture.Editor(Fixture.Api(), { access: false })
        assert.equal(editor.State, PageState.Populated)
        assert.equal(editor.CanEdit, false)
        assert.match(editor.DeniedReason, /Manage users & access/)
        assert.equal(editor.AddRoleCommand.CanExecute(), false)
        assert.equal(editor.PrivilegeRows.ToArray()[0].Create.CycleCommand.CanExecute(), false)
        assert.equal(editor.BusinessUnitRows.ToArray()[0].RemoveCommand.CanExecute(), false)
        editor.PrivilegeRows.ToArray()[0].Create.Cycle()
        editor.NewRoleName = 'X'
        editor.AddRoleCommand.Execute()
        editor.BusinessUnitRows.ToArray()[0].Name = 'Renamed'
        editor.FieldRows.ToArray()[0].CanCreate = true
        editor.RoleAssignment.AddClaimCommand.Execute()
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.Roles.Count, 2)
        assert.equal(editor.BusinessUnitRows.ToArray()[0].Name, 'Root')
        assert.equal(editor.FieldRows.ToArray()[0].CanCreate, false)
        assert.equal(editor.SaveCommand.CanExecute(), false)
        assert.equal(editor.DiscardCommand.CanExecute(), false)
        editor.SelectedRole = editor.Roles.ToArray()[1]
        assert.equal(editor.SelectedRole?.Id, 'role-writer')
    })

    it('a 403 on load or on save shows Denied', async () =>
    {
        const api = Fixture.Api()
        api.FailOn.set('GetSecurityModel', new TenantApiError(403, 'forbidden'))
        const denied = await Fixture.Editor(api)
        assert.equal(denied.State, PageState.Denied)

        const saveApi = Fixture.Api()
        const editor = await Fixture.Editor(saveApi)
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
        api.FailOn.set('GetSecurityModel', new Error('boom'))
        const editor = await Fixture.Editor(api)
        assert.equal(editor.State, PageState.Error)
        assert.equal(editor.ErrorText, 'boom')
    })

    it('mode and tab labels map to their flags', async () =>
    {
        const editor = await Fixture.Editor()
        assert.deepEqual(editor.ModeLabels.ToArray(), ['Roles', 'Organization'])
        assert.equal(editor.IsRolesMode, true)
        editor.SelectedMode = 'Organization'
        assert.equal(editor.IsOrganizationMode, true)
        editor.SelectedOrgTab = 'Membership'
        assert.equal(editor.IsMembershipTab, true)
        editor.SelectedRoleTab = 'People'
        assert.equal(editor.IsPeopleTab, true)
        editor.SelectedRoleTab = undefined as unknown as string
        assert.equal(editor.SelectedRoleTab, 'People')
    })
})
