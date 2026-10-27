import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccessLevel, FieldPermission, PrivilegeAction } from '../src/security-model-draft.js'
import { FieldSecurityState, FieldSecurityViewModel } from '../src/field-security-view-model.js'
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
                profiles: [
                    { id: 'p1', name: 'Full', grants: [{ concept: 'Customer', field: 'ssn', read: true }, { concept: 'Order', field: 'total', read: true, update: true }] },
                    { id: 'p2', name: 'Other', grants: [{ concept: 'Customer', field: 'ssn', update: true }] }
                ],
                profileAssignment: {
                    claimsMapping: [{ claim: 'groups', value: 'ops', profiles: ['p1'] }],
                    overrides: [{ principalId: 'u1', profiles: ['p2'] }],
                    teamProfiles: [{ teamId: 't1', profiles: ['p1', 'p2'] }]
                }
            },
            roles: [
                { id: 'r1', name: 'Admin', privileges: [{ action: PrivilegeAction.Read, concept: 'Customer', level: AccessLevel.User }] },
                { id: 'r2', name: 'Viewer', privileges: [] }
            ]
        }
    }

    public static Alt(profileId: string): SecurityModelDto
    {
        const m = Make.Model()
        m.fieldSecurity = { securedFields: [], profiles: [{ id: profileId, name: profileId, grants: [] }], profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] } }
        return m
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
    public static async Loaded(src: FakeSource = new FakeSource()): Promise<FieldSecurityViewModel>
    {
        const vm = new FieldSecurityViewModel(src)
        await vm.LoadEnvironments()
        return vm
    }
}

describe('FieldSecurityViewModel', () =>
{
    it('loads profiles and one row per secured field, selecting the first profile', async () =>
    {
        const vm = await Fixture.Loaded()
        assert.equal(vm.SelectedEnvironment, 'envA')
        assert.deepEqual(vm.Profiles.map(p => p.id), ['p1', 'p2'])
        assert.equal(vm.SelectedProfileId, 'p1')
        assert.deepEqual(vm.Rows.map(r => r.Label), ['Customer · ssn'])
        assert.equal(vm.Rows[0].IsGranted(FieldPermission.Read), true)
        assert.equal(vm.Rows[0].IsGranted(FieldPermission.Update), false)
        assert.equal(vm.State, FieldSecurityState.Ready)
        assert.equal(vm.Dirty, false)
    })

    it('empty model gives empty profiles and the empty state', async () =>
    {
        const src = new FakeSource()
        src.Model = null
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.Profiles.length, 0)
        assert.equal(vm.Rows.length, 0)
        assert.equal(vm.State, FieldSecurityState.Empty)
    })

    it('SelectProfile makes the rows report the new profile grants', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.SelectProfile('p2')
        assert.equal(vm.SelectedProfileId, 'p2')
        assert.equal(vm.Rows[0].IsGranted(FieldPermission.Read), false)
    })

    it('AddSecuredField appends a row, RemoveSecuredField removes it', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.AddSecuredField('Order', 'total')
        assert.deepEqual(vm.Rows.map(r => r.Field), ['ssn', 'total'])
        vm.RemoveSecuredField('Customer', 'ssn')
        assert.deepEqual(vm.Rows.map(r => r.Concept), ['Order'])
    })

    it('AddProfile adds and selects, DeleteProfile removes', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.AddProfile('Auditor')
        assert.equal(vm.Profiles.length, 3)
        const added = vm.SelectedProfileId
        assert.ok(added !== undefined && added !== 'p1')
        vm.DeleteProfile(added)
        assert.equal(vm.Profiles.length, 2)
        assert.equal(vm.SelectedProfileId, 'p1')
    })

    it('toggling a row sets Dirty after RefreshDirty', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.Rows[0].Toggle(FieldPermission.Update, true)
        vm.RefreshDirty()
        assert.equal(vm.Dirty, true)
    })

    it('Save sends the edited model, keeps other sections, and clears Dirty', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        vm.Rows[0].Toggle(FieldPermission.Update, true)
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
        assert.deepEqual(saved.roles, original.roles)
        assert.deepEqual(saved.fieldSecurity?.securedFields, original.fieldSecurity?.securedFields)
        assert.deepEqual(saved.fieldSecurity?.profileAssignment, original.fieldSecurity?.profileAssignment)
        assert.deepEqual(saved.fieldSecurity?.profiles[1], original.fieldSecurity?.profiles[1])
        const expected = Make.Model().fieldSecurity!.profiles[0]
        expected.grants[0].update = true
        assert.deepEqual(saved.fieldSecurity?.profiles[0], expected)
        assert.equal(vm.Dirty, false)
        assert.equal(vm.SelectedProfileId, 'p1')
    })

    it('a non-401 Save error sets Error and returns Busy to false', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.SetError = new Error('disk full')
        await vm.Save()
        assert.equal(vm.Error, 'disk full')
        assert.equal(vm.State, FieldSecurityState.Ready)
        assert.equal(vm.Busy, false)
    })

    it('a 403 on Save sets the Forbidden state', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.SetError = new TenantApiError(TenantApiError.ForbiddenStatus, 'forbidden')
        await vm.Save()
        assert.equal(vm.State, FieldSecurityState.Forbidden)
        assert.equal(vm.Error, '')
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

    it('a Save that fails after switching environment does not touch the new environment state', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        let fail: (e: Error) => void = () => { }
        src.SetSecurityModel = () => new Promise<void>((_, reject) => { fail = reject })
        const saving = vm.Save()
        await vm.SelectEnvironment('envB')
        fail(new TenantApiError(TenantApiError.ForbiddenStatus, 'forbidden'))
        await saving
        assert.equal(vm.SelectedEnvironment, 'envB')
        assert.equal(vm.State, FieldSecurityState.Ready)
        assert.equal(vm.Error, '')
    })

    it('overlapping loads raise Busy once and clear it once', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        const busy: boolean[] = []
        vm.PropertyChanged(FieldSecurityViewModel.BusyProperty).subscribe(() => busy.push(vm.Busy))
        src.Deferred = []
        const a = vm.LoadModel()
        const b = vm.LoadModel()
        assert.deepEqual(busy, [true])
        src.Deferred[0].resolve(Make.Model())
        await a
        assert.deepEqual(busy, [true])
        src.Deferred[1].resolve(Make.Model())
        await b
        assert.deepEqual(busy, [true, false])
    })

    it('Revert reloads from the source and clears Dirty', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.Rows[0].Toggle(FieldPermission.Update, true)
        vm.RefreshDirty()
        await vm.Revert()
        assert.equal(vm.Dirty, false)
        assert.equal(vm.Rows[0].IsGranted(FieldPermission.Update), false)
    })

    it('surfaces load errors as Error state', async () =>
    {
        const src = new FakeSource()
        src.GetError = new Error('boom')
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.Error, 'boom')
        assert.equal(vm.State, FieldSecurityState.Error)
        assert.equal(vm.Busy, false)
    })

    it('a 403 on load sets the Forbidden state with no raw error', async () =>
    {
        const src = new FakeSource()
        src.GetError = new TenantApiError(TenantApiError.ForbiddenStatus, 'forbidden')
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.State, FieldSecurityState.Forbidden)
        assert.equal(vm.Error, '')
    })

    it('rethrows a 401', async () =>
    {
        const src = new FakeSource()
        src.GetError = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        const vm = new FieldSecurityViewModel(src)
        await assert.rejects(vm.LoadEnvironments(), (e: unknown) => e instanceof TenantApiError)
        assert.equal(vm.Busy, false)
    })

    it('discards a load that resolves after a newer SelectEnvironment', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.Deferred = []
        const first = vm.SelectEnvironment('envA')
        const second = vm.SelectEnvironment('envB')
        src.Deferred[1].resolve(Make.Alt('pB'))
        await second
        src.Deferred[0].resolve(Make.Model())
        await first
        assert.equal(vm.SelectedEnvironment, 'envB')
        assert.deepEqual(vm.Profiles.map(p => p.id), ['pB'])
        assert.equal(vm.Busy, false)
    })

    it('discards a load that resolves after SelectProfile', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.Deferred = []
        const reload = vm.LoadModel()
        vm.SelectProfile('p2')
        src.Deferred[0].resolve(Make.Alt('pX'))
        await reload
        assert.equal(vm.SelectedProfileId, 'p2')
        assert.deepEqual(vm.Profiles.map(p => p.id), ['p1', 'p2'])
    })
})
