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
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: 'u1', roles: ['r1'] }], teamRoles: [{ teamId: 't1', roles: ['r1'] }, { teamId: 't2', roles: ['r1'] }] },
            fieldSecurity: { securedFields: [{ concept: 'Mid', field: 'x' }], profiles: [], profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [{ teamId: 't1', profiles: ['p'] }, { teamId: 't2', profiles: ['p'] }] } }
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
        assert.equal(model.businessUnits[0].parent, undefined)
        assert.equal(model.teams[0].owningBusinessUnit, undefined)
        assert.equal(model.teams[1].owningBusinessUnit, 'bu2')
        assert.equal(model.membership.claimsMapping[0].homeBusinessUnit, undefined)
        assert.equal(model.membership.overrides[0].homeBusinessUnit, undefined)
        assert.deepEqual(model.ownershipRules[0].owningBusinessUnit, { kind: '', value: '' })
        assert.equal(model.ownershipRules[0].owner, undefined)
        assert.equal(org.Dirty, true)
    })

    it('RemoveBusinessUnit resets only the matching ownership source', () =>
    {
        const model = Fixtures.Referenced()
        model.ownershipRules = [
            { concept: 'A', owningBusinessUnit: { kind: 'fixed', value: 'bu1' } },
            { concept: 'B', owningBusinessUnit: { kind: 'fixed', value: 'bu2' }, owner: { kind: 'field', value: 'bu1' } }
        ]
        new SecurityModelOrg(model).RemoveBusinessUnit('bu1')
        assert.deepEqual(model.ownershipRules[0].owningBusinessUnit, { kind: '', value: '' })
        assert.deepEqual(model.ownershipRules[1].owningBusinessUnit, { kind: 'fixed', value: 'bu2' })
        assert.equal(model.ownershipRules[1].owner, undefined)
    })

    it('rejects self-parenting, deep cycles and survives a pre-existing cycle', () =>
    {
        const model = Fixtures.Empty()
        model.businessUnits = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parent: 'a' }, { id: 'c', name: 'C', parent: 'b' },
            { id: 'x', name: 'X', parent: 'y' }, { id: 'y', name: 'Y', parent: 'x' }, { id: 'z', name: 'Z' }]
        const org = new SecurityModelOrg(model)
        org.SetBusinessUnitParent('a', 'a')
        org.SetBusinessUnitParent('a', 'c')
        assert.equal(model.businessUnits[0].parent, undefined)
        assert.equal(org.Dirty, false)
        org.SetBusinessUnitParent('z', 'x')
        assert.equal(model.businessUnits[5].parent, 'x')
    })

    it('ignores unknown parent and unknown owning business unit', () =>
    {
        const model = Fixtures.Referenced()
        const org = new SecurityModelOrg(model)
        org.SetBusinessUnitParent('bu2', 'nope')
        org.SetTeamOwningBusinessUnit('t1', 'nope')
        assert.equal(model.businessUnits[1].parent, 'bu1')
        assert.equal(model.teams[0].owningBusinessUnit, 'bu1')
        assert.equal(org.Dirty, false)
    })

    it('Dirty flips after each mutation kind and not on unknown ids', () =>
    {
        const noop = new SecurityModelOrg(Fixtures.Referenced())
        noop.RenameBusinessUnit('nope', 'x')
        noop.SetBusinessUnitParent('nope', undefined)
        noop.RemoveBusinessUnit('nope')
        noop.RenameTeam('nope', 'x')
        noop.SetTeamOwningBusinessUnit('nope', undefined)
        noop.RemoveTeam('nope')
        assert.equal(noop.Dirty, false)
        const mutations: ((o: SecurityModelOrg) => void)[] = [
            o => o.AddBusinessUnit('n'),
            o => o.RenameBusinessUnit('bu1', 'n'),
            o => o.SetBusinessUnitParent('bu2', undefined),
            o => o.RemoveBusinessUnit('bu2'),
            o => o.AddTeam('n'),
            o => o.RenameTeam('t1', 'n'),
            o => o.SetTeamOwningBusinessUnit('t1', 'bu2'),
            o => o.RemoveTeam('t1')
        ]
        for (const mutate of mutations)
        {
            const org = new SecurityModelOrg(Fixtures.Referenced())
            assert.equal(org.Dirty, false)
            mutate(org)
            assert.equal(org.Dirty, true)
        }
    })

    it('RemoveTeam also drops team role and profile grants', () =>
    {
        const model = Fixtures.Referenced()
        const draft = SecurityModelDraft.From(model)
        draft.Org.RemoveTeam('t1')
        const out = draft.ToDto()
        assert.deepEqual(out.roleAssignment?.teamRoles.map(g => g.teamId), ['t2'])
        assert.deepEqual(out.fieldSecurity?.profileAssignment.teamProfiles.map(g => g.teamId), ['t2'])
        assert.equal(JSON.stringify(out).includes('"t1"'), false)
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
