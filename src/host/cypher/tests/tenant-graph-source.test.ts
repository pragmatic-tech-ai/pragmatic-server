import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Repository, Cypher } from '@pragmatic-tech-ai/todl'
import { TenantGraphComposition } from '../tenant-graph-source.js'

class GraphFixture
{
    public static readonly Concept = 'shop.Customer'
    public static readonly Region = 'region'

    public static Repo(ids: readonly string[]): Repository
    {
        const repo = new Repository()
        const b = repo.builder()
        b.definePrimitive('string')
        b.defineConcept(GraphFixture.Concept)
        b.addField(GraphFixture.Concept, GraphFixture.Region, 'string')
        for (const id of ids)
        {
            b.assertInstance(GraphFixture.Concept, id)
            b.setField(id, GraphFixture.Region, 'eu')
        }
        b.commit()
        return repo
    }

    public static async Count(composition: TenantGraphComposition): Promise<number>
    {
        const query = await TenantGraphComposition.BuildQuery(composition.Compose())
        const engine = Cypher.CypherEngine.OverQuery(query)
        const result = engine.Execute('MATCH (x) RETURN count(x) AS n')
        const cell = result.Rows[0]?.[0]
        return Number(cell instanceof Cypher.ScalarValue ? cell.Value : Number.NaN)
    }
}

test('composes instances from two repositories and answers a count', async () =>
{
    const composition = new TenantGraphComposition([
        { repo: GraphFixture.Repo(['shop.Customer:a1', 'shop.Customer:a2']), model: 'alpha', version: '1.0.0' },
        { repo: GraphFixture.Repo(['shop.Customer:b1']), model: 'beta', version: '1.0.0' },
    ])
    const artifact = composition.Compose()
    assert.deepEqual(artifact.seedNodes.map(n => n.id).sort(), ['shop.Customer:a1', 'shop.Customer:a2', 'shop.Customer:b1'])
    assert.equal(await GraphFixture.Count(composition), 3)
})

test('a node id present identically in two repositories is deduped', async () =>
{
    const composition = new TenantGraphComposition([
        { repo: GraphFixture.Repo(['shop.Customer:x']), model: 'alpha', version: '1.0.0' },
        { repo: GraphFixture.Repo(['shop.Customer:x']), model: 'beta', version: '1.0.0' },
    ])
    assert.equal(composition.Compose().seedNodes.length, 1)
    assert.equal(await GraphFixture.Count(composition), 1)
})

test('a node id with conflicting data across repositories throws', () =>
{
    const other = GraphFixture.Repo([])
    const b = other.builder()
    b.assertInstance(GraphFixture.Concept, 'shop.Customer:x')
    b.setField('shop.Customer:x', GraphFixture.Region, 'us')
    b.commit()
    const composition = new TenantGraphComposition([
        { repo: GraphFixture.Repo(['shop.Customer:x']), model: 'alpha', version: '1.0.0' },
        { repo: other, model: 'beta', version: '1.0.0' },
    ])
    assert.throws(() => composition.Compose(), /conflict/i)
})

test('an empty tenant composes to an empty graph and counts zero', async () =>
{
    const composition = new TenantGraphComposition([])
    assert.equal(composition.Compose().seedNodes.length, 0)
    assert.equal(await GraphFixture.Count(composition), 0)
})

test('seed node ids and edge endpoints equal the Repository instance ids exactly', () =>
{
    const repo = new Repository()
    const b = repo.builder()
    b.definePrimitive('string')
    b.defineConcept('shop.Order')
    b.defineConcept(GraphFixture.Concept)
    b.addField(GraphFixture.Concept, GraphFixture.Region, 'string')
    b.addConceptRelationship('shop.Order', 'buyer', [GraphFixture.Concept])
    b.assertInstance(GraphFixture.Concept, 'shop.Customer:c1')
    b.setField('shop.Customer:c1', GraphFixture.Region, 'eu')
    b.assertInstance('shop.Order', 'shop.Order:o1')
    b.addRelationship('shop.Order:o1', 'buyer', 'shop.Customer:c1')
    b.commit()
    // Same enumeration accessor ModelReadFilter uses: repo.allNodes(), node.id.
    const instanceIds = new Set<string>()
    for (const node of repo.allNodes())
    {
        if (node.type === GraphFixture.Concept || node.type === 'shop.Order') instanceIds.add(node.id)
    }
    assert.equal(instanceIds.size, 2)
    const artifact = new TenantGraphComposition([{ repo, model: 'alpha', version: '1.0.0' }]).Compose()
    assert.deepEqual(new Set(artifact.seedNodes.map(n => n.id)), instanceIds)
    assert.ok(artifact.seedEdges.length >= 1)
    for (const edge of artifact.seedEdges)
    {
        assert.ok(instanceIds.has(edge.from), `edge.from ${edge.from}`)
        assert.ok(instanceIds.has(edge.to), `edge.to ${edge.to}`)
    }
})
