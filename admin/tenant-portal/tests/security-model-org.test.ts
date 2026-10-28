import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SecurityModelOrg } from '../src/security-model-org.js'
import { SecurityModelDraft } from '../src/security-model-draft.js'
import type { SecurityModelDto } from '../src/tenant-types.js'

class Fixtures
{
    public static Empty(): SecurityModelDto
    {
        return { businessUnits: [], teams: [], membership: { claimsMapping: [], overrides: [] }, ownershipRules: [] }
    }

    public static Referenced(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: 'bu1', name: 'Root' }, { id: 'bu2', name: 'Child', parent: 'bu1' }],
            teams: [{ id: 't1', name: 'Team', owningBusinessUnit: 'bu1' }, { id: 't2', name: 'Other', owningBusinessUnit: 'bu2' }],
            membership: {
                claimsMapping: [{ claim: 'dept', value: 'x', homeBusinessUnit: 'bu1', teams: ['t1', 't2'] }],
                overrides: [{ principalId: 'u1', homeBusinessUnit: 'bu1', teams: ['t1'] }]
            },
            ownershipRules: [{ concept: 'Order', owningBusinessUnit: { kind: 'fixed', value: 'bu1' }, owner: { kind: 'fixed', value: 'bu1' } }],
            roles: [{ id: 'r1', name: 'Admin', privileges: [] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: 'u1', roles: ['r1'] }], teamRoles: [] },
            fieldSecurity: { securedFields: [{ concept: 'Mid', field: 'x' }], profiles: [], profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] } }
        }
    }
}

describe('SecurityModelOrg', () =>
{
    it('is clean over an unedited model', () =>
    {
        assert.equal(new SecurityModelOrg(Fixtures.Empty()).Dirty, false)
    })

    it('AddBusinessUnit mints unique ids and marks dirty', () =>
    {
        const org = new SecurityModelOrg(Fixtures.Empty())
        const a = org.AddBusinessUnit('Sales East')
        const b = org.AddBusinessUnit('Sales East')
        assert.equal(a, 'bu-sales-east-1')
        assert.notEqual(a, b)
        assert.equal(org.BusinessUnits.length, 2)
        assert.equal(org.Dirty, true)
    })

    it('SetBusinessUnitParent sets parent and refuses cycles', () =>
    {
        const org = new SecurityModelOrg(Fixtures.Referenced())
        org.SetBusinessUnitParent('bu1', 'bu2')
        assert.equal(org.BusinessUnits.find(u => u.id === 'bu1')?.parent, undefined)
        assert.equal(org.Dirty, false)
        org.SetBusinessUnitParent('bu2', undefined)
        assert.equal(org.BusinessUnits.find(u => u.id === 'bu2')?.parent, undefined)
        assert.equal(org.Dirty, true)
    })

    it('RenameBusinessUnit renames and marks dirty', () =>
    {
        const org = new SecurityModelOrg(Fixtures.Referenced())
        org.RenameBusinessUnit('bu1', 'HQ')
        assert.equal(org.BusinessUnits[0].name, 'HQ')
        assert.equal(org.Dirty, true)
    })

    it('RemoveBusinessUnit clears every reference', () =>
    {
        const model = Fixtures.Referenced()
        const org = new SecurityModelOrg(model)
        org.RemoveBusinessUnit('bu1')
        assert.deepEqual(org.BusinessUnits.map(u => u.id), ['bu2'])
        assert.equal(model.teams[0].owningBusinessUnit, undefined)
        assert.equal(model.teams[1].owningBusinessUnit, 'bu2')
        assert.equal(model.membership.claimsMapping[0].homeBusinessUnit, undefined)
        assert.equal(model.membership.overrides[0].homeBusinessUnit, undefined)
        assert.deepEqual(model.ownershipRules[0].owningBusinessUnit, { kind: '', value: '' })
        assert.equal(model.ownershipRules[0].owner, undefined)
        assert.equal(org.Dirty, true)
    })

    it('team operations behave and RemoveTeam clears membership references', () =>
    {
        const model = Fixtures.Referenced()
        const org = new SecurityModelOrg(model)
        const id = org.AddTeam('Ops Crew')
        assert.equal(id, 'team-ops-crew-1')
        org.RenameTeam(id, 'Ops')
        org.SetTeamOwningBusinessUnit(id, 'bu2')
        const t = org.Teams.find(x => x.id === id)
        assert.equal(t?.name, 'Ops')
        assert.equal(t?.owningBusinessUnit, 'bu2')
        org.SetTeamOwningBusinessUnit(id, undefined)
        assert.equal(org.Teams.find(x => x.id === id)?.owningBusinessUnit, undefined)
        org.RemoveTeam('t1')
        assert.equal(org.Teams.some(x => x.id === 't1'), false)
        assert.deepEqual(model.membership.claimsMapping[0].teams, ['t2'])
        assert.deepEqual(model.membership.overrides[0].teams, [])
        assert.equal(org.Dirty, true)
    })
})

describe('SecurityModelDraft org wiring', () =>
{
    it('Dirty aggregates org edits and other sections round-trip', () =>
    {
        const input = Fixtures.Referenced()
        const draft = SecurityModelDraft.From(input)
        assert.equal(draft.Dirty, false)
        draft.Org.AddBusinessUnit('New')
        assert.equal(draft.Dirty, true)
        const out = draft.ToDto()
        assert.deepEqual(out.teams, input.teams)
        assert.deepEqual(out.membership, input.membership)
        assert.deepEqual(out.ownershipRules, input.ownershipRules)
        assert.deepEqual(out.roles, input.roles)
        assert.deepEqual(out.roleAssignment, input.roleAssignment)
        assert.deepEqual(out.fieldSecurity, input.fieldSecurity)
        assert.equal(out.businessUnits.length, 3)
        assert.equal(input.businessUnits.length, 2)
    })
})
