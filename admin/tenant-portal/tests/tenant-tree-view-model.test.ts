import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SelectionKind, TenantTreeViewModel } from '../src/tenant-tree-view-model.js'
import type { ITreeSource } from '../src/tenant-tree-view-model.js'
import { TenantEventType } from '../src/tenant-types.js'
import type { EnvironmentDto, HiveDto } from '../src/tenant-types.js'

class Make
{
    public static Hive(id: string): HiveDto
    {
        return { id, tenantId: 't', displayName: 'Hive ' + id, cluster: { backend: 'docker', mode: 'single' }, registry: { mode: 'local' }, createdAt: '' }
    }

    public static Env(name: string, hiveId: string | undefined, status = 'running'): EnvironmentDto
    {
        return { name, template: 'x', type: 'runtime', environmentId: name, hiveId, hostPort: 1, status, createdAt: '', httpUrl: '', wsUrl: '' }
    }
}

class FakeTreeSource implements ITreeSource
{
    public HiveCalls = 0
    public EnvCalls = 0
    public Hives: HiveDto[] = []
    public Envs: EnvironmentDto[] = []

    public async ListHives(): Promise<HiveDto[]>
    {
        this.HiveCalls++
        return this.Hives
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        this.EnvCalls++
        return this.Envs
    }
}

describe('TenantTreeViewModel', () =>
{
    it('groups environments under their hive and drops unbound / orphaned ones', async () =>
    {
        const src = new FakeTreeSource()
        src.Hives = [Make.Hive('h1'), Make.Hive('h2')]
        src.Envs = [Make.Env('a', 'h1'), Make.Env('b', 'h2'), Make.Env('c', 'h1'), Make.Env('loose', undefined), Make.Env('orphan', 'gone')]
        const vm = new TenantTreeViewModel(src)
        let raised = 0
        vm.PropertyChanged(TenantTreeViewModel.NodesProperty).subscribe(() => { raised++ })
        await vm.Load()
        assert.equal(vm.Nodes.length, 2)
        assert.deepEqual(vm.Nodes[0]!.environments.map(e => e.name), ['a', 'c'])
        assert.deepEqual(vm.Nodes[1]!.environments.map(e => e.name), ['b'])
        assert.ok(raised > 0)
    })

    it('yields empty Nodes with no hives', async () =>
    {
        const vm = new TenantTreeViewModel(new FakeTreeSource())
        await vm.Load()
        assert.equal(vm.Nodes.length, 0)
    })

    it('re-pulls on EnvironmentChanged for an env in the tree', async () =>
    {
        const src = new FakeTreeSource()
        src.Hives = [Make.Hive('h1')]
        src.Envs = [Make.Env('a', 'h1', 'running')]
        const vm = new TenantTreeViewModel(src)
        await vm.Load()
        src.Envs = [Make.Env('a', 'h1', 'stopped')]
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'a' }), true)
        assert.equal(src.EnvCalls, 2)
        assert.equal(vm.Nodes[0]!.environments[0]!.status, 'stopped')
    })

    it('ignores events for unknown environments and other event types', async () =>
    {
        const src = new FakeTreeSource()
        src.Hives = [Make.Hive('h1')]
        src.Envs = [Make.Env('a', 'h1')]
        const vm = new TenantTreeViewModel(src)
        await vm.Load()
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'zzz' }), false)
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.HealthChanged, environmentName: 'a' }), false)
        assert.equal(src.EnvCalls, 1)
    })

    it('Select raises change and Selected reflects it', () =>
    {
        const vm = new TenantTreeViewModel(new FakeTreeSource())
        let raised = 0
        vm.PropertyChanged(TenantTreeViewModel.SelectedProperty).subscribe(() => { raised++ })
        const hive = Make.Hive('h1')
        assert.equal(vm.Selected, undefined)
        vm.Select({ kind: SelectionKind.Hive, hive })
        assert.equal(raised, 1)
        assert.deepEqual(vm.Selected, { kind: SelectionKind.Hive, hive })
    })

    it('discards a stale Load that resolves after a newer one', async () =>
    {
        const releases: Array<() => void> = []
        const calls: EnvironmentDto[][] = [[Make.Env('a', 'h1', 'stale')], [Make.Env('a', 'h1', 'fresh')]]
        let n = 0
        const src: ITreeSource = {
            ListHives: async () => [Make.Hive('h1')],
            ListEnvironments: () =>
            {
                const result = calls[n++]!
                return new Promise<EnvironmentDto[]>(resolve => { releases.push(() => resolve(result)) })
            },
        }
        const vm = new TenantTreeViewModel(src)
        const first = vm.Load()
        const second = vm.Load()
        await Promise.resolve()
        await Promise.resolve()
        releases[1]!()
        await second
        releases[0]!()
        await first
        assert.equal(vm.Nodes[0]!.environments[0]!.status, 'fresh')
    })
})
