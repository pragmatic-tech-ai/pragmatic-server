import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import {
    Repository, Cardinality, toJSON, StoragePackageSource, Cypher,
    type PackageDocument,
} from '@pragmatic-tech-ai/todl'
import type { GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EnvironmentGraph, LoadedGraphStore } from '../environment-graph.js'

/** Seeds a packages store with one queryable package, laid out as publish writes it (`<id>/<version>/model.json`). */
class SeededPackages
{
    public static readonly Id = 'shop'
    public static readonly Version = '1.0.0'
    public static readonly GraphName = 'env-graph'
    public static readonly ModelFile = 'model.json'
    public static readonly PathSeparator = '/'
    public static readonly Count = 'MATCH (w:Widget) RETURN count(w) AS n'

    public static async Seed(storage: FakeStorage): Promise<void>
    {
        const document = toJSON(SeededPackages.Repo()) as PackageDocument
        const path = [SeededPackages.Id, SeededPackages.Version, SeededPackages.ModelFile].join(SeededPackages.PathSeparator)
        await storage.WriteText(path, JSON.stringify(document))
    }

    private static Repo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .defineConcept('Element')
            .defineConcept('Widget', 'Element')
            .addField('Widget', 'label', 'string', Cardinality.Optional)
            .setNamespace('shop')
            .assertInstance('Widget', 'shop.hero')
            .setField('shop.hero', 'label', 'Hi')
            .assertInstance('Widget', 'shop.tail')
            .setField('shop.tail', 'label', 'Bye')
            .commit()
        return repo
    }
}

test('Build yields a queryable instance over the packages', async () =>
{
    const storage = new FakeStorage()
    await SeededPackages.Seed(storage)
    const graph = await EnvironmentGraph.Build(new StoragePackageSource(storage), SeededPackages.GraphName, [{ id: SeededPackages.Id, version: SeededPackages.Version }])
    const count = Cypher.CypherEngine.OverQuery(graph.Query()).Execute(SeededPackages.Count).Rows[0]?.[0]
    assert.equal(Number(count instanceof Cypher.ScalarValue ? count.Value : Number.NaN), 2)
})

test('Record returns name, packages and promotedAt', async () =>
{
    const storage = new FakeStorage()
    await SeededPackages.Seed(storage)
    const graph = await EnvironmentGraph.Build(new StoragePackageSource(storage), SeededPackages.GraphName, [{ id: SeededPackages.Id, version: SeededPackages.Version }])
    const record = graph.Record()
    assert.equal(record.name, SeededPackages.GraphName)
    assert.deepEqual(record.packages, [{ id: SeededPackages.Id, version: SeededPackages.Version }])
    assert.equal(typeof record.promotedAt, 'string')
    assert.ok(!Number.isNaN(Date.parse(record.promotedAt)))
})

test('Build over an empty package set yields an empty instance', async () =>
{
    const storage = new FakeStorage()
    const graph = await EnvironmentGraph.Build(new StoragePackageSource(storage), SeededPackages.GraphName, [])
    assert.deepEqual(graph.Record().packages, [])
    assert.ok(graph.Query())
})

test('LoadedGraphStore round-trips a record', async () =>
{
    const storage = new FakeStorage()
    const store = new LoadedGraphStore(storage)
    assert.equal(await store.Read(), null)
    const record: GraphLoadedDto = { name: SeededPackages.GraphName, packages: [{ id: SeededPackages.Id, version: SeededPackages.Version }], promotedAt: new Date().toISOString() }
    await store.Save(record)
    assert.deepEqual(await store.Read(), record)
})
