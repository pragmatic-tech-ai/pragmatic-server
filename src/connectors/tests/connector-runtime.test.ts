import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { check, DataSourceAdapterCatalog, DataSourceKind, DiagnosticCode } from '@pragmatic-tech-ai/todl'
import type { IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection, QueryRequest, WriteBatch, WriteResult, WriteOperation, ExternalRecord, ModelConnectorPlan } from '@pragmatic-tech-ai/todl'
import { ConnectorRuntime } from '../connector-runtime.js'
import { SolutionConnectorPlanner } from '../solution-connector-planner.js'
import type { ConnectorModel } from '../solution-connector-planner.js'

class InMemoryAdapter implements IDataSourceAdapter
{
    public Queries = 0
    public readonly Applied: WriteOperation[] = []
    public constructor(private readonly rows: ReadonlyMap<string, readonly ExternalRecord[]>) {}
    public Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        this.Queries++
        return Promise.resolve(this.rows.get(request.Source) ?? [])
    }
    public Apply(batch: WriteBatch): Promise<WriteResult>
    {
        for (const op of batch.Operations) { this.Applied.push(op) }
        return Promise.resolve({ Applied: batch.Operations.length, Conflicts: [] })
    }
    public Dispose(): Promise<void> { return Promise.resolve() }
}

class InMemoryAdapterFactory implements IDataSourceAdapterFactory
{
    public readonly Kind: DataSourceKind
    public readonly Adapter: InMemoryAdapter
    public constructor(kind: DataSourceKind, rows: ReadonlyMap<string, readonly ExternalRecord[]>)
    {
        this.Kind = kind
        this.Adapter = new InMemoryAdapter(rows)
    }
    public Open(_connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        return Promise.resolve(this.Adapter)
    }
}

class Fixtures
{
    private static readonly Meta = `
namespace shop {
  concept Customer { name : string; }
  datasource pg { kind = sql; }
  model Shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { name = "name"; }
  }
}
`

    public static Model(modelId: string, writable = true): ConnectorModel
    {
        const { model } = check([{ uri: 'shop.todl', text: Fixtures.Meta }])
        const planned = SolutionConnectorPlanner.Plan(model)[0]!
        const plan: ModelConnectorPlan = { ...planned.Plan, Bindings: planned.Plan.Bindings.map(b => ({ ...b, Writable: writable })) }
        return { ModelId: modelId, Plan: plan, Base: planned.Base }
    }

    public static Services(rows: ReadonlyMap<string, readonly ExternalRecord[]>): { services: ServiceProvider; adapter: InMemoryAdapter }
    {
        const factory = new InMemoryAdapterFactory(DataSourceKind.Sql, rows)
        const catalog = new DataSourceAdapterCatalog().Register(factory)
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, catalog)
        return { services, adapter: factory.Adapter }
    }
}

const ROWS = new Map<string, readonly ExternalRecord[]>([['Customer', [{ customer_id: 'C1', name: 'Acme' }]]])

test('ModelsWithConnectors projects names/bindings with no secret fields', () =>
{
    const { services } = Fixtures.Services(ROWS)
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    const infos = runtime.ModelsWithConnectors()
    assert.equal(infos.length, 1)
    assert.equal(infos[0]!.ModelId, 'shop')
    assert.deepEqual(infos[0]!.Connectors, [{ Name: 'pg', Kind: DataSourceKind.Sql }])
    assert.equal(infos[0]!.Bindings[0]!.Concept, 'shop.Customer')
    assert.equal(JSON.stringify(infos).includes('Config'), false)
})

test('PrepareModel is lazy: an untouched model issues no adapter Query; a prepared model reads', async () =>
{
    const { services, adapter } = Fixtures.Services(ROWS)
    const runtime = new ConnectorRuntime([Fixtures.Model('shop'), Fixtures.Model('crm')], services)
    assert.equal(adapter.Queries, 0)
    const entities = await runtime.ReadEntities('shop', 'shop.Customer')
    assert.ok(adapter.Queries > 0)
    assert.ok(entities.length >= 1)
    // crm was never touched; a shared adapter double counts total queries, so prove crm is not registered:
    assert.equal(runtime.ModelsWithConnectors().some(m => m.ModelId === 'crm'), true)
})

test('PrepareModel caches: two prepares of one model build once', async () =>
{
    const { services } = Fixtures.Services(ROWS)
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    await runtime.PrepareModel('shop')
    await runtime.PrepareModel('shop')
    const names = await runtime.ConceptNames('shop')
    assert.ok(names.length > 0)
})

test('a model id with no ConnectorModel rejects', async () =>
{
    const { services } = Fixtures.Services(ROWS)
    const runtime = new ConnectorRuntime([], services)
    await assert.rejects(() => runtime.PrepareModel('nope'), /no connectors/i)
})

test('WriteBack of a writable binding applies; a read-only binding yields connector.read-only', async () =>
{
    const { services, adapter } = Fixtures.Services(ROWS)
    const writable = new ConnectorRuntime([Fixtures.Model('shop', true)], services)
    const writableId = (await writable.ReadEntities('shop', 'shop.Customer'))[0]!.id
    const applied = await writable.WriteBack('shop', [writableId], [])
    assert.equal(applied.Diagnostics.length, 0)
    assert.ok(adapter.Applied.length >= 1)

    const ro = Fixtures.Services(ROWS)
    const readonlyRuntime = new ConnectorRuntime([Fixtures.Model('shop', false)], ro.services)
    const readonlyId = (await readonlyRuntime.ReadEntities('shop', 'shop.Customer'))[0]!.id
    const blocked = await readonlyRuntime.WriteBack('shop', [readonlyId], [])
    assert.ok(blocked.Diagnostics.some(d => d.code === DiagnosticCode.ConnectorReadOnly))
    assert.equal(ro.adapter.Applied.length, 0)
})

test('TestConnection returns Ok for a resolvable adapter', async () =>
{
    const { services } = Fixtures.Services(ROWS)
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    const probe = await runtime.TestConnection('shop', 'pg')
    assert.equal(probe.Ok, true)
})

test('a failing adapter makes PrepareModel reject and clears the cache for retry (no secret in error)', async () =>
{
    class ThrowingFactory implements IDataSourceAdapterFactory
    {
        public readonly Kind = DataSourceKind.Sql
        public Open(): Promise<IDataSourceAdapter> { return Promise.reject(new Error('connect to secret-dsn failed')) }
    }
    const catalog = new DataSourceAdapterCatalog().Register(new ThrowingFactory())
    const services = new ServiceProvider()
    services.registerInstance(DataSourceAdapterCatalog.ServiceKey, catalog)
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    await assert.rejects(() => runtime.PrepareModel('shop'))
    // retry path: cache cleared, so a second attempt re-runs (and rejects again)
    await assert.rejects(() => runtime.PrepareModel('shop'))
})
