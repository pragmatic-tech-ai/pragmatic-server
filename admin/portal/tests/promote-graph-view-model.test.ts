import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { EnvironmentDto, GraphDto, PromotionResultDto } from '../src/portal-types.js'
import { PromoteGraphViewModel } from '../src/promote-graph-view-model.js'
import type { IPromoteGraphSource } from '../src/promote-graph-view-model.js'

class FakeSource implements IPromoteGraphSource
{
    public ListedFor: string[] = []
    public Promotions: Array<{ source: string; graph: string; target: string }> = []

    public async ListGraphs(envName: string): Promise<GraphDto[]>
    {
        this.ListedFor.push(envName)
        return [{ name: 'g1', description: '', packageCount: 2, createdAt: '' }]
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return [FakeSource.Env('dev1', 'development'), FakeSource.Env('rt1', 'runtime'), FakeSource.Env('rt2', 'runtime')]
    }

    public async PromoteGraph(source: string, graph: string, target: string): Promise<PromotionResultDto>
    {
        this.Promotions.push({ source, graph, target })
        return { graphName: graph, packageCount: 2, targetEnv: target }
    }

    private static Env(name: string, type: string): EnvironmentDto
    {
        return { name, template: '', type, environmentId: '', hostPort: 0, status: '', createdAt: '', httpUrl: '', wsUrl: '' }
    }
}

describe('PromoteGraphViewModel', () =>
{
    it('Load fetches the dev graphs and keeps only runtime environments', async () =>
    {
        const source = new FakeSource()
        const vm = new PromoteGraphViewModel(source, 'dev1')
        await vm.Load()
        assert.deepEqual(source.ListedFor, ['dev1'])
        assert.deepEqual(vm.Graphs.map(g => g.name), ['g1'])
        assert.deepEqual(vm.Targets.map(t => t.name), ['rt1', 'rt2'])
    })

    it('Promote calls the client with the selected graph and target', async () =>
    {
        const source = new FakeSource()
        const vm = new PromoteGraphViewModel(source, 'dev1')
        await vm.Load()
        vm.SelectedGraph = 'g1'
        vm.SelectedTargetEnv = 'rt2'
        const result = await vm.Promote()
        assert.deepEqual(source.Promotions, [{ source: 'dev1', graph: 'g1', target: 'rt2' }])
        assert.equal(result.targetEnv, 'rt2')
    })

    it('Promote rejects when nothing is selected', async () =>
    {
        const source = new FakeSource()
        const vm = new PromoteGraphViewModel(source, 'dev1')
        await assert.rejects(() => vm.Promote())
        assert.equal(source.Promotions.length, 0)
    })
})
