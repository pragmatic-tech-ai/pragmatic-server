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
            ownershipRules: [{ concept: 'Zeta', owningBusinessUnit: 'bu1' }],
            roles: [
                { id: 'r1', name: 'Admin', privileges: [
                    { action: 'read', concept: 'Order', level: 'organization' },
                    { action: 'create', concept: 'Order', level: 'bogus' }] },
                { id: 'r2', name: 'Viewer', privileges: [{ action: 'read', concept: 'Alpha', level: 'user' }] }
            ],
            roleAssignment: { byUser: { u1: ['r1'] } },
            fieldSecurity: { securedFields: [{ concept: 'Mid', field: 'x' }], profiles: [], profileAssignment: {} }
        } as unknown as SecurityModelDto
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
})
