import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccessLevel, FieldPermission, PrivilegeAction } from '../security-model-enums.js'
import { SecurityModelDraft } from '../security-model-draft.js'
import { FieldAccess } from '../security-overrides.js'
import { SecurityFixtures } from './security-fixtures.js'

class Draft
{
    public static Empty(): SecurityModelDraft
    {
        return new SecurityModelDraft(SecurityFixtures.Empty(), SecurityFixtures.Catalog())
    }
}

describe('SecurityOverrides', () =>
{
    it('override differing from default is stored', () =>
    {
        const draft = Draft.Empty()
        const o = draft.Overrides
        assert.equal(o.DefaultLevel('projects.ProjectManager', 'projects.Project', PrivilegeAction.Read), AccessLevel.BusinessUnitAndChildren)
        o.SetLevel('projects.ProjectManager', 'projects.Project', PrivilegeAction.Read, AccessLevel.BusinessUnit)
        assert.deepEqual(draft.ToDto().roleOverrides, [{ role: 'projects.ProjectManager', concept: 'projects.Project', action: 'read', level: 'businessUnit' }])
        assert.equal(o.OverrideLevel('projects.ProjectManager', 'projects.Project', PrivilegeAction.Read), AccessLevel.BusinessUnit)
        assert.equal(o.EffectiveLevel('projects.ProjectManager', 'projects.Project', PrivilegeAction.Read), AccessLevel.BusinessUnit)
        assert.equal(draft.Dirty, true)
    })

    it('override equal to default is removed', () =>
    {
        const draft = Draft.Empty()
        const o = draft.Overrides
        o.SetLevel('projects.ProjectManager', 'projects.Project', PrivilegeAction.Read, AccessLevel.BusinessUnit)
        o.SetLevel('projects.ProjectManager', 'projects.Project', PrivilegeAction.Read, AccessLevel.BusinessUnitAndChildren)
        assert.deepEqual(draft.ToDto().roleOverrides, [])
        assert.equal(o.OverrideLevel('projects.ProjectManager', 'projects.Project', PrivilegeAction.Read), undefined)
        // A concept the role has no default for defaults to None: setting None stores nothing.
        o.SetLevel('projects.ProjectManager', 'hr.Employee', PrivilegeAction.Delete, AccessLevel.None)
        assert.deepEqual(draft.ToDto().roleOverrides, [])
    })

    it('reset removes the override', () =>
    {
        const draft = new SecurityModelDraft(SecurityFixtures.Model(), SecurityFixtures.Catalog())
        const o = draft.Overrides
        assert.equal(o.EffectiveLevel('BasicUser', 'hr.Employee', PrivilegeAction.Read), AccessLevel.User)
        o.Reset('BasicUser', 'hr.Employee', PrivilegeAction.Read)
        assert.equal(o.EffectiveLevel('BasicUser', 'hr.Employee', PrivilegeAction.Read), AccessLevel.BusinessUnit)
        assert.deepEqual(draft.ToDto().roleOverrides, [])
        o.ResetField('hr.Payroll', 'hr.Employee', 'Salary')
        assert.deepEqual(draft.ToDto().profileOverrides, [])
        assert.deepEqual(o.EffectiveField('hr.Payroll', 'hr.Employee', 'Salary'), new FieldAccess(true, false, false))
    })

    it('organisation-owned concept allows none and organization only', () =>
    {
        const o = Draft.Empty().Overrides
        assert.equal(o.IsOrganizationOwned('hr.Department'), true)
        assert.deepEqual(o.AllowedLevels('hr.Department'), [AccessLevel.None, AccessLevel.Organization])
        assert.equal(o.IsOrganizationOwned('projects.Project'), false)
        assert.equal(o.AllowedLevels('projects.Project').length, 5)
    })

    it('field override equal to default is removed', () =>
    {
        const draft = Draft.Empty()
        const o = draft.Overrides
        o.SetField('hr.Payroll', 'hr.Employee', 'Salary', FieldPermission.Update, true)
        assert.deepEqual(draft.ToDto().profileOverrides, [{ profile: 'hr.Payroll', concept: 'hr.Employee', field: 'Salary', read: true, update: true, create: false }])
        o.SetField('hr.Payroll', 'hr.Employee', 'Salary', FieldPermission.Update, false)
        assert.deepEqual(draft.ToDto().profileOverrides, [])
        assert.equal(o.OverrideField('hr.Payroll', 'hr.Employee', 'Salary'), undefined)
    })
})
