import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeStorage, ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import {
    Repository, Cardinality, toJSON, Cypher, compilePackage, BlobPackageStore, StoragePackageSink,
    DataSourceAdapterCatalog, DataSourceKind,
    type PackageDocument, type IDataSourceAdapter, type IDataSourceAdapterFactory, type ExternalRecord, type QueryRequest,
    type WriteBatch, type WriteResult, type ResolvedConnection,
} from '@pragmatic-tech-ai/todl'
import type { GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EnvironmentGraph, EnvironmentGraphOverlay, LoadedGraphStore } from '../environment-graph.js'

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
    const graph = await EnvironmentGraph.Build(storage, SeededPackages.GraphName, [{ id: SeededPackages.Id, version: SeededPackages.Version }])
    const count = Cypher.CypherEngine.OverQuery(graph.Base()).Execute(SeededPackages.Count).Rows[0]?.[0]
    assert.equal(Number(count instanceof Cypher.ScalarValue ? count.Value : Number.NaN), 2)
})

test('Record returns name, packages and promotedAt', async () =>
{
    const storage = new FakeStorage()
    await SeededPackages.Seed(storage)
    const graph = await EnvironmentGraph.Build(storage, SeededPackages.GraphName, [{ id: SeededPackages.Id, version: SeededPackages.Version }])
    const record = graph.Record()
    assert.equal(record.name, SeededPackages.GraphName)
    assert.deepEqual(record.packages, [{ id: SeededPackages.Id, version: SeededPackages.Version }])
    assert.equal(typeof record.promotedAt, 'string')
    assert.ok(!Number.isNaN(Date.parse(record.promotedAt)))
})

test('Build over an empty package set yields an empty instance', async () =>
{
    const storage = new FakeStorage()
    const graph = await EnvironmentGraph.Build(storage, SeededPackages.GraphName, [])
    assert.deepEqual(graph.Record().packages, [])
    assert.ok(graph.Base())
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

class MutableAdapter implements IDataSourceAdapter
{
    public constructor(private readonly factory: MutableFactory) {}
    public Query(_request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        if (this.factory.Failure !== undefined)
        {
            return Promise.reject(this.factory.Failure)
        }
        return Promise.resolve(this.factory.Rows)
    }
    public Apply(batch: WriteBatch): Promise<WriteResult>
    {
        return Promise.resolve({ Applied: batch.Operations.length, Failures: [] })
    }
    public Dispose(): Promise<void> { return Promise.resolve() }
}

class MutableFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Sql
    public Rows: readonly ExternalRecord[] = []
    public Failure: Error | undefined
    public Open(_connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        return Promise.resolve(new MutableAdapter(this))
    }
}

class ConnectorPackages
{
    public static readonly Id = 'crm'
    public static readonly Version = '1.0.0'
    public static readonly Concept = 'crm.Customer'
    private static readonly SourceUri = 'crm.todl'
    private static readonly Todl = `
namespace crm {
  concept Customer { name : string; }
  datasource pg { kind = sql; database = "app"; }
  model Crm : crm {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { name = "name"; }
  }
}
`

    public static async Seed(storage: FakeStorage): Promise<void>
    {
        const outcome = compilePackage([], [{ uri: ConnectorPackages.SourceUri, text: ConnectorPackages.Todl }], { id: ConnectorPackages.Id, version: ConnectorPackages.Version })
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(storage)).persist(outcome.package!)
    }

    public static async Build(): Promise<EnvironmentGraph>
    {
        const storage = new FakeStorage()
        await ConnectorPackages.Seed(storage)
        return EnvironmentGraph.Build(storage, SeededPackages.GraphName, [{ id: ConnectorPackages.Id, version: ConnectorPackages.Version }])
    }

    public static Services(factory: MutableFactory): ServiceProvider
    {
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, new DataSourceAdapterCatalog().Register(factory))
        return services
    }

    public static Rows(...ids: string[]): ExternalRecord[]
    {
        return ids.map(id => ({ customer_id: id, name: `n${id}` }))
    }
}

test('a plain env graph (no connector bindings) returns the base query unchanged', async () =>
{
    const storage = new FakeStorage()
    await SeededPackages.Seed(storage)
    const graph = await EnvironmentGraph.Build(storage, SeededPackages.GraphName, [{ id: SeededPackages.Id, version: SeededPackages.Version }])
    const overlaid = await EnvironmentGraphOverlay.Apply(graph, new ServiceProvider())
    assert.equal(overlaid, graph.Base())
    assert.equal(overlaid.AllInstances().length, graph.Base().AllInstances().length)
})

test('a connector-backed concept is served from the adapter snapshot', async () =>
{
    const graph = await ConnectorPackages.Build()
    const factory = new MutableFactory()
    factory.Rows = ConnectorPackages.Rows('C1', 'C2')
    const overlaid = await EnvironmentGraphOverlay.Apply(graph, ConnectorPackages.Services(factory))
    assert.equal(overlaid.InstancesOf(ConnectorPackages.Concept).length, 2)
})

test('read-through: a second query reflects changed adapter rows', async () =>
{
    const graph = await ConnectorPackages.Build()
    const factory = new MutableFactory()
    const services = ConnectorPackages.Services(factory)
    factory.Rows = ConnectorPackages.Rows('C1', 'C2')
    const first = await EnvironmentGraphOverlay.Apply(graph, services)
    factory.Rows = ConnectorPackages.Rows('C1', 'C2', 'C3')
    const second = await EnvironmentGraphOverlay.Apply(graph, services)
    assert.equal(first.InstancesOf(ConnectorPackages.Concept).length, 2)
    assert.equal(second.InstancesOf(ConnectorPackages.Concept).length, 3)
})

test('empty source yields an empty concept, not an error', async () =>
{
    const graph = await ConnectorPackages.Build()
    const overlaid = await EnvironmentGraphOverlay.Apply(graph, ConnectorPackages.Services(new MutableFactory()))
    assert.deepEqual(overlaid.InstancesOf(ConnectorPackages.Concept), [])
})

test('a throwing adapter propagates', async () =>
{
    const graph = await ConnectorPackages.Build()
    const factory = new MutableFactory()
    factory.Failure = new Error('adapter boom')
    await assert.rejects(EnvironmentGraphOverlay.Apply(graph, ConnectorPackages.Services(factory)), /adapter boom/)
})
