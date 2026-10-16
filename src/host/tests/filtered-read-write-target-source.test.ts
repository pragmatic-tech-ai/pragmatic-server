import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FilteredReadWriteTargetSource } from '../filtered-read-write-target-source.js'

class FakeGraph
{
    constructor(private readonly rows: Record<string, Record<string, string>>, private readonly nodes: Record<string, Record<string, string>> = {}) {}
    public InstancesOf(_concept: string): unknown[]
    {
        return Object.entries(this.nodes).map(([nodeId, row]) => ({ node: { id: nodeId }, type: { fullName: 'shop.Widget' }, field: (n: string) => (n in row ? { value: row[n] } : undefined) }))
    }

    public Reflect(id: string): unknown
    {
        const row = this.rows[id]
        if (row === undefined)
        {
            return undefined
        }
        return { node: { id }, type: { fullName: 'shop.Widget' }, field: (n: string) => (n in row ? { value: row[n] } : undefined) }
    }
}

class FakeServer
{
    public calls: string[] = []
    constructor(private readonly graph: FakeGraph) {}
    public async GraphForPragmaticApp(_ctx: unknown, _name: string, labels: { labels: readonly string[] }): Promise<unknown>
    {
        this.calls.push(labels.labels[0])
        return this.graph
    }
}

test('Fetch reflects a row to a view and returns undefined for a missing id', async () =>
{
    const server = new FakeServer(new FakeGraph({ w1: { owningBu: 'sales' } }))
    const src = new FilteredReadWriteTargetSource(server as never, {} as never, 'demo')
    const view = await src.Fetch('shop.Widget', 'w1')
    assert.equal(view?.Concept, 'shop.Widget')
    assert.equal(view?.Field('owningBu'), 'sales')
    assert.equal(await src.Fetch('shop.Widget', 'ghost'), undefined)
})

test('the per-concept filtered graph is built once across repeated fetches', async () =>
{
    const server = new FakeServer(new FakeGraph({ w1: { owningBu: 'sales' }, w2: { owningBu: 'sales' } }))
    const src = new FilteredReadWriteTargetSource(server as never, {} as never, 'demo')
    await src.Fetch('shop.Widget', 'w1')
    await src.Fetch('shop.Widget', 'w2')
    await src.Fetch('shop.Gadget', 'g1')
    assert.deepEqual(server.calls, ['shop.Widget', 'shop.Gadget'])
})

class KeyCases
{
    public static Source(nodes: Record<string, Record<string, string>>): FilteredReadWriteTargetSource
    {
        return new FilteredReadWriteTargetSource(new FakeServer(new FakeGraph({}, nodes)) as never, {} as never, 'demo')
    }
}

test('a connector-style node id resolves for the bare key', async () =>
{
    const src = KeyCases.Source({ 'shop.Widget#builtin#u-123': { owningBu: 'sales' } })
    assert.equal((await src.Fetch('shop.Widget', 'u-123'))?.Field('owningBu'), 'sales')
})

test('a model-style node id resolves for the bare name', async () =>
{
    const src = KeyCases.Source({ 'shop.w0': { owningBu: 'root' } })
    assert.equal((await src.Fetch('shop.Widget', 'w0'))?.Field('owningBu'), 'root')
})

test('an ambiguous bare key resolves to nothing', async () =>
{
    const src = KeyCases.Source({ 'a.w0': { owningBu: 'x' }, 'b.w0': { owningBu: 'y' } })
    assert.equal(await src.Fetch('shop.Widget', 'w0'), undefined)
})

test('an empty id resolves to nothing', async () =>
{
    const src = KeyCases.Source({ 'shop.Widget#builtin#': { owningBu: 'x' }, 'shop.w0': { owningBu: 'y' } })
    assert.equal(await src.Fetch('shop.Widget', ''), undefined)
})

test('a non-matching or only-suffix-matching id resolves to nothing', async () =>
{
    const src = KeyCases.Source({ 'shop.Widget#builtin#xw0': { owningBu: 'x' }, 'shop.vw0': { owningBu: 'y' } })
    assert.equal(await src.Fetch('shop.Widget', 'w0'), undefined)
    assert.equal(await src.Fetch('shop.Widget', 'ghost'), undefined)
})
