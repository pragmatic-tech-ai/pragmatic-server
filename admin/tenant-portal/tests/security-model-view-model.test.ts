import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccessLevel, FieldPermission, PrivilegeAction } from '../src/security-model-draft.js'
import { SecurityModelState, SecurityModelViewModel } from '../src/security-model-view-model.js'
import type { ISecurityModelEnvSource } from '../src/security-model-view-model.js'
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
            membership: { claimsMapping: [], overrides: [] },
            ownershipRules: [{ concept: 'Order' } as never],
            fieldSecurity: {
                securedFields: [{ concept: 'Customer', field: 'ssn' }],
                profiles: [
                    { id: 'p1', name: 'Full', grants: [] },
                    { id: 'p2', name: 'Masked', grants: [] }
                ],
                profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] }
            },
            roles: [
                { id: 'r1', name: 'Admin', privileges: [{ action: PrivilegeAction.Read, concept: 'Customer', level: AccessLevel.User }] },
                { id: 'r2', name: 'Viewer', privileges: [] }
            ]
        }
    }
}

class FakeSource implements ISecurityModelEnvSource
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
    public static async Loaded(src: FakeSource = new FakeSource()): Promise<SecurityModelViewModel>
    {
        const vm = new SecurityModelViewModel(src)
        await vm.LoadEnvironments()
        return vm
    }
}

describe('SecurityModelViewModel', () =>
{
    it('loads one draft and exposes both role and field surfaces', async () =>
    {
        const vm = await Fixture.Loaded()
        assert.equal(vm.SelectedEnvironment, 'envA')
        assert.deepEqual(vm.Roles.map(r => r.id), ['r1', 'r2'])
        assert.deepEqual(vm.Profiles.map(p => p.id), ['p1', 'p2'])
        assert.equal(vm.SelectedRoleId, 'r1')
        assert.equal(vm.SelectedProfileId, 'p1')
        assert.deepEqual(vm.PrivilegeRows.map(r => r.Concept), ['Customer', 'Order'])
        assert.deepEqual(vm.FieldRows.map(r => r.Field), ['ssn'])
        assert.equal(vm.State, SecurityModelState.Ready)
        assert.equal(vm.Dirty, false)
    })

    it('is Empty only when both roles and profiles are empty', async () =>
    {
        const src = new FakeSource()
        src.Model = null
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.State, SecurityModelState.Empty)
        vm.AddProfile('Only')
        assert.equal(vm.State, SecurityModelState.Ready)
    })

    it('reports NoEnvironment when there are none', async () =>
    {
        const src = new FakeSource()
        src.Envs = []
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.State, SecurityModelState.NoEnvironment)
    })

    it('one Save persists BOTH a role edit and a field edit together', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        vm.PrivilegeRows[0].Cycle(PrivilegeAction.Create)
        vm.FieldRows[0].Toggle(FieldPermission.Read, true)
        vm.RefreshDirty()
        assert.equal(vm.Dirty, true)
        await vm.Save()
        assert.equal(src.Saved.length, 1)
        const saved = src.Saved[0].model
        const admin = saved.roles?.find(r => r.id === 'r1')
        assert.ok(admin?.privileges.some(p => p.concept === 'Customer' && p.action === PrivilegeAction.Create && p.level === AccessLevel.User))
        const full = saved.fieldSecurity?.profiles.find(p => p.id === 'p1')
        assert.ok(full?.grants.some(g => g.concept === 'Customer' && g.field === 'ssn' && g.read === true))
        assert.deepEqual(saved.teams, Make.Model().teams)
    })

    it('Save rebases: Dirty clears and both selections survive', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.SelectRole('r2')
        vm.SelectProfile('p2')
        vm.PrivilegeRows[0].Cycle(PrivilegeAction.Create)
        vm.RefreshDirty()
        await vm.Save()
        assert.equal(vm.Dirty, false)
        assert.equal(vm.SelectedRoleId, 'r2')
        assert.equal(vm.SelectedProfileId, 'p2')
    })

    it('Revert reloads and clears Dirty', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.PrivilegeRows[0].Cycle(PrivilegeAction.Create)
        vm.FieldRows[0].Toggle(FieldPermission.Read, true)
        vm.RefreshDirty()
        await vm.Revert()
        assert.equal(vm.Dirty, false)
        assert.equal(vm.PrivilegeRows[0].LevelFor(PrivilegeAction.Create), AccessLevel.None)
        assert.equal(vm.FieldRows[0].IsGranted(FieldPermission.Read), false)
    })

    it('SelectEnvironment discards the draft and resets dirty and selections', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.SelectRole('r2')
        vm.SelectProfile('p2')
        vm.AddRole('Temp')
        await vm.SelectEnvironment('envB')
        assert.equal(vm.SelectedEnvironment, 'envB')
        assert.equal(vm.Dirty, false)
        assert.equal(vm.SelectedRoleId, 'r1')
        assert.equal(vm.SelectedProfileId, 'p1')
        assert.equal(vm.Roles.length, 2)
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

    it('discards a reload that resolves after SelectProfile', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.Deferred = []
        const reload = vm.LoadModel()
        vm.SelectProfile('p2')
        src.Deferred[0].resolve(Make.Model())
        await reload
        assert.equal(vm.SelectedProfileId, 'p2')
    })

    it('DeleteRole and DeleteProfile fall back to the first remaining and set Dirty', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.SelectRole('r2')
        vm.DeleteRole('r2')
        assert.equal(vm.SelectedRoleId, 'r1')
        assert.equal(vm.Dirty, true)
        await vm.Revert()
        assert.equal(vm.Dirty, false)
        vm.SelectProfile('p2')
        vm.DeleteProfile('p2')
        assert.equal(vm.SelectedProfileId, 'p1')
        assert.equal(vm.Dirty, true)
    })

    it('AddProfile, AddSecuredField, RemoveSecuredField and AddConcept rebuild the surfaces', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.AddProfile('Auditor')
        assert.equal(vm.Profiles.length, 3)
        vm.AddSecuredField('Order', 'total')
        assert.equal(vm.FieldRows.length, 2)
        vm.RemoveSecuredField('Order', 'total')
        assert.equal(vm.FieldRows.length, 1)
        vm.AddConcept('Invoice')
        assert.ok(vm.PrivilegeRows.some(r => r.Concept === 'Invoice'))
    })

    it('a 403 on load is Forbidden; a 403 on save is Forbidden; other save errors stay Ready', async () =>
    {
        const bad = new FakeSource()
        bad.GetError = new TenantApiError(TenantApiError.ForbiddenStatus, 'forbidden')
        const loadVm = await Fixture.Loaded(bad)
        assert.equal(loadVm.State, SecurityModelState.Forbidden)
        assert.equal(loadVm.Error, '')

        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        src.SetError = new Error('disk full')
        await vm.Save()
        assert.equal(vm.State, SecurityModelState.Ready)
        assert.equal(vm.Error, 'disk full')
        src.SetError = new TenantApiError(TenantApiError.ForbiddenStatus, 'forbidden')
        await vm.Save()
        assert.equal(vm.State, SecurityModelState.Forbidden)
        assert.equal(vm.Busy, false)
    })

    it('surfaces load errors as Error state', async () =>
    {
        const src = new FakeSource()
        src.GetError = new Error('boom')
        const vm = await Fixture.Loaded(src)
        assert.equal(vm.Error, 'boom')
        assert.equal(vm.State, SecurityModelState.Error)
    })

    it('rethrows a 401 from load and from Save', async () =>
    {
        const src = new FakeSource()
        src.GetError = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        const loading = new SecurityModelViewModel(src)
        await assert.rejects(loading.LoadEnvironments(), (e: unknown) => e instanceof TenantApiError)
        assert.equal(loading.Busy, false)

        const ok = new FakeSource()
        const vm = await Fixture.Loaded(ok)
        ok.SetError = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        await assert.rejects(vm.Save(), (e: unknown) => e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
        assert.equal(vm.Busy, false)
    })

    it('adding a business unit raises BusinessUnitRowsProperty and the row appears', async () =>
    {
        const vm = await Fixture.Loaded()
        let raised = 0
        vm.PropertyChanged(SecurityModelViewModel.BusinessUnitRowsProperty).subscribe(() => { raised++ })
        vm.AddBusinessUnit('Sales')
        assert.equal(raised, 1)
        assert.deepEqual(vm.BusinessUnitRows.map(r => r.Name), ['Root', 'Sales'])
        assert.equal(vm.Dirty, true)
    })

    it('a membership rule claim edit surfaces through its row and marks Dirty', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.AddMembershipRule()
        await vm.Save()
        assert.equal(vm.Dirty, false)
        vm.MembershipRuleRows[0].SetClaim('group')
        assert.equal(vm.MembershipRuleRows[0].Claim, 'group')
        assert.equal(vm.Dirty, true)
    })

    it('row view-models forward edits for teams, overrides and ownership', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.TeamRows[0].Rename('Renamed')
        assert.equal(vm.TeamRows[0].Name, 'Renamed')
        vm.AddMembershipOverride()
        vm.MembershipOverrideRows[0].SetPrincipal('alice')
        vm.MembershipOverrideRows[0].ToggleTeam('t1')
        assert.equal(vm.MembershipOverrideRows[0].PrincipalId, 'alice')
        assert.deepEqual([...vm.MembershipOverrideRows[0].Teams], ['t1'])
        vm.OwnershipRuleRows[0].SetOwnerKind('claim')
        assert.equal(vm.OwnershipRuleRows[0].OwnerKind, 'claim')
        assert.equal(vm.OwnershipRuleRows[0].OwnerValue, '')
        vm.OwnershipRuleRows[0].Remove()
        assert.equal(vm.OwnershipRuleRows.length, 0)
    })

    it('ONE Save persists a role privilege edit AND an org edit together', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        vm.PrivilegeRows[0].Cycle(PrivilegeAction.Create)
        vm.AddBusinessUnit('X')
        vm.RefreshDirty()
        await vm.Save()
        assert.equal(src.Saved.length, 1)
        const saved = src.Saved[0].model
        const admin = saved.roles?.find(r => r.id === 'r1')
        assert.ok(admin?.privileges.some(p => p.concept === 'Customer' && p.action === PrivilegeAction.Create))
        assert.ok(saved.businessUnits.some(u => u.name === 'X'))
        assert.equal(vm.Dirty, false)
    })

    it('RecordSharingRows reflects the selected role', async () =>
    {
        const vm = await Fixture.Loaded()
        const admin = vm.RecordSharingRows.find(r => r.concept === 'Customer')
        assert.ok(admin !== undefined)
        vm.SelectRole('r2')
        const viewer = vm.RecordSharingRows.find(r => r.concept === 'Customer')
        assert.notEqual(viewer?.scopeText, admin.scopeText)
    })
})
