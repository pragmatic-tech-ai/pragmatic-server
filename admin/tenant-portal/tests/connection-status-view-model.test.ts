import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ConnectionState, ConnectionStatusViewModel } from '../src/connection-status-view-model.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { HiveDto, HiveRolloutDto, IConnectionSource } from '../src/tenant-types.js'

class FakeSource implements IConnectionSource
{
    public Hives: HiveDto[] = [{ id: 'h1', tenantId: 't1', displayName: 'Hive', cluster: { backend: 'k', mode: 'm' }, registry: { mode: 'r' }, createdAt: '' }]
    public Rollout: HiveRolloutDto = { targetVersion: '1.2.3', environments: [{ environmentName: 'dev', runningImage: 'img:1', obsolete: false, ready: true }] }
    public Failure: unknown

    public async GetHives(): Promise<HiveDto[]>
    {
        return this.Hives
    }

    public async GetRollout(_hiveId: string): Promise<HiveRolloutDto>
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        return this.Rollout
    }
}

describe('ConnectionStatusViewModel', () =>
{
    it('starts Loading', () =>
    {
        assert.equal(new ConnectionStatusViewModel(new FakeSource()).State, ConnectionState.Loading)
    })

    it('maps a successful rollout to Connected', async () =>
    {
        const vm = new ConnectionStatusViewModel(new FakeSource())
        await vm.Load()
        assert.equal(vm.State, ConnectionState.Connected)
        assert.equal(vm.Status?.reachable, true)
        assert.equal(vm.Status?.targetVersion, '1.2.3')
        assert.deepEqual(vm.Status?.environments, [{ name: 'dev', runningImage: 'img:1', ready: true }])
    })

    it('maps 503 to Quiet, not Error', async () =>
    {
        const s = new FakeSource()
        s.Failure = new TenantApiError(503, 'unavailable')
        const vm = new ConnectionStatusViewModel(s)
        await vm.Load()
        assert.equal(vm.State, ConnectionState.Quiet)
        assert.equal(vm.Status?.reachable, false)
        assert.notEqual(vm.State, ConnectionState.Error)
    })

    it('rethrows 401', async () =>
    {
        const s = new FakeSource()
        s.Failure = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        await assert.rejects(() => new ConnectionStatusViewModel(s).Load())
    })

    it('maps 403 to Forbidden', async () =>
    {
        const s = new FakeSource()
        s.Failure = new TenantApiError(TenantApiError.ForbiddenStatus, 'no')
        const vm = new ConnectionStatusViewModel(s)
        await vm.Load()
        assert.equal(vm.State, ConnectionState.Forbidden)
    })

    it('maps a generic error to Error with the message', async () =>
    {
        const s = new FakeSource()
        s.Failure = new Error('boom')
        const vm = new ConnectionStatusViewModel(s)
        await vm.Load()
        assert.equal(vm.State, ConnectionState.Error)
        assert.equal(vm.Error, 'boom')
    })

    it('maps no hives to NoHive', async () =>
    {
        const s = new FakeSource()
        s.Hives = []
        const vm = new ConnectionStatusViewModel(s)
        await vm.Load()
        assert.equal(vm.State, ConnectionState.NoHive)
    })
})
