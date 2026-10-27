import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccessLevel, PrivilegeAction } from '../src/security-model-draft.js'
import { RolesPrivilegesState, RolesPrivilegesViewModel } from '../src/roles-privileges-view-model.js'
import type { IRolesPrivilegesSource } from '../src/roles-privileges-view-model.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { EnvStatus, EnvType, Template } from '../src/tenant-types.js'
import type { EnvironmentDto, SecurityModelDto } from '../src/tenant-types.js'

class Make
{
    public static Env(name: string): EnvironmentDto
    {
        return { name, template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'id-' + name, hostPort: 1, status: EnvStatus.Running, createdAt: '', httpUrl: '', wsUrl: '' }
    }

    public static Model(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: 'bu1', name: 'Root' } as never],
            teams: [{ id: 't1', name: 'Team One', owningBusinessUnit: 'bu1' }],
            membership: { claimsMapping: [{ claim: 'groups', value: 'ops', team: 't1' } as never], overrides: [] },
            ownershipRules: [{ concept: 'Order' } as never],
            roleAssignment: { claimsMapping: [{ claim: 'groups', value: 'ops', role: 'r1' } as never], overrides: [], teamRoles: [{ team: 't1', role: 'r2' } as never] },
            fieldSecurity: {
                securedFields: [{ concept: 'Customer', field: 'ssn' }],
                profiles: [{ id: 'p1', name: 'Full', grants: [] }],
                profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] }
            },
            roles: [
                { id: 'r1', name: 'Admin', privileges: [{ action: PrivilegeAction.Read, concept: 'Customer', level: AccessLevel.User }] },
                { id: 'r2', name: 'Viewer', privileges: [] }
            ]
        }
    }
}

class FakeSource implements IRolesPrivilegesSource
{
    public Envs: EnvironmentDto[] = [Make.Env('envA'), Make.Env('envB')]
    public Model: SecurityModelDto | null = Make.Model()
    public GetError: Error | undefined
    public SetError: Error | undefined
    public Saved: Array<{ env: string; model: SecurityModelDto }> = []
    public Deferred: Array<{ env: string; resolve: (m: SecurityModelDto | null) => void }> | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return this.Envs
    }

    public async GetSecurityModel(env: string): Promise<SecurityModelDto | null>
    {
        if (this.Deferred !== undefined)
        {
            const d = this.Deferred
            return new Promise<SecurityModelDto | null>(resolve => { d.push({ env, resolve }) })
        }
        if (this.GetError !== undefined)
        {
            throw this.GetError
        }
        return structuredClone(this.Model)
    }

    public async SetSecurityModel(env: string, model: SecurityModelDto): Promise<void>
    {
        if (this.SetError !== undefined)
        {
            throw this.SetError
        }
        this.Saved.push({ env, model })
    }
}

class Fixture
{
    public static async Loaded(src: FakeSource = new FakeSource()): Promise<RolesPrivilegesViewModel>
    {
        const vm = new RolesPrivilegesViewModel(src)
        await vm.LoadEnvironments()
        return vm
    }
}

describe('RolesPrivilegesViewModel', () =>
{
    it('loads roles and one row per concept, selecting the first role', async () =>
    {
        const vm = await Fixture.Loaded()
        assert.equal(vm.SelectedEnvironment, 'envA')
        assert.deepEqual(vm.Roles.map(r => r.id), ['r1', 'r2'])
        assert.equal(vm.SelectedRoleId, 'r1')
        assert.deepEqual(vm.Rows.map(r => r.Concept), ['Customer', 'Order'])
        assert.equal(vm.Rows[0].LevelFor(PrivilegeAction.Read), AccessLevel.User)
        assert.equal(vm.State, RolesPrivilegesState.Ready)
        assert.equal(vm.Dirty, false)
    })

    it('empty model gives empty roles and the empty state', async () =>
    {
        const src = new FakeSource()
        src.Model = null
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.Roles.length, 0)
        assert.equal(vm.Rows.length, 0)
        assert.equal(vm.State, RolesPrivilegesState.Empty)
    })

    it('reports NoEnvironment when there are none', async () =>
    {
        const src = new FakeSource()
        src.Envs = []
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.State, RolesPrivilegesState.NoEnvironment)
    })

    it('SelectRole rebuilds rows for the new role', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.SelectRole('r2')
        assert.equal(vm.SelectedRoleId, 'r2')
        assert.equal(vm.Rows[0].LevelFor(PrivilegeAction.Read), AccessLevel.None)
    })

    it('AddConcept appends a row, AddRole adds and selects, DeleteRole removes', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.AddConcept('Invoice')
        assert.ok(vm.Rows.some(r => r.Concept === 'Invoice'))
        vm.AddRole('Auditor')
        assert.equal(vm.Roles.length, 3)
        assert.equal(vm.SelectedRoleId, 'role-auditor-1')
        vm.DeleteRole('role-auditor-1')
        assert.equal(vm.Roles.length, 2)
        assert.equal(vm.SelectedRoleId, 'r1')
    })

    it('cycling a cell sets Dirty after RefreshDirty', async () =>
    {
        const vm = await Fixture.Loaded()
        assert.equal(vm.Dirty, false)
        const level = vm.Rows[0].Cycle(PrivilegeAction.Create)
        assert.equal(level, AccessLevel.User)
        vm.RefreshDirty()
        assert.equal(vm.Dirty, true)
    })

    it('Save sends the edited model, keeps untouched sections, and clears Dirty', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        vm.Rows[0].Cycle(PrivilegeAction.Create)
        vm.RefreshDirty()
        await vm.Save()
        assert.equal(src.Saved.length, 1)
        assert.equal(src.Saved[0].env, 'envA')
        const saved = src.Saved[0].model
        const original = Make.Model()
        assert.deepEqual(saved.businessUnits, original.businessUnits)
        assert.deepEqual(saved.teams, original.teams)
        assert.deepEqual(saved.membership, original.membership)
        assert.deepEqual(saved.ownershipRules, original.ownershipRules)
        assert.deepEqual(saved.roleAssignment, original.roleAssignment)
        assert.deepEqual(saved.fieldSecurity, original.fieldSecurity)
        assert.deepEqual(saved.roles?.[1], original.roles?.[1])
        assert.equal(saved.roles?.[0].id, 'r1')
        assert.equal(saved.roles?.[0].name, 'Admin')
        assert.equal(saved.roles?.[0].privileges.length, 2)
        assert.ok(saved.roles?.[0].privileges.some(p => p.concept === 'Customer' && p.action === PrivilegeAction.Read && p.level === AccessLevel.User))
        assert.ok(saved.roles?.[0].privileges.some(p => p.concept === 'Customer' && p.action === PrivilegeAction.Create && p.level === AccessLevel.User))
        assert.equal(vm.Dirty, false)
        assert.equal(vm.SelectedRoleId, 'r1')
    })

    it('Revert reloads from the source and clears Dirty', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.Rows[0].Cycle(PrivilegeAction.Create)
        vm.RefreshDirty()
        await vm.Revert()
        assert.equal(vm.Dirty, false)
        assert.equal(vm.Rows[0].LevelFor(PrivilegeAction.Create), AccessLevel.None)
    })

    it('SelectEnvironment resets the draft and loads the new environment', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.SelectRole('r2')
        await vm.SelectEnvironment('envB')
        assert.equal(vm.SelectedEnvironment, 'envB')
        assert.equal(vm.SelectedRoleId, 'r1')
    })

    it('surfaces load errors as Error state', async () =>
    {
        const src = new FakeSource()
        src.GetError = new Error('boom')
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.Error, 'boom')
        assert.equal(vm.State, RolesPrivilegesState.Error)
        assert.equal(vm.Busy, false)
    })

    it('a 403 on load sets the Forbidden state with no raw error', async () =>
    {
        const src = new FakeSource()
        src.GetError = new TenantApiError(TenantApiError.ForbiddenStatus, 'forbidden')
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.State, RolesPrivilegesState.Forbidden)
        assert.equal(vm.Error, '')
        assert.equal(vm.Busy, false)
    })

    it('a 403 on Save sets the Forbidden state; other Save errors stay in Ready with the message', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.SetError = new Error('disk full')
        await vm.Save()
        assert.equal(vm.State, RolesPrivilegesState.Ready)
        assert.equal(vm.Error, 'disk full')
        src.SetError = new TenantApiError(TenantApiError.ForbiddenStatus, 'forbidden')
        await vm.Save()
        assert.equal(vm.State, RolesPrivilegesState.Forbidden)
        assert.equal(vm.Error, '')
    })

    it('rethrows a 401', async () =>
    {
        const src = new FakeSource()
        src.GetError = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        const vm = new RolesPrivilegesViewModel(src)
        await assert.rejects(vm.LoadEnvironments(), (e: unknown) => e instanceof TenantApiError)
        assert.equal(vm.Busy, false)
    })

    it('rethrows a 401 from Save', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.SetError = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        await assert.rejects(vm.Save(), (e: unknown) => e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
        assert.equal(vm.Busy, false)
    })

    it('discards a load that resolves after a newer SelectEnvironment', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.Deferred = []
        const first = vm.SelectEnvironment('envA')
        const second = vm.SelectEnvironment('envB')
        const other = Make.Model()
        other.roles = [{ id: 'rB', name: 'B', privileges: [] }]
        src.Deferred[1].resolve(other)
        await second
        src.Deferred[0].resolve(Make.Model())
        await first
        assert.equal(vm.SelectedEnvironment, 'envB')
        assert.deepEqual(vm.Roles.map(r => r.id), ['rB'])
        assert.equal(vm.Busy, false)
    })

    it('discards a load that resolves after SelectRole', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.Deferred = []
        const reload = vm.LoadModel()
        vm.SelectRole('r2')
        const replacement = Make.Model()
        replacement.roles = [{ id: 'rX', name: 'X', privileges: [] }]
        src.Deferred[0].resolve(replacement)
        await reload
        assert.equal(vm.SelectedRoleId, 'r2')
        assert.deepEqual(vm.Roles.map(r => r.id), ['r1', 'r2'])
    })
})
