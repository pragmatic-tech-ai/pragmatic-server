import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FakeTenantApi, TenantTestHost } from '../../../../shell/tests/tenant-test-fixtures.js'
import { UsersAccessSectionService } from '../../users-access-section-service.js'
import { SecurityModelEditorViewModel } from '../security-model-editor-view-model.js'
import { SecurityFixtures } from './security-fixtures.js'

class Fixture
{
    public static async Editor(): Promise<SecurityModelEditorViewModel>
    {
        const api = new FakeTenantApi()
        api.WithEnvironment('alpha')
        api.SecurityModels.set('alpha', SecurityFixtures.Model())
        api.SecurityCatalogs.set('alpha', SecurityFixtures.Catalog())
        const host = new TenantTestHost(api, { envs: true, adopt: true, access: true, settings: true })
        const editor = new SecurityModelEditorViewModel(host.Session, new UsersAccessSectionService(host.Provider))
        await editor.UseEnvironment('alpha')
        return editor
    }
}

describe('AssignmentEditorViewModel', () =>
{
    it('assign role to a team and a user', async () =>
    {
        const editor = await Fixture.Editor()
        editor.SelectedRole = editor.Roles.ToArray().find(r => r.Id === 'Reader')
        const people = editor.RoleAssignment
        people.NewPrincipal = 'dave'
        people.AddPersonCommand.Execute()
        people.AddTeamCommand.Execute()
        assert.deepEqual(editor.Draft?.ToDto().roleAssignments.find(a => a.role === 'Reader'), { role: 'Reader', principalIds: ['dave'], teamIds: ['team-a'] })
        assert.deepEqual(people.TeamRows.ToArray().map(r => r.TeamName), ['Alpha'])
        assert.equal(editor.IsDirty, true)
    })

    it('profile people tab edits profile assignments', async () =>
    {
        const editor = await Fixture.Editor()
        editor.SelectedProfile = editor.Profiles.ToArray().find(p => p.Id === 'hr.Payroll')
        const people = editor.ProfileAssignment
        assert.deepEqual(people.PrincipalRows.ToArray().map(r => r.PrincipalId), ['carol'])
        people.AddTeamCommand.Execute()
        people.PrincipalRows.ToArray()[0].RemoveCommand.Execute()
        const dto = editor.Draft?.ToDto()
        assert.deepEqual(dto?.profileAssignments, [{ profile: 'hr.Payroll', principalIds: [], teamIds: ['team-a'] }])
        assert.deepEqual(dto?.roleAssignments.map(a => a.role), ['projects.ProjectManager'])
    })
})
