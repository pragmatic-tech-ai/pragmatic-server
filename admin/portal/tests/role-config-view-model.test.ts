import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SecurityModelDto } from '../src/portal-types.js'
import { RoleAccessLevel, RoleAction, RoleConfigViewModel } from '../src/role-config-view-model.js'
import type { IRoleConfigSource } from '../src/role-config-view-model.js'

class FakeSource implements IRoleConfigSource
{
    public Sets: Array<{ name: string; model: SecurityModelDto }> = []
    public Gets: string[] = []

    public constructor(public Current: SecurityModelDto | null | undefined, public Fail?: Error)
    {
    }

    public async GetSecurityModel(name: string): Promise<SecurityModelDto | null | undefined>
    {
        this.Gets.push(name)
        if (this.Fail !== undefined)
        {
            throw this.Fail
        }
        return this.Current
    }

    public async SetSecurityModel(name: string, model: SecurityModelDto): Promise<void>
    {
        this.Sets.push({ name, model })
    }
}

class FailingSaveSource extends FakeSource
{
    public override async SetSecurityModel(): Promise<void>
    {
        throw new Error('rejected')
    }
}

class Fixtures
{
    public static Model(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: 'root', name: 'Root' }],
            teams: [],
            membership: { claimsMapping: [], overrides: [] },
            ownershipRules: [],
            roles: [{
                id: 'sales',
                name: 'Sales',
                privileges: [
                    { action: 'create', concept: 'Order', level: 'user' },
                    { action: 'read', concept: 'Order', level: 'organization' },
                    { action: 'update', concept: 'Order', level: 'user' },
                    { action: 'delete', concept: 'Order', level: 'none' },
                    { action: 'share', concept: 'Order', level: 'user' }
                ]
            }]
        }
    }
}

describe('RoleConfigViewModel', () =>
{
    it('Open loads the model and populates rows', async () =>
    {
        const source = new FakeSource(Fixtures.Model())
        const vm = new RoleConfigViewModel(source, 'env1')
        await vm.Open()
        assert.deepEqual(source.Gets, ['env1'])
        assert.equal(vm.Rows.length, 1)
        assert.equal(vm.Rows[0]!.RoleId, 'sales')
        assert.equal(vm.Rows[0]!.Concept, 'Order')
        assert.equal(vm.Rows[0]!.Levels[RoleAction.Read], RoleAccessLevel.Organization)
        assert.equal(vm.Rows[0]!.Levels[RoleAction.Delete], RoleAccessLevel.None)
    })

    it('Save sends the edited model; a changed level round-trips and other privileges survive', async () =>
    {
        const source = new FakeSource(Fixtures.Model())
        const vm = new RoleConfigViewModel(source, 'env1')
        await vm.Open()
        vm.SetLevel('sales', 'Order', RoleAction.Delete, RoleAccessLevel.BusinessUnit)
        assert.equal(await vm.Save(), true)
        assert.equal(source.Sets.length, 1)
        assert.equal(source.Sets[0]!.name, 'env1')
        const privileges = source.Sets[0]!.model.roles![0]!.privileges
        assert.equal(privileges.find(p => p.action === 'delete')!.level, 'businessUnit')
        assert.equal(privileges.find(p => p.action === 'share')!.level, 'user')
        assert.deepEqual(source.Sets[0]!.model.businessUnits, [{ id: 'root', name: 'Root' }])
        assert.equal(vm.Status, RoleConfigViewModel.SavedStatus)
    })

    it('starts from an empty editable model when none is stored (null or undefined)', async () =>
    {
        for (const none of [null, undefined])
        {
            const source = new FakeSource(none)
            const vm = new RoleConfigViewModel(source, 'env1')
            await vm.Open()
            assert.equal(vm.Rows.length, 0)
            vm.AddRoleConcept('admin', 'Admin', 'Account')
            vm.SetLevel('admin', 'Account', RoleAction.Read, RoleAccessLevel.Organization)
            vm.AssignRole('user-1', 'admin')
            vm.AssignRole('user-1', 'admin')
            await vm.Save()
            const sent = source.Sets[0]!.model
            assert.equal(sent.roles![0]!.privileges.length, 4)
            assert.equal(sent.roles![0]!.privileges.find(p => p.action === 'read')!.level, 'organization')
            assert.deepEqual(sent.roleAssignment!.overrides, [{ principalId: 'user-1', roles: ['admin'] }])
        }
    })

    it('surfaces load errors in Status', async () =>
    {
        const vm = new RoleConfigViewModel(new FakeSource(null, new Error('boom')), 'env1')
        await vm.Open()
        assert.equal(vm.Status, RoleConfigViewModel.ErrorPrefix + 'boom')
    })

    it('a failed Save returns false and surfaces the error status', async () =>
    {
        const vm = new RoleConfigViewModel(new FailingSaveSource(Fixtures.Model()), 'env1')
        await vm.Open()
        assert.equal(await vm.Save(), false)
        assert.equal(vm.Status, RoleConfigViewModel.ErrorPrefix + 'rejected')
    })

    it('rejects empty or whitespace role id, concept and principal', async () =>
    {
        const vm = new RoleConfigViewModel(new FakeSource(Fixtures.Model()), 'env1')
        await vm.Open()
        vm.AddRoleConcept('  ', 'x', 'Order')
        assert.equal(vm.Status, RoleConfigViewModel.EmptyInputStatus)
        vm.AddRoleConcept('sales', 'Sales', ' ')
        assert.equal(vm.Status, RoleConfigViewModel.EmptyInputStatus)
        vm.AssignRole(' ', 'sales')
        assert.equal(vm.Status, RoleConfigViewModel.EmptyInputStatus)
        assert.deepEqual(vm.RoleIds, ['sales'])
        assert.equal(vm.Assignments.length, 0)
    })

    it('rejects assigning an unknown role', async () =>
    {
        const vm = new RoleConfigViewModel(new FakeSource(Fixtures.Model()), 'env1')
        await vm.Open()
        vm.AssignRole('user-1', 'ghost')
        assert.equal(vm.Status, RoleConfigViewModel.UnknownRoleStatus + 'ghost')
        assert.equal(vm.Assignments.length, 0)
    })

    it('after a failed load Rows are cleared and Save is refused', async () =>
    {
        const source = new FakeSource(Fixtures.Model())
        const vm = new RoleConfigViewModel(source, 'env1')
        await vm.Open()
        assert.equal(vm.Rows.length, 1)
        source.Fail = new Error('boom')
        await vm.Open()
        assert.equal(vm.Rows.length, 0)
        assert.equal(vm.CanSave, false)
        assert.equal(await vm.Save(), false)
        assert.equal(source.Sets.length, 0)
        assert.equal(vm.Status, RoleConfigViewModel.NotLoadedStatus)
    })
})
