import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SecurityModelOrg } from '../security-model-org.js'
import type { SecurityModelDto } from '../../../../tenant-types.js'

class Fixtures
{
    public static Empty(): SecurityModelDto
    {
        return { businessUnits: [], users: [], teams: [], roleAssignments: [], profileAssignments: [], roleOverrides: [], profileOverrides: [] }
    }

    public static Referenced(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: 'bu1', name: 'Root' }, { id: 'bu2', name: 'Child', parent: 'bu1' }],
            users: [],
            teams: [
                { id: 't1', name: 'Team', businessUnitId: 'bu1', idpGroups: [], manualMembers: [] },
                { id: 't2', name: 'Other', businessUnitId: 'bu2', idpGroups: [], manualMembers: [] },
            ],
            roleAssignments: [{ role: 'r1', principalIds: ['u1'], teamIds: ['t1', 't2'] }],
            profileAssignments: [{ profile: 'p', principalIds: [], teamIds: ['t1', 't2'] }],
            roleOverrides: [],
            profileOverrides: [],
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

    it('RemoveBusinessUnit detaches its child units', () =>
    {
        const model = Fixtures.Referenced()
        const org = new SecurityModelOrg(model)
        org.RemoveBusinessUnit('bu1')
        assert.deepEqual(org.BusinessUnits.map(u => u.id), ['bu2'])
        assert.equal(model.businessUnits[0].parent, undefined)
        assert.equal(org.Dirty, true)
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

    it('ignores unknown parent and unknown team business unit', () =>
    {
        const model = Fixtures.Referenced()
        const org = new SecurityModelOrg(model)
        org.SetBusinessUnitParent('bu2', 'nope')
        org.SetTeamBusinessUnit('t1', 'nope')
        assert.equal(model.businessUnits[1].parent, 'bu1')
        assert.equal(model.teams[0].businessUnitId, 'bu1')
        assert.equal(org.Dirty, false)
    })

    it('Dirty flips after each mutation kind and not on unknown ids', () =>
    {
        const noop = new SecurityModelOrg(Fixtures.Referenced())
        noop.RenameBusinessUnit('nope', 'x')
        noop.SetBusinessUnitParent('nope', undefined)
        noop.RemoveBusinessUnit('nope')
        noop.RenameTeam('nope', 'x')
        noop.SetTeamBusinessUnit('nope', 'bu1')
        noop.RemoveTeam('nope')
        assert.equal(noop.Dirty, false)
        const mutations: ((o: SecurityModelOrg) => void)[] = [
            o => o.AddBusinessUnit('n'),
            o => o.RenameBusinessUnit('bu1', 'n'),
            o => o.SetBusinessUnitParent('bu2', undefined),
            o => o.RemoveBusinessUnit('bu2'),
            o => o.AddTeam('n'),
            o => o.RenameTeam('t1', 'n'),
            o => o.SetTeamBusinessUnit('t1', 'bu2'),
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

    it('team operations behave and RemoveTeam drops its role and profile grants', () =>
    {
        const model = Fixtures.Referenced()
        const org = new SecurityModelOrg(model)
        const id = org.AddTeam('Ops Crew')
        assert.equal(id, 'team-ops-crew-1')
        org.RenameTeam(id, 'Ops')
        org.SetTeamBusinessUnit(id, 'bu2')
        const t = org.Teams.find(x => x.id === id)
        assert.equal(t?.name, 'Ops')
        assert.equal(t?.businessUnitId, 'bu2')
        org.RemoveTeam('t1')
        assert.equal(org.Teams.some(x => x.id === 't1'), false)
        assert.deepEqual(model.roleAssignments[0].teamIds, ['t2'])
        assert.deepEqual(model.profileAssignments[0].teamIds, ['t2'])
        assert.equal(org.Dirty, true)
    })
})

