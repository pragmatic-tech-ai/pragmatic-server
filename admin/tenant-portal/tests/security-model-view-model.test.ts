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
            ownershipRules: [{ concept: 'Order', owningBusinessUnit: { kind: 'claim', value: 'dept' } }],
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

    it('RecordSharingRows reflects the selected role with exact scope text', async () =>
    {
        const src = new FakeSource()
        src.Model = Make.Model()
        src.Model.roles = [
            { id: 'r1', name: 'Admin', privileges: [{ action: PrivilegeAction.Read, concept: 'Customer', level: AccessLevel.User }] },
            { id: 'r2', name: 'Viewer', privileges: [
                { action: PrivilegeAction.Read, concept: 'Customer', level: AccessLevel.Organization },
                { action: PrivilegeAction.Read, concept: 'Order', level: AccessLevel.BusinessUnit }
            ] }
        ]
        const vm = await Fixture.Loaded(src)
        assert.deepEqual(vm.RecordSharingRows.map(r => [r.concept, r.scopeText]), [['Customer', 'only records they own (user)']])
        vm.SelectRole('r2')
        assert.deepEqual(vm.RecordSharingRows.map(r => [r.concept, r.scopeText]), [
            ['Customer', 'all records in the organization'],
            ['Order', 'records in their business unit (records owned per the ownership rules)']
        ])
    })

    it('ResetDraft (environment switch to no model) clears every org array', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        vm.AddMembershipRule()
        vm.AddMembershipOverride()
        assert.ok(vm.BusinessUnitRows.length > 0 && vm.TeamRows.length > 0 && vm.OwnershipRuleRows.length > 0)
        src.GetError = new Error('gone')
        await vm.SelectEnvironment('envB')
        assert.deepEqual(vm.BusinessUnitRows, [])
        assert.deepEqual(vm.TeamRows, [])
        assert.deepEqual(vm.MembershipRuleRows, [])
        assert.deepEqual(vm.MembershipOverrideRows, [])
        assert.deepEqual(vm.OwnershipRuleRows, [])
        assert.deepEqual(vm.RecordSharingRows, [])
    })

    it('ownership source edits surface through the row and flip Dirty', async () =>
    {
        const vm = await Fixture.Loaded()
        const row = vm.OwnershipRuleRows[0]
        assert.equal(row.OwningKind, 'claim')
        assert.equal(row.OwningValue, 'dept')
        assert.equal(vm.Dirty, false)
        vm.SetOwningSourceKind('Order', 'fixed')
        vm.SetOwningSourceValue('Order', 'bu1')
        assert.equal(vm.OwnershipRuleRows[0].OwningKind, 'fixed')
        assert.equal(vm.OwnershipRuleRows[0].OwningValue, 'bu1')
        assert.equal(vm.Dirty, true)
    })

    it('RemoveMembershipRule keeps remaining row indices correct', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.AddMembershipRule()
        vm.AddMembershipRule()
        vm.MembershipRuleRows[0].SetClaim('first')
        vm.MembershipRuleRows[1].SetClaim('second')
        vm.MembershipRuleRows[0].Remove()
        assert.equal(vm.MembershipRuleRows.length, 1)
        assert.equal(vm.MembershipRuleRows[0].Claim, 'second')
        vm.MembershipRuleRows[0].SetValue('v')
        assert.equal(vm.MembershipRuleRows[0].Claim, 'second')
        assert.equal(vm.MembershipRuleRows[0].Value, 'v')
    })

    it('adding a role claim grant raises RoleClaimRowsProperty and the row appears for the selected role', async () =>
    {
        const vm = await Fixture.Loaded()
        let raised = 0
        vm.PropertyChanged(SecurityModelViewModel.RoleClaimRowsProperty).subscribe(() => { raised++ })
        vm.AddRoleClaimGrant()
        assert.equal(raised, 1)
        assert.equal(vm.RoleClaimRows.length, 1)
        assert.equal(vm.Dirty, true)
        vm.SelectRole('r2')
        assert.equal(vm.RoleClaimRows.length, 0)
        vm.SelectRole('r1')
        assert.equal(vm.RoleClaimRows.length, 1)
    })

    it('a scalar role claim edit flips Dirty without rebuilding the rows', async () =>
    {
        const vm = await Fixture.Loaded()
        vm.AddRoleClaimGrant()
        await vm.Save()
        assert.equal(vm.Dirty, false)
        const row = vm.RoleClaimRows[0]
        vm.RoleClaimRows[0].SetClaim('group')
        vm.RoleClaimRows[0].SetValue('admins')
        assert.equal(vm.Dirty, true)
        assert.equal(vm.RoleClaimRows[0], row)
        const fresh = await Fixture.Loaded()
        fresh.AddRoleClaimGrant()
        fresh.SetRoleClaimGrantClaim(0, 'g')
        assert.equal(fresh.Dirty, true)
    })

    it('role principal and team grants surface as rows, holders and direct count', async () =>
    {
        const vm = await Fixture.Loaded()
        assert.equal(vm.DirectHolderCountFor('r1'), 0)
        vm.AddRolePrincipalGrant('alice')
        vm.AddRoleTeamGrant('t1')
        assert.deepEqual(vm.RolePrincipalRows.map(r => r.PrincipalId), ['alice'])
        assert.deepEqual(vm.RoleTeamRows.map(r => [r.TeamId, r.TeamName]), [['t1', 'Team One']])
        assert.equal(vm.DirectHolderCountFor('r1'), 1)
        assert.equal(vm.DirectHolderCountFor('r2'), 0)
        assert.deepEqual([...vm.RoleHolders.byPrincipal], ['alice'])
        vm.SelectRole('r2')
        assert.deepEqual([...vm.RoleHolders.byPrincipal], [])
        assert.equal(vm.RolePrincipalRows.length, 0)
        vm.SelectRole('r1')
        vm.RolePrincipalRows[0].Remove()
        vm.RoleTeamRows[0].Remove()
        assert.equal(vm.RolePrincipalRows.length, 0)
        assert.equal(vm.RoleTeamRows.length, 0)
        assert.equal(vm.DirectHolderCountFor('r1'), 0)
    })

    it('the profile side mirrors for the selected profile', async () =>
    {
        const vm = await Fixture.Loaded()
        let raised = 0
        vm.PropertyChanged(SecurityModelViewModel.ProfileClaimRowsProperty).subscribe(() => { raised++ })
        vm.AddProfileClaimGrant()
        assert.equal(raised, 1)
        const row = vm.ProfileClaimRows[0]
        row.SetClaim('dept')
        row.SetValue('hr')
        assert.equal(vm.ProfileClaimRows[0], row)
        assert.equal(vm.ProfileClaimRows[0].Claim, '')
        vm.AddProfilePrincipalGrant('bob')
        vm.AddProfileTeamGrant('t1')
        assert.deepEqual(vm.ProfilePrincipalRows.map(r => r.PrincipalId), ['bob'])
        assert.deepEqual(vm.ProfileTeamRows.map(r => r.TeamName), ['Team One'])
        vm.SelectProfile('p2')
        assert.equal(vm.ProfileClaimRows.length, 0)
        assert.equal(vm.ProfilePrincipalRows.length, 0)
        vm.SelectProfile('p1')
        vm.ProfileClaimRows[0].Remove()
        vm.ProfilePrincipalRows[0].Remove()
        vm.ProfileTeamRows[0].Remove()
        assert.equal(vm.ProfileClaimRows.length + vm.ProfilePrincipalRows.length + vm.ProfileTeamRows.length, 0)
    })

    it('ONE Save persists a privilege edit, an org edit AND a role-assignment grant', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        vm.PrivilegeRows[0].Cycle(PrivilegeAction.Create)
        vm.AddBusinessUnit('X')
        vm.AddRolePrincipalGrant('alice')
        await vm.Save()
        assert.equal(src.Saved.length, 1)
        const saved = src.Saved[0].model
        const admin = saved.roles?.find(r => r.id === 'r1')
        assert.ok(admin?.privileges.some(p => p.concept === 'Customer' && p.action === PrivilegeAction.Create))
        assert.ok(saved.businessUnits.some(u => u.name === 'X'))
        assert.ok(saved.roleAssignment?.overrides.some(o => o.principalId === 'alice' && o.roles.includes('r1')))
        assert.equal(vm.Dirty, false)
        assert.equal(vm.RolePrincipalRows.length, 1)
    })

    it('a 401 on Save with assignment edits still rethrows', async () =>
    {
        const src = new FakeSource()
        const vm = await Fixture.Loaded(src)
        vm.AddRolePrincipalGrant('alice')
        src.SetError = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        await assert.rejects(vm.Save(), (e: unknown) => e instanceof TenantApiError)
    })
})
