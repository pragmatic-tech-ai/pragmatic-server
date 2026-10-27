import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OverviewViewModel } from '../src/overview-view-model.js'
import { PillKind } from '../src/kit/pill-kinds.js'
import { EnvStatus, EnvType, Template, TenantEventType } from '../src/tenant-types.js'
import type { CreateEnvironmentParams, EnvironmentDto, HiveHealthDto, HiveRolloutDto, IOverviewSource, ManifestDto } from '../src/tenant-types.js'

class Make
{
    public static Manifest(id: string, publishedAt: string, withdrawn?: boolean): ManifestDto
    {
        return withdrawn === undefined ? { id, image: 'img:' + id, publishedAt } : { id, image: 'img:' + id, publishedAt, withdrawn }
    }

    public static Env(name: string): EnvironmentDto
    {
        return { name, template: Template.DevBlank, type: EnvType.Development, environmentId: 'id-' + name, hostPort: 1, status: EnvStatus.Running, createdAt: '', httpUrl: '', wsUrl: '' }
    }
}

class FakeSource implements IOverviewSource
{
    public Manifests: ManifestDto[] = [Make.Manifest('v1', '2026-01-01'), Make.Manifest('v2', '2026-02-01')]
    public Rollout: HiveRolloutDto = {
        targetVersion: 'v1',
        environments: [
            { environmentName: 'e1', runningImage: 'img:v1', obsolete: false, ready: true },
            { environmentName: 'e2', runningImage: 'img:v1', obsolete: false, ready: true },
        ],
    }
    public Envs: EnvironmentDto[] = [Make.Env('e1'), Make.Env('e2')]
    public Health: HiveHealthDto[] = [
        { environmentName: 'e1', ready: true, runningImage: 'img:v1', detail: '' },
        { environmentName: 'e2', ready: false, runningImage: 'img:v1', detail: '' },
    ]
    public EnvFailure: Error | undefined
    public HealthFailure: Error | undefined
    public ManifestsFailure: Error | undefined
    public RolloutFailure: Error | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        if (this.EnvFailure !== undefined)
        {
            throw this.EnvFailure
        }
        return this.Envs
    }

    public async GetHealth(): Promise<HiveHealthDto[]>
    {
        if (this.HealthFailure !== undefined)
        {
            throw this.HealthFailure
        }
        return this.Health
    }

    public async ListManifests(): Promise<ManifestDto[]>
    {
        if (this.ManifestsFailure !== undefined)
        {
            throw this.ManifestsFailure
        }
        return this.Manifests
    }

    public async GetRollout(): Promise<HiveRolloutDto>
    {
        if (this.RolloutFailure !== undefined)
        {
            throw this.RolloutFailure
        }
        return this.Rollout
    }

    public async CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto>
    {
        return Make.Env(params.name)
    }
}

describe('OverviewViewModel', () =>
{
    it('builds rows joining environment and health', async () =>
    {
        const vm = new OverviewViewModel(new FakeSource(), 'h')
        await vm.Load()
        assert.equal(vm.Loaded, true)
        assert.equal(vm.Error, false)
        assert.equal(vm.Rows.length, 2)
        assert.equal(vm.Rows[0]!.HealthPill, PillKind.Healthy)
        assert.equal(vm.Rows[1]!.HealthPill, PillKind.Failing)
        assert.equal(vm.Rows[0]!.Version, 'v1')
    })

    it('lists existing names', async () =>
    {
        const vm = new OverviewViewModel(new FakeSource(), 'h')
        await vm.Load()
        assert.deepEqual([...vm.ExistingNames], ['e1', 'e2'])
    })

    it('offers a newer version when an environment is behind', async () =>
    {
        const vm = new OverviewViewModel(new FakeSource(), 'h')
        await vm.Load()
        assert.equal(vm.OfferAvailable, true)
        assert.equal(vm.OfferedVersion, 'v2')
    })

    it('offers the newest of several versions', async () =>
    {
        const s = new FakeSource()
        s.Manifests.push(Make.Manifest('v3', '2026-03-01'))
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        assert.equal(vm.OfferedVersion, 'v3')
    })

    it('offers nothing when all environments are on the current version', async () =>
    {
        const s = new FakeSource()
        s.Manifests = [Make.Manifest('v1', '2026-01-01')]
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        assert.equal(vm.OfferAvailable, false)
        assert.equal(vm.OfferedVersion, undefined)
    })

    it('offers nothing when the only other versions are withdrawn', async () =>
    {
        const s = new FakeSource()
        s.Manifests = [Make.Manifest('v1', '2026-01-01'), Make.Manifest('v2', '2026-02-01', true)]
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        assert.equal(vm.OfferAvailable, false)
        assert.equal(vm.OfferedVersion, undefined)
    })

    it('sets Error when ListEnvironments fails', async () =>
    {
        const s = new FakeSource()
        s.EnvFailure = new Error('boom')
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        assert.equal(vm.Error, true)
        assert.equal(vm.Loaded, false)
    })

    it('degrades to rows without health when GetHealth fails', async () =>
    {
        const s = new FakeSource()
        s.HealthFailure = new Error('down')
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        assert.equal(vm.Error, false)
        assert.equal(vm.Rows.length, 2)
        assert.equal(vm.Rows[0]!.HealthPill, PillKind.Unknown)
    })

    it('ApplyEvent reloads on lifecycle events', async () =>
    {
        const s = new FakeSource()
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        s.Envs = [Make.Env('e1'), Make.Env('e2'), Make.Env('e3')]
        const reloaded = await vm.ApplyEvent({ type: TenantEventType.EnvironmentCreated, environmentName: 'e3' })
        assert.equal(reloaded, true)
        assert.equal(vm.Rows.length, 3)
    })

    it('degrades without an offer when ListManifests fails', async () =>
    {
        const s = new FakeSource()
        s.ManifestsFailure = new Error('down')
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        assert.equal(vm.Error, false)
        assert.equal(vm.OfferAvailable, false)
        assert.equal(vm.Rows.length, 2)
    })

    it('degrades without a false offer when GetRollout fails', async () =>
    {
        const s = new FakeSource()
        s.RolloutFailure = new Error('down')
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        assert.equal(vm.Error, false)
        assert.equal(vm.OfferAvailable, false)
        assert.equal(vm.Rows.length, 2)
    })

    it('offers nothing when no environment is behind a non-current newer version', async () =>
    {
        const s = new FakeSource()
        s.Rollout = {
            targetVersion: 'v1',
            environments: [
                { environmentName: 'e1', runningImage: 'img:v2', obsolete: false, ready: true },
                { environmentName: 'e2', runningImage: 'img:v2', obsolete: false, ready: true },
            ],
        }
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        assert.equal(vm.OfferAvailable, false)
        assert.equal(vm.OfferedVersion, undefined)
    })

    it('resolves no current version for mixed images without a target', async () =>
    {
        const s = new FakeSource()
        s.Rollout = {
            targetVersion: undefined,
            environments: [
                { environmentName: 'e1', runningImage: 'img:v1', obsolete: false, ready: true },
                { environmentName: 'e2', runningImage: 'img:v2', obsolete: false, ready: true },
            ],
        }
        const vm = new OverviewViewModel(s, 'h')
        await vm.Load()
        // No current version, so the newest non-withdrawn manifest is offered while e1 still differs from it.
        assert.equal(vm.OfferAvailable, true)
        assert.equal(vm.OfferedVersion, 'v2')
    })
})
