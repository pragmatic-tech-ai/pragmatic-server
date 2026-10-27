import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccountRow } from '../src/account-row.js'
import { UsersAccessViewModel, UsersAccessState, PendingKind } from '../src/users-access-view-model.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { TenantRole } from '../src/tenant-types.js'
import type { IUsersAccessSource, AdminSnapshotDto, EnvironmentDto, CreateAccountParams, GrantMutationDto, GrantDto } from '../src/tenant-types.js'

class Make
{
    public static Env(name: string): EnvironmentDto
    {
        return { name, template: 't', type: 'runtime', environmentId: 'id-' + name, hostPort: 1, status: 'running', createdAt: '', httpUrl: '', wsUrl: '' }
    }

    public static Grant(subject: string, role: string): GrantDto
    {
        return { subject, role, resourceKind: 'tenant', resourcePath: [] }
    }

    public static Snapshot(): AdminSnapshotDto
    {
        return {
            accounts: [
                { principalId: 'me', email: 'me@x', disabled: false },
                { principalId: 'other', email: 'o@x', disabled: true },
            ],
            grants: [Make.Grant('me', 'Admin'), Make.Grant('me', 'Admin'), Make.Grant('me', 'Editor'), Make.Grant('other', 'Viewer')],
        }
    }

    public static Tick(): Promise<void>
    {
        return new Promise(r => setImmediate(r))
    }
}

class FakeSource implements IUsersAccessSource
{
    public Calls: string[] = []
    public Envs: EnvironmentDto[] = [Make.Env('envA'), Make.Env('envB')]
    public Snapshot: AdminSnapshotDto = Make.Snapshot()
    public SnapshotError: Error | undefined
    public MutationError: Error | undefined
    public Created: CreateAccountParams | undefined
    public Granted: GrantMutationDto | undefined
    public Revoked: GrantMutationDto | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        this.Calls.push('list')
        return this.Envs
    }

    public async GetAdminSnapshot(env: string): Promise<AdminSnapshotDto>
    {
        this.Calls.push('snapshot:' + env)
        if (this.SnapshotError !== undefined)
        {
            throw this.SnapshotError
        }
        return this.Snapshot
    }

    public async CreateAccount(env: string, params: CreateAccountParams): Promise<void>
    {
        this.Calls.push('create:' + env)
        this.Created = params
        this.ThrowIfMutationError()
    }

    public async DisableAccount(env: string, principalId: string): Promise<void>
    {
        this.Calls.push('disable:' + env + ':' + principalId)
        this.ThrowIfMutationError()
    }

    public async GrantRole(env: string, grant: GrantMutationDto): Promise<void>
    {
        this.Calls.push('grant:' + env)
        this.Granted = grant
        this.ThrowIfMutationError()
    }

    public async RevokeRole(env: string, grant: GrantMutationDto): Promise<void>
    {
        this.Calls.push('revoke:' + env)
        this.Revoked = grant
        this.ThrowIfMutationError()
    }

    public Count(prefix: string): number
    {
        return this.Calls.filter(c => c.startsWith(prefix)).length
    }

    private ThrowIfMutationError(): void
    {
        if (this.MutationError !== undefined)
        {
            throw this.MutationError
        }
    }
}

describe('AccountRow', () =>
{
    it('maps email, status and de-duplicated roles', () =>
    {
        const rows = AccountRow.FromSnapshot({
            accounts: [{ principalId: 'p1', email: 'a@b', disabled: false }],
            grants: [Make.Grant('p1', 'Admin'), Make.Grant('p1', 'Editor'), Make.Grant('p1', 'Admin'), Make.Grant('zz', 'Owner')],
        })
        assert.equal(rows.length, 1)
        assert.equal(rows[0].Email, 'a@b')
        assert.equal(rows[0].Status, 'Active')
        assert.equal(rows[0].RolesText, 'Admin, Editor')
    })

    it('disabled account is Disabled; no grants gives empty RolesText', () =>
    {
        const rows = AccountRow.FromSnapshot({ accounts: [{ principalId: 'p1', email: 'a@b', disabled: true }], grants: [] })
        assert.equal(rows[0].Status, 'Disabled')
        assert.equal(rows[0].Disabled, true)
        assert.equal(rows[0].RolesText, '')
    })
})

describe('UsersAccessViewModel', () =>
{
    it('LoadEnvironments selects first env, loads, raises properties', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        const states: UsersAccessState[] = []
        let envRaised = 0
        vm.PropertyChanged(UsersAccessViewModel.StateProperty).subscribe(() => states.push(vm.State))
        vm.PropertyChanged(UsersAccessViewModel.EnvironmentsProperty).subscribe(() => { envRaised++ })
        await vm.LoadEnvironments()
        assert.deepEqual([...vm.Environments], ['envA', 'envB'])
        assert.equal(vm.SelectedEnvironment, 'envA')
        assert.equal(vm.State, UsersAccessState.Ready)
        assert.equal(states[0], UsersAccessState.Loading)
        assert.equal(states[states.length - 1], UsersAccessState.Ready)
        assert.ok(states.length >= 2)
        assert.ok(envRaised > 0)
        assert.equal(vm.Rows.length, 2)
    })

    it('LoadEnvironments with none yields NoEnvironment and no snapshot call', async () =>
    {
        const src = new FakeSource()
        src.Envs = []
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.LoadEnvironments()
        assert.equal(vm.State, UsersAccessState.NoEnvironment)
        assert.equal(src.Count('snapshot'), 0)
    })

    it('SelectEnvironment loads rows', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envB')
        assert.equal(vm.SelectedEnvironment, 'envB')
        assert.deepEqual(src.Calls, ['snapshot:envB'])
        assert.equal(vm.Rows.length, 2)
        assert.equal(vm.Rows[0].RolesText, 'Admin, Editor')
    })

    it('snapshot TenantApiError sets Error state', async () =>
    {
        const src = new FakeSource()
        src.SnapshotError = new TenantApiError(404, 'no such env')
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        assert.equal(vm.State, UsersAccessState.Error)
        assert.equal(vm.Error, 'no such env')
        assert.equal(vm.Rows.length, 0)
        assert.equal(vm.Busy, false)
    })

    it('CreateAccount calls source, clears draft, reloads', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        vm.DraftEmail = 'n@x'
        vm.DraftPrincipalId = 'np'
        vm.DraftPassword = 'secret'
        await vm.CreateAccount()
        assert.deepEqual(src.Created, { email: 'n@x', principalId: 'np', password: 'secret' })
        assert.equal(vm.DraftEmail, '')
        assert.equal(vm.DraftPrincipalId, '')
        assert.equal(vm.DraftPassword, '')
        assert.equal(src.Count('snapshot'), 2)
    })

    it('RequestDisable of self pends; Confirm disables; Cancel clears', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        src.Calls = []
        vm.RequestDisable('me')
        assert.equal(vm.Pending?.kind, PendingKind.DisableSelf)
        assert.deepEqual(src.Calls, [])
        await vm.ConfirmPending()
        assert.equal(src.Count('disable:envA:me'), 1)
        assert.equal(vm.Pending, undefined)

        vm.RequestDisable('me')
        vm.CancelPending()
        assert.equal(vm.Pending, undefined)
        assert.equal(src.Count('disable'), 1)
    })

    it('RequestDisable of another disables immediately', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        vm.RequestDisable('other')
        await Make.Tick()
        assert.equal(src.Count('disable:envA:other'), 1)
        assert.equal(vm.Pending, undefined)
    })

    it('DisableAccount TenantApiError sets Error, keeps rows, no reload', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        const before = vm.Rows
        src.MutationError = new TenantApiError(409, 'conflict')
        await vm.DisableAccount('other')
        assert.equal(vm.Error, 'conflict')
        assert.equal(vm.Rows, before)
        assert.equal(src.Count('snapshot'), 1)
        assert.equal(vm.Busy, false)
    })

    it('RequestRevoke mirrors disable for self', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        vm.RequestRevoke(Make.Grant('me', 'Admin'))
        assert.equal(vm.Pending?.kind, PendingKind.RevokeSelf)
        assert.equal(src.Count('revoke'), 0)
        await vm.ConfirmPending()
        assert.deepEqual(src.Revoked, { subject: 'me', role: 'Admin', resourceKind: 'tenant', resourcePath: [] })
        assert.equal(vm.Pending, undefined)

        vm.RequestRevoke(Make.Grant('other', 'Viewer'))
        await Make.Tick()
        assert.equal(src.Count('revoke'), 2)
    })

    it('GrantRole sends subject and draft role at tenant root', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        vm.SelectAccount('other')
        assert.equal(vm.SelectedGrants.length, 1)
        vm.DraftRole = TenantRole.Editor
        await vm.GrantRole()
        assert.deepEqual(src.Granted, { subject: 'other', role: 'Editor' })
        assert.equal(src.Count('snapshot'), 2)
    })

    it('reload omitting selected principal clears selection', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        vm.SelectAccount('other')
        src.Snapshot = { accounts: [{ principalId: 'me', email: 'me@x', disabled: false }], grants: [] }
        await vm.LoadSnapshot()
        assert.equal(vm.SelectedPrincipalId, undefined)
        assert.equal(vm.SelectedGrants.length, 0)
    })

    it('LoadEnvironments failure sets Error state and clears rows', async () =>
    {
        const src = new FakeSource()
        src.ListEnvironments = async () => { throw new TenantApiError(500, 'boom') }
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.LoadEnvironments()
        assert.equal(vm.State, UsersAccessState.Error)
        assert.equal(vm.Error, 'boom')
        assert.equal(vm.Rows.length, 0)
    })

    it('snapshot failure after a good load clears stale rows; NoEnvironment clears too', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        assert.equal(vm.Rows.length, 2)
        src.SnapshotError = new TenantApiError(500, 'down')
        await vm.LoadSnapshot()
        assert.equal(vm.Rows.length, 0)
        src.SnapshotError = undefined
        await vm.LoadSnapshot()
        assert.equal(vm.Rows.length, 2)
        src.Envs = []
        await vm.LoadEnvironments()
        assert.equal(vm.Rows.length, 0)
        assert.equal(vm.SelectedEnvironment, undefined)
    })

    it('CreateAccount failure keeps draft including password and does not reload', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        vm.DraftEmail = 'n@x'
        vm.DraftPrincipalId = 'np'
        vm.DraftPassword = 'secret'
        src.MutationError = new TenantApiError(400, 'weak password')
        await vm.CreateAccount()
        assert.equal(vm.Error, 'weak password')
        assert.equal(vm.DraftEmail, 'n@x')
        assert.equal(vm.DraftPrincipalId, 'np')
        assert.equal(vm.DraftPassword, 'secret')
        assert.equal(src.Count('snapshot'), 1)
        assert.equal(vm.Busy, false)
    })

    it('GrantRole failure sets Error, keeps rows, no reload', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        vm.SelectAccount('other')
        const before = vm.Rows
        src.MutationError = new TenantApiError(403, 'forbidden')
        await vm.GrantRole()
        assert.equal(vm.Error, 'forbidden')
        assert.equal(vm.Rows, before)
        assert.equal(src.Count('snapshot'), 1)
    })

    it('RevokeRole failure sets Error, keeps rows, no reload', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        const before = vm.Rows
        src.MutationError = new TenantApiError(409, 'last owner')
        await vm.RevokeRole(Make.Grant('other', 'Viewer'))
        assert.equal(vm.Error, 'last owner')
        assert.equal(vm.Rows, before)
        assert.equal(src.Count('snapshot'), 1)
    })

    it('non-TenantApiError from a fire-and-forget mutation lands in Error, not unhandled', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        src.MutationError = new Error('network')
        vm.RequestDisable('other')
        await Make.Tick()
        assert.equal(vm.Error, 'network')
        assert.equal(vm.Busy, false)
    })

    it('SelectEnvironment clears a pended self-action', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        vm.RequestDisable('me')
        await vm.SelectEnvironment('envB')
        assert.equal(vm.Pending, undefined)
        await vm.ConfirmPending()
        assert.equal(src.Count('disable'), 0)
    })

    it('discards a stale snapshot that resolves after a newer one', async () =>
    {
        const src = new FakeSource()
        const resolvers: Array<(s: AdminSnapshotDto) => void> = []
        src.GetAdminSnapshot = (env: string) => new Promise<AdminSnapshotDto>(r => { src.Calls.push('snapshot:' + env); resolvers.push(r) })
        const vm = new UsersAccessViewModel(src, 'me')
        const first = vm.SelectEnvironment('envA')
        const second = vm.SelectEnvironment('envB')
        resolvers[1]({ accounts: [{ principalId: 'new', email: 'n@x', disabled: false }], grants: [] })
        await second
        resolvers[0](Make.Snapshot())
        await first
        assert.equal(vm.Rows.length, 1)
        assert.equal(vm.Rows[0].PrincipalId, 'new')
    })

    it('Busy spans mutation and reload; mutators no-op while Busy', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        const busy: boolean[] = []
        vm.PropertyChanged(UsersAccessViewModel.BusyProperty).subscribe(() => busy.push(vm.Busy))
        const p1 = vm.DisableAccount('other')
        const p2 = vm.DisableAccount('other')
        await Promise.all([p1, p2])
        assert.deepEqual(busy, [true, false])
        assert.equal(src.Count('disable'), 1)
    })

    it('raises Rows/Busy/Error/SelectedPrincipalId/Pending/SelectedGrants keys', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        const raised = new Set<string>()
        const keys = [
            UsersAccessViewModel.RowsProperty, UsersAccessViewModel.BusyProperty, UsersAccessViewModel.ErrorProperty,
            UsersAccessViewModel.SelectedPrincipalIdProperty, UsersAccessViewModel.PendingProperty, UsersAccessViewModel.SelectedGrantsProperty,
        ]
        for (const k of keys)
        {
            vm.PropertyChanged(k).subscribe(() => raised.add(k))
        }
        await vm.SelectEnvironment('envA')
        vm.SelectAccount('other')
        vm.RequestDisable('me')
        src.MutationError = new TenantApiError(409, 'conflict')
        await vm.DisableAccount('other')
        for (const k of keys)
        {
            assert.ok(raised.has(k), k)
        }
    })

    it('stale load resolving first does not drop Busy while the newer load is pending', async () =>
    {
        const src = new FakeSource()
        const resolvers: Array<(s: AdminSnapshotDto) => void> = []
        src.GetAdminSnapshot = (env: string) => new Promise<AdminSnapshotDto>(r => { src.Calls.push('snapshot:' + env); resolvers.push(r) })
        const vm = new UsersAccessViewModel(src, 'me')
        const first = vm.SelectEnvironment('envA')
        const second = vm.SelectEnvironment('envB')
        resolvers[0](Make.Snapshot())
        await first
        assert.equal(vm.Busy, true)
        resolvers[1](Make.Snapshot())
        await second
        assert.equal(vm.Busy, false)
    })

    it('SelectEnvironment during an in-flight mutation does not drop Busy', async () =>
    {
        const src = new FakeSource()
        const vm = new UsersAccessViewModel(src, 'me')
        await vm.SelectEnvironment('envA')
        let release: () => void = () => undefined
        src.DisableAccount = () => new Promise<void>(r => { release = r })
        const mutation = vm.DisableAccount('other')
        await vm.SelectEnvironment('envB')
        assert.equal(vm.Busy, true)
        release()
        await mutation
        assert.equal(vm.Busy, false)
    })

    it('LoadEnvironments failure invalidates an in-flight snapshot load', async () =>
    {
        const src = new FakeSource()
        let resolve: (s: AdminSnapshotDto) => void = () => undefined
        src.GetAdminSnapshot = () => new Promise<AdminSnapshotDto>(r => { resolve = r })
        const vm = new UsersAccessViewModel(src, 'me')
        const load = vm.SelectEnvironment('envA')
        src.ListEnvironments = async () => { throw new TenantApiError(500, 'boom') }
        await vm.LoadEnvironments()
        resolve(Make.Snapshot())
        await load
        assert.equal(vm.Rows.length, 0)
        assert.equal(vm.State, UsersAccessState.Error)
    })
})
