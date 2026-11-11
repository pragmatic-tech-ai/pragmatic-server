import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SecurityRoleKind, type SecurityCatalogDto, type SecurityModelDto } from '../../../../tenant-types.js'
import { FakeTenantApi, TenantTestHost } from '../../../../shell/tests/tenant-test-fixtures.js'
import { UsersAccessSectionService } from '../../users-access-section-service.js'
import { SecurityModelEditorViewModel } from '../security-model-editor-view-model.js'
import { FieldGrantRowViewModel } from '../security-model-role-rows.js'

class Fixture
{
    private static readonly Salary = { concept: 'hr.Employee', field: 'Salary' }
    private static readonly Bonus = { concept: 'hr.Employee', field: 'Bonus' }
    private static readonly Budget = { concept: 'projects.Project', field: 'Budget' }

    // Two packages' secured fields; Compensation grants Salary read+update by default.
    public static Catalog(): SecurityCatalogDto
    {
        return {
            roles: [{ name: 'BasicUser', kind: SecurityRoleKind.Base, defaults: [] }],
            concepts: [
                { name: 'hr.Employee', package: 'hr', owned: true },
                { name: 'projects.Project', package: 'projects', owned: true },
            ],
            securedFields: [Fixture.Budget, Fixture.Salary, Fixture.Bonus],
            profiles: [
                { name: 'hr.Compensation', package: 'hr', defaults: [{ ...Fixture.Salary, read: true, update: true, create: false }] },
                { name: 'projects.Finance', package: 'projects', defaults: [{ ...Fixture.Budget, read: true, update: false, create: false }] },
            ],
        }
    }

    public static async Editor(access = true): Promise<SecurityModelEditorViewModel>
    {
        const api = new FakeTenantApi()
        api.WithEnvironment('alpha')
        const model: SecurityModelDto = { businessUnits: [], users: [], teams: [], roleAssignments: [], profileAssignments: [], roleOverrides: [], profileOverrides: [] }
        api.SecurityModels.set('alpha', model)
        api.SecurityCatalogs.set('alpha', Fixture.Catalog())
        const host = new TenantTestHost(api, { envs: true, adopt: true, access, settings: true })
        const editor = new SecurityModelEditorViewModel(host.Session, new UsersAccessSectionService(host.Provider))
        await editor.UseEnvironment('alpha')
        return editor
    }

    public static Select(editor: SecurityModelEditorViewModel, profile: string): void
    {
        editor.SelectedProfile = editor.Profiles.ToArray().find(p => p.Id === profile)
    }

    public static Row(editor: SecurityModelEditorViewModel, label: string): FieldGrantRowViewModel
    {
        return editor.FieldRows.ToArray().find(r => r.Label === label) as FieldGrantRowViewModel
    }
}

describe('profile field overrides', () =>
{
    it('unchecking a default grant stores an override', async () =>
    {
        const editor = await Fixture.Editor()
        Fixture.Select(editor, 'hr.Compensation')
        const row = Fixture.Row(editor, 'hr.Employee.Salary')
        row.CanRead = false
        // Read cleared with update: a write never stands without read (PR8), so update goes too.
        assert.deepEqual(editor.Draft?.ToDto().profileOverrides, [{ profile: 'hr.Compensation', concept: 'hr.Employee', field: 'Salary', read: false, update: false, create: false }])
        assert.equal(row.IsOverridden, true)
    })

    it('cross-package profile override is allowed', async () =>
    {
        const editor = await Fixture.Editor()
        Fixture.Select(editor, 'projects.Finance')
        Fixture.Row(editor, 'hr.Employee.Salary').CanRead = true
        assert.deepEqual(editor.Draft?.ToDto().profileOverrides, [{ profile: 'projects.Finance', concept: 'hr.Employee', field: 'Salary', read: true, update: false, create: false }])
    })

    it('only secured fields are listed', async () =>
    {
        const editor = await Fixture.Editor()
        Fixture.Select(editor, 'hr.Compensation')
        // The catalog's secured fields, concept then field; nothing else (profile defaults add no rows).
        assert.deepEqual(editor.FieldRows.ToArray().map(r => r.Label), ['hr.Employee.Bonus', 'hr.Employee.Salary', 'projects.Project.Budget'])
    })

    it('an override never means write without read', async () =>
    {
        const editor = await Fixture.Editor()
        Fixture.Select(editor, 'hr.Compensation')
        const bonus = Fixture.Row(editor, 'hr.Employee.Bonus')
        bonus.CanCreate = true
        assert.equal(bonus.CanRead, true)
        assert.deepEqual(editor.Draft?.ToDto().profileOverrides, [{ profile: 'hr.Compensation', concept: 'hr.Employee', field: 'Bonus', read: true, update: false, create: true }])
        bonus.CanRead = false
        assert.deepEqual([bonus.CanRead, bonus.CanUpdate, bonus.CanCreate], [false, false, false])
        const salary = Fixture.Row(editor, 'hr.Employee.Salary')
        salary.CanRead = false
        assert.deepEqual([salary.CanRead, salary.CanUpdate, salary.CanCreate], [false, false, false])
    })

    it('field edits are refused without the users-and-access capability', async () =>
    {
        const editor = await Fixture.Editor(false)
        Fixture.Select(editor, 'hr.Compensation')
        const row = Fixture.Row(editor, 'hr.Employee.Salary')
        assert.equal(row.IsEditable, false)
        row.CanRead = false
        assert.equal(row.CanRead, true)
        assert.equal(editor.IsDirty, false)
        assert.equal(row.ResetCommand.CanExecute(), false)
    })
})
