import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveDetailViewModel } from '../src/hive-detail-view-model.js'
import type { IHiveDetailSource } from '../src/hive-detail-view-model.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { TenantEventType, VersionBadge } from '../src/tenant-types.js'
import type { HiveDto, HiveHealthDto, HiveRolloutDto, ManifestDto } from '../src/tenant-types.js'

class Make
{
    public static Hive(): HiveDto
    {
        return { id: 'h1', tenantId: 't', displayName: 'Hive One', cluster: { backend: 'docker', mode: 'single' }, registry: { mode: 'local' }, createdAt: '' }
    }

    public static Manifest(id: string, publishedAt: string): ManifestDto
    {
        return { id, image: 'img:' + id, publishedAt }
    }
}

class FakeHiveDetailSource implements IHiveDetailSource
{
    public Manifests: ManifestDto[] = [Make.Manifest('v1', '2026-01-01'), Make.Manifest('v3', '2026-03-01'), Make.Manifest('v2', '2026-02-01')]
    public Rollout: HiveRolloutDto = {
        targetVersion: 'v3',
        environments: [
            { environmentName: 'e1', runningImage: 'img:v3', obsolete: false, ready: true },
            { environmentName: 'e2', runningImage: 'img:v3', obsolete: false, ready: true },
        ],
    }
    public Health: HiveHealthDto[] = [{ environmentName: 'e1', ready: true, runningImage: 'img:v3', detail: '' }]
    public Selected: Array<[string, string]> = []
    public RolloutCalls = 0
    public Failure: Error | undefined

    public async ListManifests(): Promise<ManifestDto[]>
    {
        return this.Manifests
    }

    public async GetRollout(_hiveId: string): Promise<HiveRolloutDto>
    {
        this.RolloutCalls++
        return this.Rollout
    }

    public async GetHealth(_hiveId: string): Promise<HiveHealthDto[]>
    {
        return this.Health
    }

    public async SelectTarget(hiveId: string, version: string): Promise<void>
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        this.Selected.push([hiveId, version])
        this.Rollout = { ...this.Rollout, targetVersion: version }
    }
}

describe('HiveDetailViewModel', () =>
{
    it('sorts newest-first and badges current / previous / available', async () =>
    {
        const vm = new HiveDetailViewModel(new FakeHiveDetailSource(), Make.Hive())
        await vm.Load()
        assert.deepEqual(vm.Versions.map(v => v.manifest.id), ['v3', 'v2', 'v1'])
        assert.deepEqual(vm.Versions.map(v => v.badge), [VersionBadge.Current, VersionBadge.Previous, VersionBadge.Available])
        assert.deepEqual(vm.Versions.map(v => v.isTarget), [true, false, false])
        assert.equal(vm.RunningVersion, 'v3')
        assert.equal(vm.IsEmpty, false)
        assert.equal(vm.Health.length, 1)
    })

    it('badges middle manifest as current and the next-older as previous', async () =>
    {
        const src = new FakeHiveDetailSource()
        src.Rollout = { ...src.Rollout, targetVersion: 'v2' }
        const vm = new HiveDetailViewModel(src, Make.Hive())
        await vm.Load()
        assert.deepEqual(vm.Versions.map(v => v.badge), [VersionBadge.Available, VersionBadge.Current, VersionBadge.Previous])
    })

    it('falls back to the agreed running image when no target is set', async () =>
    {
        const src = new FakeHiveDetailSource()
        src.Rollout = { targetVersion: undefined, environments: [{ environmentName: 'e1', runningImage: 'img:v2', obsolete: false, ready: true }] }
        const vm = new HiveDetailViewModel(src, Make.Hive())
        await vm.Load()
        assert.equal(vm.RunningVersion, 'v2')
    })

    it('has no current when nothing identifies one', async () =>
    {
        const src = new FakeHiveDetailSource()
        src.Rollout = { targetVersion: undefined, environments: [] }
        const vm = new HiveDetailViewModel(src, Make.Hive())
        await vm.Load()
        assert.equal(vm.RunningVersion, undefined)
        assert.ok(vm.Versions.every(v => v.badge === VersionBadge.Available))
    })

    it('reports empty with no manifests', async () =>
    {
        const src = new FakeHiveDetailSource()
        src.Manifests = []
        const vm = new HiveDetailViewModel(src, Make.Hive())
        await vm.Load()
        assert.equal(vm.IsEmpty, true)
        assert.equal(vm.Versions.length, 0)
    })

    it('BeginTarget sets Pending naming the rollout environments', async () =>
    {
        const vm = new HiveDetailViewModel(new FakeHiveDetailSource(), Make.Hive())
        await vm.Load()
        vm.BeginTarget('v2')
        assert.equal(vm.Pending?.version, 'v2')
        assert.match(vm.Pending!.impact, /v2/)
        assert.match(vm.Pending!.impact, /e1, e2/)
    })

    it('ConfirmTarget success selects, clears Pending and reloads', async () =>
    {
        const src = new FakeHiveDetailSource()
        const vm = new HiveDetailViewModel(src, Make.Hive())
        await vm.Load()
        vm.BeginTarget('v2')
        await vm.ConfirmTarget()
        assert.deepEqual(src.Selected, [['h1', 'v2']])
        assert.equal(vm.Pending, undefined)
        assert.equal(vm.FailedRoll, undefined)
        assert.equal(vm.RunningVersion, 'v2')
    })

    it('ConfirmTarget failure sets FailedRoll and leaves the shown target unchanged', async () =>
    {
        const src = new FakeHiveDetailSource()
        const vm = new HiveDetailViewModel(src, Make.Hive())
        await vm.Load()
        const before = vm.Versions
        src.Failure = new TenantApiError(409, 'version not available')
        vm.BeginTarget('v1')
        await vm.ConfirmTarget()
        assert.equal(vm.Pending, undefined)
        assert.equal(vm.FailedRoll?.message, 'version not available')
        assert.equal(vm.FailedRoll?.stayedOn, 'v3')
        assert.equal(vm.Versions, before)
        assert.equal(vm.RunningVersion, 'v3')
    })

    it('BeginTarget clears a prior FailedRoll', async () =>
    {
        const src = new FakeHiveDetailSource()
        const vm = new HiveDetailViewModel(src, Make.Hive())
        await vm.Load()
        src.Failure = new Error('nope')
        vm.BeginTarget('v1')
        await vm.ConfirmTarget()
        vm.BeginTarget('v2')
        assert.equal(vm.FailedRoll, undefined)
    })

    it('CancelTarget clears Pending', async () =>
    {
        const vm = new HiveDetailViewModel(new FakeHiveDetailSource(), Make.Hive())
        await vm.Load()
        vm.BeginTarget('v2')
        vm.CancelTarget()
        assert.equal(vm.Pending, undefined)
    })

    it('ApplyEvent reloads for this hive env and ignores others', async () =>
    {
        const src = new FakeHiveDetailSource()
        const vm = new HiveDetailViewModel(src, Make.Hive())
        await vm.Load()
        const calls = src.RolloutCalls
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'e2' }), true)
        assert.equal(src.RolloutCalls, calls + 1)
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'other' }), false)
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.HealthChanged, environmentName: 'e1' }), false)
        assert.equal(src.RolloutCalls, calls + 1)
    })

    it('discards a stale Load that resolves after a newer one', async () =>
    {
        const releases: Array<() => void> = []
        const rollouts: HiveRolloutDto[] = [
            { targetVersion: 'v1', environments: [] },
            { targetVersion: 'v3', environments: [] },
        ]
        let n = 0
        const base = new FakeHiveDetailSource()
        const src: IHiveDetailSource = {
            ListManifests: async () => base.Manifests,
            GetHealth: async () => [],
            SelectTarget: async () => undefined,
            GetRollout: () =>
            {
                const r = rollouts[n++]!
                return new Promise<HiveRolloutDto>(resolve => { releases.push(() => resolve(r)) })
            },
        }
        const vm = new HiveDetailViewModel(src, Make.Hive())
        const first = vm.Load()
        const second = vm.Load()
        await new Promise(r => setTimeout(r, 0))
        releases[1]!()
        await second
        releases[0]!()
        await first
        assert.equal(vm.RunningVersion, 'v3')
    })
})
