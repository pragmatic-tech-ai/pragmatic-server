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

class DeferredSource implements IConnectionSource
{
    public Delay = true
    public Rollout: HiveRolloutDto = { targetVersion: '1.0.0', environments: [] }
    private release: (() => void) | undefined

    public constructor(private readonly inner: FakeSource)
    {
    }

    public ReleaseFirst(): void
    {
        this.release?.()
    }

    public GetHives(): Promise<HiveDto[]>
    {
        return this.inner.GetHives()
    }

    public async GetRollout(_hiveId: string): Promise<HiveRolloutDto>
    {
        if (this.Delay)
        {
            await new Promise<void>(resolve => { this.release = resolve })
            return { targetVersion: '1.0.0', environments: [] }
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
        assert.equal(vm.Status?.environments.length, 0)
        assert.equal(vm.Error, '')
    })

    it('rethrows 401', async () =>
    {
        const s = new FakeSource()
        s.Failure = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        const vm = new ConnectionStatusViewModel(s)
        await assert.rejects(() => vm.Load(), TenantApiError)
        assert.notEqual(vm.State, ConnectionState.Error)
    })

    it('maps 403 to Forbidden', async () =>
    {
        const s = new FakeSource()
        s.Failure = new TenantApiError(TenantApiError.ForbiddenStatus, 'no')
        const vm = new ConnectionStatusViewModel(s)
        await vm.Load()
        assert.equal(vm.State, ConnectionState.Forbidden)
        assert.equal(vm.Status, undefined)
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
        assert.equal(vm.Status, undefined)
    })

    it('recovers from Quiet on reload and clears the error', async () =>
    {
        const s = new FakeSource()
        s.Failure = new TenantApiError(503, 'unavailable')
        const vm = new ConnectionStatusViewModel(s)
        await vm.Load()
        assert.equal(vm.State, ConnectionState.Quiet)
        s.Failure = undefined
        await vm.Load()
        assert.equal(vm.State, ConnectionState.Connected)
        assert.equal(vm.Status?.reachable, true)
        assert.equal(vm.Error, '')
    })

    it('ignores a stale load superseded by a later one', async () =>
    {
        const s = new FakeSource()
        const slow = new DeferredSource(s)
        const vm = new ConnectionStatusViewModel(slow)
        const first = vm.Load()
        slow.Rollout = { targetVersion: '2.0.0', environments: [] }
        slow.Delay = false
        const second = vm.Load()
        await second
        slow.ReleaseFirst()
        await first
        assert.equal(vm.State, ConnectionState.Connected)
        assert.equal(vm.Status?.targetVersion, '2.0.0')
    })
})
