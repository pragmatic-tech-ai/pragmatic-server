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
            businessUnits: [{ id: 'bu1', name: 'Root' }, { id: 'bu2', name: 'Child', parent: 'bu1' }, { id: 'bu3', name: 'Other child', parent: 'bu1' }],
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
        org.SetBusinessUnitParent('bu3', 'bu2')
        assert.equal(org.BusinessUnits.find(u => u.id === 'bu3')?.parent, 'bu2')
        assert.equal(org.Dirty, true)
    })

    it('added unit sits under the root', () =>
    {
        const model = Fixtures.Empty()
        const org = new SecurityModelOrg(model)
        const root = org.AddBusinessUnit('Contoso')
        const child = org.AddBusinessUnit('Sales')
        assert.deepEqual(model.businessUnits, [{ id: root, name: 'Contoso' }, { id: child, name: 'Sales', parent: root }])
        assert.equal(org.RootBusinessUnitId, root)
        // A non-root cannot be made parentless (a second root), and the root cannot be re-parented.
        org.SetBusinessUnitParent(child, undefined)
        org.SetBusinessUnitParent(root, child)
        assert.deepEqual(model.businessUnits, [{ id: root, name: 'Contoso' }, { id: child, name: 'Sales', parent: root }])
    })

    it('RenameBusinessUnit renames and marks dirty', () =>
    {
        const org = new SecurityModelOrg(Fixtures.Referenced())
        org.RenameBusinessUnit('bu1', 'HQ')
        assert.equal(org.BusinessUnits[0].name, 'HQ')
        assert.equal(org.Dirty, true)
    })

    it('a unit something depends on cannot be removed', () =>
    {
        const model = Fixtures.Empty()
        model.businessUnits = [{ id: 'root', name: 'Root' }, { id: 'teamed', name: 'Teamed', parent: 'root' },
            { id: 'placed', name: 'Placed', parent: 'root' }, { id: 'parent', name: 'Parent', parent: 'root' }, { id: 'leaf', name: 'Leaf', parent: 'parent' }]
        model.teams = [{ id: 't1', name: 'Team', businessUnitId: 'teamed', idpGroups: [], manualMembers: [] }]
        model.users = [{ principalId: 'u1', businessUnitId: 'placed' }]
        const org = new SecurityModelOrg(model)
        assert.deepEqual(model.businessUnits.map(u => org.CanRemoveBusinessUnit(u.id)), [false, false, false, false, true])
        for (const id of ['root', 'teamed', 'placed', 'parent', 'nope'])
        {
            org.RemoveBusinessUnit(id)
        }
        assert.equal(model.businessUnits.length, 5)
        assert.equal(org.Dirty, false)
        org.RemoveBusinessUnit('leaf')
        assert.deepEqual(model.businessUnits.map(u => u.id), ['root', 'teamed', 'placed', 'parent'])
        assert.equal(org.CanRemoveBusinessUnit('parent'), true)
        assert.equal(org.Dirty, true)
    })

    it('a team is refused while there is no unit to place it in', () =>
    {
        const org = new SecurityModelOrg(Fixtures.Empty())
        assert.equal(org.AddTeam('Ops'), undefined)
        assert.equal(org.Teams.length, 0)
        assert.equal(org.Dirty, false)
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
        noop.SetBusinessUnitParent('nope', 'bu1')
        noop.RemoveBusinessUnit('nope')
        noop.RenameTeam('nope', 'x')
        noop.SetTeamBusinessUnit('nope', 'bu1')
        noop.RemoveTeam('nope')
        assert.equal(noop.Dirty, false)
        const mutations: ((o: SecurityModelOrg) => void)[] = [
            o => o.AddBusinessUnit('n'),
            o => o.RenameBusinessUnit('bu1', 'n'),
            o => o.SetBusinessUnitParent('bu3', 'bu2'),
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

    it('placing a user twice replaces the placement', () =>
    {
        const model = Fixtures.Referenced()
        const org = new SecurityModelOrg(model)
        org.PlaceUser('  alice  ', 'bu1')
        org.PlaceUser('alice', 'bu2')
        assert.deepEqual(model.users, [{ principalId: 'alice', businessUnitId: 'bu2' }])
        const before = JSON.stringify(model)
        org.PlaceUser('   ', 'bu1')
        org.PlaceUser('bob', 'missing')
        assert.equal(JSON.stringify(model), before)
        org.UnplaceUser('alice')
        assert.deepEqual(model.users, [])
    })
})

