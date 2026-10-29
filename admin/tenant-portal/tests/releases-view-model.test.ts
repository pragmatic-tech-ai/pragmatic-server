import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdoptOutcome, EnvStepKind, ReleasesViewModel } from '../src/releases-view-model.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { EnvStatus, EnvType, Template, TenantEventType } from '../src/tenant-types.js'
import type { AdoptionLedgerDto, EnvironmentDto, HiveRolloutDto, IReleasesSource, ManifestDto } from '../src/tenant-types.js'

class Make
{
    public static Manifest(id: string, publishedAt: string, withdrawn?: boolean): ManifestDto
    {
        return withdrawn === undefined ? { id, image: 'img:' + id, publishedAt } : { id, image: 'img:' + id, publishedAt, withdrawn }
    }

    public static Env(name: string, status: EnvStatus): EnvironmentDto
    {
        return { name, template: Template.DevBlank, type: EnvType.Development, environmentId: 'id-' + name, hostPort: 1, status, createdAt: '', httpUrl: '', wsUrl: '' }
    }
}

class FakeSource implements IReleasesSource
{
    public Manifests: ManifestDto[] = [Make.Manifest('v1', '2026-01-01'), Make.Manifest('v2', '2026-02-01'), Make.Manifest('v3', '2026-03-01'), Make.Manifest('v4', '2026-04-01', true)]
    public Rollout: HiveRolloutDto = {
        targetVersion: 'v3',
        environments: [
            { environmentName: 'e1', runningImage: 'img:v3', obsolete: false, ready: true },
            { environmentName: 'e2', runningImage: 'img:v2', obsolete: false, ready: true },
            { environmentName: 'e3', runningImage: undefined, obsolete: false, ready: false },
        ],
    }
    public Envs: EnvironmentDto[] = [Make.Env('e1', EnvStatus.Running), Make.Env('e2', EnvStatus.Running), Make.Env('e3', EnvStatus.Stopped)]
    public Selected: Array<[string, string]> = []
    public RolloutCalls = 0
    public Failure: Error | undefined
    public Ledger: AdoptionLedgerDto[] = []

    public async ListManifests(): Promise<ManifestDto[]>
    {
        return this.Manifests
    }

    public async GetRollout(): Promise<HiveRolloutDto>
    {
        this.RolloutCalls++
        return this.Rollout
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return this.Envs
    }

    public async ListLedger(): Promise<readonly AdoptionLedgerDto[]>
    {
        return this.Ledger
    }

    public async SelectTarget(hiveId: string, version: string): Promise<void>
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        this.Selected.push([hiveId, version])
    }
}

class Fx
{
    public static async Vm(src: FakeSource): Promise<ReleasesViewModel>
    {
        const vm = new ReleasesViewModel(src, 'h1')
        await vm.Load()
        return vm
    }
}

describe('ReleasesViewModel', () =>
{
    it('offers exclude the current and withdrawn versions, with notOnCount', async () =>
    {
        const vm = await Fx.Vm(new FakeSource())
        // v3 is current, v4 withdrawn. Every env differs from v2 and v1 (e1 on v3, e2 on v2 -> one on v2).
        assert.deepEqual(vm.Offers.map(o => [o.version, o.notOnCount]), [['v2', 2], ['v1', 3]])
    })

    it('matrix marks Running only where the running image matches', async () =>
    {
        const vm = await Fx.Vm(new FakeSource())
        const m = vm.Matrix
        assert.deepEqual(m.columns.map(c => c.version), ['v4', 'v3', 'v2', 'v1'])
        const run = (n: string): string[] => m.rows.find(r => r.environmentName === n)!.cells.filter(c => c.running).map(c => c.version)
        assert.deepEqual(run('e1'), ['v3'])
        assert.deepEqual(run('e2'), ['v2'])
        assert.deepEqual(run('e3'), [])
        assert.equal(m.rows.find(r => r.environmentName === 'e3')!.status, EnvStatus.Stopped)
    })

    it('resolves the current version: target wins, unanimous image resolves, mixed is none', async () =>
    {
        const src = new FakeSource()
        assert.equal((await Fx.Vm(src)).RunningVersion, 'v3')
        src.Rollout = { targetVersion: undefined, environments: [
            { environmentName: 'e1', runningImage: 'img:v2', obsolete: false, ready: true },
            { environmentName: 'e2', runningImage: 'img:v2', obsolete: false, ready: true },
        ] }
        assert.equal((await Fx.Vm(src)).RunningVersion, 'v2')
        src.Rollout = { targetVersion: undefined, environments: [
            { environmentName: 'e1', runningImage: 'img:v2', obsolete: false, ready: true },
            { environmentName: 'e2', runningImage: 'img:v1', obsolete: false, ready: true },
        ] }
        assert.equal((await Fx.Vm(src)).RunningVersion, undefined)
    })

    it('classifies env steps', async () =>
    {
        const vm = await Fx.Vm(new FakeSource())
        const kinds = vm.EnvSteps('v3').map(s => [s.environmentName, s.kind])
        assert.deepEqual(kinds, [['e1', EnvStepKind.OnVersion], ['e2', EnvStepKind.WillRestart], ['e3', EnvStepKind.StartsLater]])
        assert.equal(vm.EnvSteps('v3')[1]!.label, ReleasesViewModel.LabelWillRestart)
    })

    it('ConfirmAdopt on a withdrawn version is Unknown and never selects the target', async () =>
    {
        const src = new FakeSource()
        const vm = await Fx.Vm(src)
        assert.equal(await vm.ConfirmAdopt('v4'), AdoptOutcome.Unknown)
        assert.equal(src.Selected.length, 0)
        assert.equal(vm.RunningVersion, 'v3')
    })

    it('ConfirmAdopt success submits and reloads', async () =>
    {
        const src = new FakeSource()
        const vm = await Fx.Vm(src)
        const before = src.RolloutCalls
        assert.equal(await vm.ConfirmAdopt('v2'), AdoptOutcome.Adopted)
        assert.deepEqual(src.Selected, [['h1', 'v2']])
        assert.equal(src.RolloutCalls, before + 1)
    })

    it('409 is Refused with the exact message and the target unchanged', async () =>
    {
        const src = new FakeSource()
        const vm = await Fx.Vm(src)
        src.Failure = new TenantApiError(409, 'e2 has pending migrations')
        assert.equal(await vm.ConfirmAdopt('v2'), AdoptOutcome.Refused)
        assert.equal(vm.LastResult?.message, 'e2 has pending migrations')
        assert.equal(vm.RunningVersion, 'v3')
        assert.equal(src.Selected.length, 0)
    })

    it('503 is Unavailable with the message; 404 is Unknown', async () =>
    {
        const src = new FakeSource()
        const vm = await Fx.Vm(src)
        src.Failure = new TenantApiError(503, 'registry down')
        assert.equal(await vm.ConfirmAdopt('v2'), AdoptOutcome.Unavailable)
        assert.equal(vm.LastResult?.message, 'registry down')
        src.Failure = new TenantApiError(404, 'gone')
        assert.equal(await vm.ConfirmAdopt('v2'), AdoptOutcome.Unknown)
    })

    it('a non-TenantApiError is Unknown, not Adopted, and the target is unchanged', async () =>
    {
        const src = new FakeSource()
        const vm = await Fx.Vm(src)
        src.Failure = new Error('boom')
        assert.equal(await vm.ConfirmAdopt('v2'), AdoptOutcome.Unknown)
        assert.equal(vm.LastResult?.outcome, AdoptOutcome.Unknown)
        assert.equal(src.Selected.length, 0)
        assert.equal(vm.RunningVersion, 'v3')
    })

    it('empty environments use the no-environments impact and adopt still submits', async () =>
    {
        const src = new FakeSource()
        src.Rollout = { targetVersion: undefined, environments: [] }
        const vm = await Fx.Vm(src)
        assert.match(vm.Impact('v2'), /no environments are bound to this hive/)
        assert.equal(await vm.ConfirmAdopt('v2'), AdoptOutcome.Adopted)
        assert.equal(src.Selected.length, 1)
    })

    it('ApplyEvent reloads only for this hive environments', async () =>
    {
        const src = new FakeSource()
        const vm = await Fx.Vm(src)
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'zz' }), false)
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'e1' }), true)
    })
})

describe('ReleasesViewModel ledger', () =>
{
    it('maps all six actions to friendly labels with a non-empty when', async () =>
    {
        const src = new FakeSource()
        const actions = ['gated', 'ungated', 'withdrawn', 'restored', 'selected', 'adopted']
        src.Ledger = actions.map((action, i) => ({ version: 'v' + i, action, at: '2026-05-0' + (i + 1) + 'T10:30:00.000Z' }))
        const vm = await Fx.Vm(src)
        assert.deepEqual(vm.LedgerRows.map(r => r.actionLabel), ['Gated', 'Ungated', 'Withdrawn', 'Restored', 'Selected as target', 'Adopted'])
        assert.deepEqual(vm.LedgerRows.map(r => r.version), ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
        assert.ok(vm.LedgerRows.every(r => r.whenLabel !== ''))
    })

    it('falls back to the raw action when unmapped', async () =>
    {
        const src = new FakeSource()
        src.Ledger = [{ version: 'v1', action: 'quarantined', at: '2026-05-01T10:30:00.000Z' }]
        const vm = await Fx.Vm(src)
        assert.equal(vm.LedgerRows[0]!.actionLabel, 'quarantined')
    })

    it('has no rows for an empty ledger', async () =>
    {
        const vm = await Fx.Vm(new FakeSource())
        assert.equal(vm.LedgerRows.length, 0)
    })
})
