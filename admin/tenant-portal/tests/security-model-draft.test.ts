import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccessLevel, PrivilegeAction, SecurityModelDraft } from '../src/security-model-draft.js'
import type { SecurityModelDto } from '../src/tenant-types.js'

class Fixtures
{
    public static Full(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: 'bu1', name: 'Root' }],
            teams: [{ id: 't1', name: 'Team' }],
            membership: { claimsMapping: [], overrides: [] },
            ownershipRules: [{ concept: 'Zeta', owningBusinessUnit: { kind: 'fixed', value: 'bu1' } }],
            roles: [
                { id: 'r1', name: 'Admin', privileges: [
                    { action: 'read', concept: 'Order', level: 'organization' },
                    { action: 'create', concept: 'Order', level: 'bogus' }] },
                { id: 'r2', name: 'Viewer', privileges: [{ action: 'read', concept: 'Alpha', level: 'user' }] }
            ],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: 'u1', roles: ['r1'] }], teamRoles: [] },
            fieldSecurity: { securedFields: [{ concept: 'Mid', field: 'x' }], profiles: [], profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] } }
        }
    }
}

describe('SecurityModelDraft', () =>
{
    it('From(null) is empty and clean', () =>
    {
        const d = SecurityModelDraft.From(null)
        assert.equal(d.Roles.length, 0)
        assert.equal(d.Concepts.length, 0)
        assert.equal(d.Dirty, false)
    })

    it('derives sorted deduped concept union', () =>
    {
        assert.deepEqual(SecurityModelDraft.From(Fixtures.Full()).Concepts, ['Alpha', 'Mid', 'Order', 'Zeta'])
    })

    it('LevelFor normalizes absent and garbage to None', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Full())
        d.SelectedRoleId = 'r1'
        assert.equal(d.LevelFor('Order', PrivilegeAction.Read), AccessLevel.Organization)
        assert.equal(d.LevelFor('Order', PrivilegeAction.Create), AccessLevel.None)
        assert.equal(d.LevelFor('Order', PrivilegeAction.Delete), AccessLevel.None)
    })

    it('CycleLevel advances and wraps, sets Dirty', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Full())
        d.SelectedRoleId = 'r1'
        assert.equal(d.Dirty, false)
        assert.equal(d.CycleLevel('Zeta', PrivilegeAction.Read), AccessLevel.User)
        assert.equal(d.CycleLevel('Zeta', PrivilegeAction.Read), AccessLevel.BusinessUnit)
        assert.equal(d.CycleLevel('Zeta', PrivilegeAction.Read), AccessLevel.BusinessUnitAndChildren)
        assert.equal(d.CycleLevel('Zeta', PrivilegeAction.Read), AccessLevel.Organization)
        assert.equal(d.CycleLevel('Zeta', PrivilegeAction.Read), AccessLevel.None)
        assert.equal(d.Dirty, true)
    })

    it('AddRole/AddConcept/DeleteRole work from absent roles', () =>
    {
        const m = Fixtures.Full()
        delete m.roles
        const d = SecurityModelDraft.From(m)
        const id = d.AddRole('Power User')
        assert.equal(id, 'role-power-user-1')
        assert.equal(d.AddRole('Power User'), 'role-power-user-2')
        assert.equal(d.SelectedRoleId, 'role-power-user-2')
        d.AddConcept('Brand')
        assert.ok(d.Concepts.includes('Brand'))
        assert.equal(d.LevelFor('Brand', PrivilegeAction.Share), AccessLevel.None)
        d.DeleteRole(id)
        assert.equal(d.Roles.length, 1)
    })

    it('round-trips untouched sections and never mutates the input', () =>
    {
        const input = Fixtures.Full()
        const snapshot = structuredClone(input)
        const d = SecurityModelDraft.From(input)
        d.SelectedRoleId = 'r2'
        d.CycleLevel('Alpha', PrivilegeAction.Read)
        const out = d.ToDto()
        assert.deepEqual(input, snapshot)
        assert.deepEqual(out.businessUnits, snapshot.businessUnits)
        assert.deepEqual(out.teams, snapshot.teams)
        assert.deepEqual(out.membership, snapshot.membership)
        assert.deepEqual(out.ownershipRules, snapshot.ownershipRules)
        assert.deepEqual(out.roleAssignment, snapshot.roleAssignment)
        assert.deepEqual(out.fieldSecurity, snapshot.fieldSecurity)
        assert.deepEqual(out.roles![0], snapshot.roles![0])
        assert.deepEqual(out.roles![1].privileges, [{ action: 'read', concept: 'Alpha', level: 'businessUnit' }])
        assert.notEqual(out.roles![0], d.Roles[0])
    })

    it('None removes all matching entries but keeps the row', () =>
    {
        const m = Fixtures.Full()
        m.roles![0].privileges.push({ action: 'read', concept: 'Order', level: 'user' })
        const d = SecurityModelDraft.From(m)
        d.SelectedRoleId = 'r1'
        d.SetLevel('Order', PrivilegeAction.Read, AccessLevel.None)
        const out = d.ToDto()
        assert.deepEqual(out.roles![0].privileges, [{ action: 'create', concept: 'Order', level: 'bogus' }])
        assert.ok(d.Concepts.includes('Order'))
    })

    it('keeps roles absent or empty as loaded', () =>
    {
        const a = Fixtures.Full()
        delete a.roles
        assert.equal('roles' in SecurityModelDraft.From(a).ToDto(), false)
        const e = Fixtures.Full()
        e.roles = []
        assert.deepEqual(SecurityModelDraft.From(e).ToDto().roles, [])
    })

    it('ToDto reflects AddRole and DeleteRole with other sections unchanged', () =>
    {
        const input = Fixtures.Full()
        const snap = structuredClone(input)
        const d = SecurityModelDraft.From(input)
        const id = d.AddRole('New')
        d.DeleteRole('r2')
        const out = d.ToDto()
        assert.deepEqual(out.roles!.map(r => r.id), ['r1', id])
        assert.deepEqual(out.roles![1].privileges, [])
        assert.deepEqual(out.fieldSecurity, snap.fieldSecurity)
        assert.deepEqual(out.roleAssignment, snap.roleAssignment)
        assert.deepEqual(out.businessUnits, snap.businessUnits)
    })

    it('overwrites a garbage stored level when edited', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Full())
        d.SelectedRoleId = 'r1'
        assert.equal(d.CycleLevel('Order', PrivilegeAction.Create), AccessLevel.User)
        const out = d.ToDto()
        assert.deepEqual(out.roles![0].privileges.filter(p => p.action === 'create'), [{ action: 'create', concept: 'Order', level: 'user' }])
        assert.equal(JSON.stringify(out).includes('bogus'), false)
    })

    it('AddConcept sets Dirty', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Full())
        d.AddConcept('Brand')
        assert.equal(d.Dirty, true)
    })
})
