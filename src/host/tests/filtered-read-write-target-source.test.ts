import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FilteredReadWriteTargetSource } from '../filtered-read-write-target-source.js'

class FakeGraph
{
    constructor(private readonly rows: Record<string, Record<string, string>>) {}
    public InstancesOf(_concept: string): unknown[]
    {
        return []
    }

    public Reflect(id: string): unknown
    {
        const row = this.rows[id]
        if (row === undefined)
        {
            return undefined
        }
        return { type: { fullName: 'shop.Widget' }, field: (n: string) => (n in row ? { value: row[n] } : undefined) }
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
