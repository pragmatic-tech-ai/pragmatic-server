import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IStorage, StorageEntry } from '@pragmatic-tech-ai/todl-runtime'
import type { ContributedPackageDto, GraphRefParamsDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DevGraphStore } from '../dev-graph-store.js'
import { GraphPackageConflictError, GraphPackageIngest } from '../graph-package-ingest.js'
import { DevGraphService, GraphExistsError, GraphNameInvalidError, GraphNotFoundError } from '../dev-graph-service.js'

class MemoryStorage implements IStorage
{
    public readonly Root = 'mem'
    public readonly Files = new Map<string, string>()

    public async ReadText(path: string): Promise<string>
    {
        const text = this.Files.get(path)
        if (text === undefined) throw new Error('missing ' + path)
        return text
    }
    public async ReadBytes(path: string): Promise<Uint8Array> { return new TextEncoder().encode(await this.ReadText(path)) }
    public async WriteText(path: string, content: string): Promise<void> { this.Files.set(path, content) }
    public async WriteBytes(path: string, bytes: Uint8Array): Promise<void> { this.Files.set(path, new TextDecoder().decode(bytes)) }
    public async Exists(path: string): Promise<boolean> { return this.Files.has(path) }
    public async Delete(path: string): Promise<void> { this.Files.delete(path) }
    public async CreateDirectory(): Promise<void> {}
    public async Rename(from: string, to: string): Promise<void>
    {
        this.Files.set(to, await this.ReadText(from))
        this.Files.delete(from)
    }
    public async List(): Promise<readonly StorageEntry[]> { return [] }
}

class Fixture
{
    private static readonly GraphName = 'g1'

    public static Service(): DevGraphService
    {
        return Fixture.ServiceOver(new MemoryStorage(), new MemoryStorage())
    }

    public static ServiceOver(graphs: MemoryStorage, packages: MemoryStorage): DevGraphService
    {
        return new DevGraphService(new DevGraphStore(graphs), new GraphPackageIngest(packages))
    }

    public static Pkg(id: string, version: string, modelJson: string = '{}'): ContributedPackageDto
    {
        return { id, version, modelJson }
    }

    public static Keys(packages: readonly { id: string, version: string }[]): string[]
    {
        return packages.map(p => p.id + '@' + p.version)
    }

    public static Create(service: DevGraphService, description: string): Promise<GraphSummaryDto>
    {
        return service.CreateGraph({ graphName: Fixture.GraphName, description })
    }

    public static Ref(): GraphRefParamsDto
    {
        return { graphName: Fixture.GraphName }
    }
}

test('CreateGraph persists a graph with an empty package list', async () =>
{
    const service = Fixture.Service()
    await Fixture.Create(service, 'first')
    const detail = await service.GetGraph(Fixture.Ref())
    assert.deepEqual(detail.packages, [])
    const list = await service.ListGraphs()
    assert.equal(list.length, 1)
    assert.equal(list[0].packageCount, 0)
    assert.equal(list[0].name, 'g1')
    assert.equal(list[0].description, 'first')
})

test('a duplicate graph name is rejected', async () =>
{
    const service = Fixture.Service()
    await Fixture.Create(service, 'a')
    await assert.rejects(Fixture.Create(service, 'b'), GraphExistsError)
})

test('an invalid graph name is rejected', async () =>
{
    const service = Fixture.Service()
    await assert.rejects(service.CreateGraph({ graphName: 'Bad Name', description: '' }), GraphNameInvalidError)
})

test('GetGraph/DeleteGraph on an absent graph reject GraphNotFoundError; after Delete the graph is gone', async () =>
{
    const service = Fixture.Service()
    await assert.rejects(service.DeleteGraph(Fixture.Ref()), GraphNotFoundError)
    await Fixture.Create(service, 'x')
    await service.DeleteGraph(Fixture.Ref())
    await assert.rejects(service.GetGraph(Fixture.Ref()), GraphNotFoundError)
})

test('contributing to a missing graph rejects GraphNotFoundError', async () =>
{
    const service = Fixture.Service()
    await assert.rejects(service.ContributeGraph({ graphName: 'g1', solutionId: 's1', packages: [] }), GraphNotFoundError)
})

test('a first contribution appears in the returned detail and in a fresh GetGraph', async () =>
{
    const graphs = new MemoryStorage()
    const packages = new MemoryStorage()
    const service = Fixture.ServiceOver(graphs, packages)
    await Fixture.Create(service, 'd')
    const detail = await service.ContributeGraph({ graphName: 'g1', solutionId: 's1', packages: [Fixture.Pkg('a', '1'), Fixture.Pkg('b', '1')] })
    assert.deepEqual(Fixture.Keys(detail.packages), ['a@1', 'b@1'])
    const fresh = await Fixture.ServiceOver(graphs, packages).GetGraph(Fixture.Ref())
    assert.deepEqual(Fixture.Keys(fresh.packages), ['a@1', 'b@1'])
    assert.ok(packages.Files.has('a/1/model.json'))
})

test('a second solution unions with the first, deduped, order stable', async () =>
{
    const service = Fixture.Service()
    await Fixture.Create(service, 'd')
    await service.ContributeGraph({ graphName: 'g1', solutionId: 's1', packages: [Fixture.Pkg('a', '1'), Fixture.Pkg('b', '1')] })
    const detail = await service.ContributeGraph({ graphName: 'g1', solutionId: 's2', packages: [Fixture.Pkg('b', '1'), Fixture.Pkg('c', '1')] })
    assert.deepEqual(Fixture.Keys(detail.packages), ['a@1', 'b@1', 'c@1'])
})

test('re-contributing a solution with a dropped package shrinks the union', async () =>
{
    const service = Fixture.Service()
    await Fixture.Create(service, 'd')
    await service.ContributeGraph({ graphName: 'g1', solutionId: 's1', packages: [Fixture.Pkg('a', '1'), Fixture.Pkg('b', '1')] })
    await service.ContributeGraph({ graphName: 'g1', solutionId: 's2', packages: [Fixture.Pkg('c', '1')] })
    const detail = await service.ContributeGraph({ graphName: 'g1', solutionId: 's1', packages: [Fixture.Pkg('a', '1')] })
    assert.deepEqual(Fixture.Keys(detail.packages), ['a@1', 'c@1'])
})

test('two solutions contributing identical id@version yield one union entry and packageCount reflects the union', async () =>
{
    const service = Fixture.Service()
    await Fixture.Create(service, 'd')
    await service.ContributeGraph({ graphName: 'g1', solutionId: 's1', packages: [Fixture.Pkg('a', '1', '{"k":1}')] })
    const detail = await service.ContributeGraph({ graphName: 'g1', solutionId: 's2', packages: [Fixture.Pkg('a', '1', '{"k":1}'), Fixture.Pkg('b', '1')] })
    assert.deepEqual(Fixture.Keys(detail.packages), ['a@1', 'b@1'])
    const list = await service.ListGraphs()
    assert.equal(list[0].packageCount, 2)
})

test('differing bytes for an existing id@version reject and leave the manifest slice unchanged', async () =>
{
    const graphs = new MemoryStorage()
    const packages = new MemoryStorage()
    const service = Fixture.ServiceOver(graphs, packages)
    await Fixture.Create(service, 'd')
    await service.ContributeGraph({ graphName: 'g1', solutionId: 's1', packages: [Fixture.Pkg('a', '1', '{"k":1}')] })
    await service.ContributeGraph({ graphName: 'g1', solutionId: 's2', packages: [Fixture.Pkg('z', '1')] })
    await assert.rejects(
        service.ContributeGraph({ graphName: 'g1', solutionId: 's2', packages: [Fixture.Pkg('y', '1'), Fixture.Pkg('a', '1', '{"k":2}')] }),
        GraphPackageConflictError)
    const fresh = await Fixture.ServiceOver(graphs, packages).GetGraph(Fixture.Ref())
    assert.deepEqual(Fixture.Keys(fresh.packages), ['a@1', 'z@1'])
    assert.equal(packages.Files.has('y/1/model.json'), false)
})

test('an empty contribution sets the slice to empty and the union reflects it', async () =>
{
    const service = Fixture.Service()
    await Fixture.Create(service, 'd')
    await service.ContributeGraph({ graphName: 'g1', solutionId: 's1', packages: [Fixture.Pkg('a', '1')] })
    await service.ContributeGraph({ graphName: 'g1', solutionId: 's2', packages: [Fixture.Pkg('b', '1')] })
    const detail = await service.ContributeGraph({ graphName: 'g1', solutionId: 's1', packages: [] })
    assert.deepEqual(Fixture.Keys(detail.packages), ['b@1'])
})
