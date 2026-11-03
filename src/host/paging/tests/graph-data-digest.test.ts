import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { GraphDataDigest } from '../graph-data-digest.js'

class DigestFixture
{
    public static readonly Labeled = { labels: ['Widget'], wildcard: false, parseFailed: false }
    public static readonly Wildcard = { labels: [], wildcard: true, parseFailed: false }

    public static Graph(nodes: { id: string, type: string, attrs: Record<string, unknown> }[]): IGraphQuery
    {
        const mirrors = nodes.map(node => ({ node }))
        return {
            AllInstances: () => mirrors,
            InstancesOf: (concept: string) => mirrors.filter(m => m.node.type === concept),
            Type: (name: string) => (name === 'Widget' || name === 'Gadget' ? { fullName: name } : undefined),
            Concepts: () => [],
        } as unknown as IGraphQuery
    }
}

test('the digest ignores instance order and attribute key order', () =>
{
    const a = DigestFixture.Graph([{ id: 'w1', type: 'Widget', attrs: { x: 1, y: 2 } }, { id: 'w2', type: 'Widget', attrs: {} }])
    const b = DigestFixture.Graph([{ id: 'w2', type: 'Widget', attrs: {} }, { id: 'w1', type: 'Widget', attrs: { y: 2, x: 1 } }])
    assert.equal(GraphDataDigest.Of(a, DigestFixture.Labeled), GraphDataDigest.Of(b, DigestFixture.Labeled))
})

test('the digest moves with any reachable value, and only with reachable ones for a labeled query', () =>
{
    const base = [{ id: 'w1', type: 'Widget', attrs: { x: 1 } }, { id: 'g1', type: 'Gadget', attrs: { x: 1 } }]
    const before = GraphDataDigest.Of(DigestFixture.Graph(base), DigestFixture.Labeled)
    const widgetEdited = DigestFixture.Graph([{ id: 'w1', type: 'Widget', attrs: { x: 2 } }, base[1]!])
    const gadgetEdited = DigestFixture.Graph([base[0]!, { id: 'g1', type: 'Gadget', attrs: { x: 2 } }])
    assert.notEqual(GraphDataDigest.Of(widgetEdited, DigestFixture.Labeled), before)
    assert.equal(GraphDataDigest.Of(gadgetEdited, DigestFixture.Labeled), before)
    assert.notEqual(GraphDataDigest.Of(gadgetEdited, DigestFixture.Wildcard), GraphDataDigest.Of(DigestFixture.Graph(base), DigestFixture.Wildcard))
})

test('duplicate ids in any row order digest the same, and a class (term-fixed values) change moves it', () =>
{
    const one = { id: 'w1', type: 'Widget', attrs: { x: 1 } }
    const two = { id: 'w1', type: 'Widget', attrs: { x: 2 } }
    assert.equal(GraphDataDigest.Of(DigestFixture.Graph([one, two]), DigestFixture.Labeled), GraphDataDigest.Of(DigestFixture.Graph([two, one]), DigestFixture.Labeled))
    const classed = { ...one, class: 'Gold' } as typeof one
    assert.notEqual(GraphDataDigest.Of(DigestFixture.Graph([classed]), DigestFixture.Labeled), GraphDataDigest.Of(DigestFixture.Graph([one]), DigestFixture.Labeled))
})
