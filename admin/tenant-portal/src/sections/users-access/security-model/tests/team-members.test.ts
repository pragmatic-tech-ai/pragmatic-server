import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TeamMemberOrigin, type SecurityModelDto } from '../../../../tenant-types.js'
import { PageState } from '../../../../shell/tenant-page-view-model.js'
import { FakeTenantApi, TenantTestHost, Tick } from '../../../../shell/tests/tenant-test-fixtures.js'
import { UsersAccessSectionService } from '../../users-access-section-service.js'
import { SecurityModelEditorViewModel } from '../security-model-editor-view-model.js'
import type { TeamRowViewModel } from '../security-model-org-rows.js'
import { SecurityFixtures } from './security-fixtures.js'

class Fixture
{
    private static readonly Environment = 'alpha'
    private static readonly TeamId = 'team-a'

    // Team "Alpha" with IdP group grp-alpha and manual member `a`; the server lists `a` both ways.
    public static async Team(serverRows = [
        { principalId: 'a', origin: TeamMemberOrigin.Synced },
        { principalId: 'a', origin: TeamMemberOrigin.Manual },
    ]): Promise<{ editor: SecurityModelEditorViewModel, api: FakeTenantApi, team: () => TeamRowViewModel }>
    {
        const api = new FakeTenantApi()
        api.WithEnvironment(Fixture.Environment)
        const model: SecurityModelDto = SecurityFixtures.Model()
        model.teams[0].manualMembers = ['a']
        api.SecurityModels.set(Fixture.Environment, model)
        api.SecurityCatalogs.set(Fixture.Environment, SecurityFixtures.Catalog())
        api.TeamMembers.set(Fixture.Environment, new Map([[Fixture.TeamId, serverRows]]))
        const host = new TenantTestHost(api, { envs: true, adopt: true, access: true, settings: true })
        const editor = new SecurityModelEditorViewModel(host.Session, new UsersAccessSectionService(host.Provider))
        await editor.UseEnvironment(Fixture.Environment)
        return { editor, api, team: () => editor.TeamRows.ToArray()[0] }
    }

    public static Rows(team: TeamRowViewModel): Array<[string, TeamMemberOrigin]>
    {
        return team.Members.ToArray().map(m => [m.PrincipalId, m.Origin])
    }
}

describe('team members', () =>
{
    it('both origins show two rows', async () =>
    {
        const { editor, team } = await Fixture.Team()
        team().LoadMembersCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(Fixture.Rows(team()), [['a', TeamMemberOrigin.Synced], ['a', TeamMemberOrigin.Manual]])
        team().Members.ToArray()[1].RemoveCommand.Execute()
        assert.deepEqual(Fixture.Rows(team()), [['a', TeamMemberOrigin.Synced]])
        assert.deepEqual(editor.Draft?.Org.Teams[0].manualMembers, [])
        assert.equal(editor.IsDirty, true)
    })

    it('synced member cannot be removed', async () =>
    {
        const { editor, team } = await Fixture.Team()
        team().LoadMembersCommand.Execute()
        await Tick.Settle()
        const synced = team().Members.ToArray()[0]
        assert.equal(synced.CanRemove, false)
        assert.equal(synced.RemoveCommand.CanExecute(), false)
        synced.Remove()
        assert.equal(editor.IsDirty, false)
        assert.equal(team().Members.Count, 2)
    })

    it('removing an IdP group link keeps manual members', async () =>
    {
        const { editor, team } = await Fixture.Team()
        team().IdpGroups.ToArray()[0].RemoveCommand.Execute()
        assert.deepEqual(editor.Draft?.Org.Teams[0].idpGroups, [])
        assert.deepEqual(editor.Draft?.Org.Teams[0].manualMembers, ['a'])
        assert.deepEqual(Fixture.Rows(team()), [['a', TeamMemberOrigin.Manual]])
    })

    it('members load failure shows the error text and keeps the draft', async () =>
    {
        const { editor, api, team } = await Fixture.Team()
        team().NewManualMember = 'b'
        team().AddManualMemberCommand.Execute()
        api.FailOn.set('ListTeamMembers', new Error('members unavailable'))
        team().LoadMembersCommand.Execute()
        await Tick.Settle()
        assert.equal(team().MembersErrorText, 'members unavailable')
        assert.equal(editor.State, PageState.Populated)
        assert.deepEqual(editor.Draft?.Org.Teams[0].manualMembers, ['a', 'b'])
        assert.equal(editor.IsDirty, true)
    })
})
