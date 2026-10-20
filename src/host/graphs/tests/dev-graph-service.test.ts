import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IStorage, StorageEntry } from '@pragmatic-tech-ai/todl-runtime'
import type { GraphRefParamsDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DevGraphStore } from '../dev-graph-store.js'
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
        return new DevGraphService(new DevGraphStore(new MemoryStorage()))
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
