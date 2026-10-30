import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SettingsState, SettingsViewModel } from '../src/settings-view-model.js'
import type { ISettingsSource } from '../src/settings-view-model.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { HiveDto, TenantProfileDto } from '../src/tenant-types.js'

class FakeSource implements ISettingsSource
{
    public Prof: TenantProfileDto | undefined = {
        principalId: 'p', roleLabel: 'Owner', environment: { id: 't1', displayName: 'Acme' }, capabilities: {} as never,
    }
    public Hives: HiveDto[] = [{ id: 'h1', tenantId: 't1', displayName: 'Hive', cluster: { backend: 'k', mode: 'm' }, registry: { mode: 'r' }, createdAt: '' }]
    public Failure: unknown

    public async Profile(): Promise<TenantProfileDto>
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        return this.Prof as TenantProfileDto
    }

    public async ListHives(): Promise<HiveDto[]>
    {
        return this.Hives
    }
}

describe('SettingsViewModel', () =>
{
    it('starts Loading', () =>
    {
        assert.equal(new SettingsViewModel(new FakeSource()).State, SettingsState.Loading)
    })

    it('Ready with profile and first hive', async () =>
    {
        const vm = new SettingsViewModel(new FakeSource())
        await vm.Load()
        assert.equal(vm.State, SettingsState.Ready)
        assert.equal(vm.Profile?.environment.displayName, 'Acme')
        assert.equal(vm.Hive?.id, 'h1')
    })

    it('rethrows 401', async () =>
    {
        const src = new FakeSource()
        src.Failure = new TenantApiError(TenantApiError.UnauthorizedStatus, 'x')
        await assert.rejects(new SettingsViewModel(src).Load())
    })

    it('403 is Forbidden', async () =>
    {
        const src = new FakeSource()
        src.Failure = new TenantApiError(TenantApiError.ForbiddenStatus, 'x')
        const vm = new SettingsViewModel(src)
        await vm.Load()
        assert.equal(vm.State, SettingsState.Forbidden)
    })

    it('other failure is Error with message, cleared on reload', async () =>
    {
        const src = new FakeSource()
        src.Failure = new Error('boom')
        const vm = new SettingsViewModel(src)
        await vm.Load()
        assert.equal(vm.State, SettingsState.Error)
        assert.equal(vm.Error, 'boom')
        src.Failure = undefined
        await vm.Load()
        assert.equal(vm.State, SettingsState.Ready)
        assert.equal(vm.Error, '')
    })

    it('no profile is NoData', async () =>
    {
        const src = new FakeSource()
        src.Prof = undefined
        const vm = new SettingsViewModel(src)
        await vm.Load()
        assert.equal(vm.State, SettingsState.NoData)
    })
})
