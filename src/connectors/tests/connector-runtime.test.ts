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
    public OpenCount = 0
    public readonly Adapters: InMemoryAdapter[] = []
    public constructor(kind: DataSourceKind, private readonly rows: ReadonlyMap<string, readonly ExternalRecord[]>) { this.Kind = kind }
    public Open(_connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        this.OpenCount++
        const adapter = new InMemoryAdapter(this.rows)
        this.Adapters.push(adapter)
        return Promise.resolve(adapter)
    }
}

class FlakyAdapterFactory extends InMemoryAdapterFactory
{
    public override Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        if (this.OpenCount === 0)
        {
            this.OpenCount++
            return Promise.reject(new Error('connect to secret-dsn failed'))
        }
        return super.Open(connection)
    }
}

class AlwaysFailingFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Sql
    public Open(): Promise<IDataSourceAdapter> { return Promise.reject(new Error('connect to secret-dsn failed')) }
}

class Fixtures
{
    private static readonly ShopMeta = `
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

    private static readonly CrmMeta = `
namespace crm {
  concept Account { label : string; }
  datasource acct { kind = sql; }
  model Crm : crm {
    annotate entrypoint { }
    connect acct;
    populate Account key account_id { label = "label"; }
  }
}
`

    private static readonly Rows = new Map<string, readonly ExternalRecord[]>([
        ['Customer', [{ customer_id: 'C1', name: 'Acme' }]],
        ['Account', [{ account_id: 'A1', label: 'Globex' }]],
    ])

    public static Model(modelId: string, writable = true): ConnectorModel
    {
        const text = modelId === 'crm' ? Fixtures.CrmMeta : Fixtures.ShopMeta
        const { model } = check([{ uri: `${modelId}.todl`, text }])
        const planned = SolutionConnectorPlanner.Plan(model)[0]!
        const plan: ModelConnectorPlan = { ...planned.Plan, Bindings: planned.Plan.Bindings.map(b => ({ ...b, Writable: writable })) }
        return { ModelId: modelId, Plan: plan, Base: planned.Base }
    }

    public static Services(factory?: InMemoryAdapterFactory): { services: ServiceProvider; factory: InMemoryAdapterFactory }
    {
        const used = factory ?? new InMemoryAdapterFactory(DataSourceKind.Sql, Fixtures.Rows)
        return { services: Fixtures.ServicesFor(used), factory: used }
    }

    public static ServicesFor(factory: IDataSourceAdapterFactory): ServiceProvider
    {
        const catalog = new DataSourceAdapterCatalog().Register(factory)
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, catalog)
        return services
    }

    public static FiveCustomers(): InMemoryAdapterFactory
    {
        const rows = new Map<string, readonly ExternalRecord[]>([
            ['Customer', ['C5', 'C2', 'C4', 'C1', 'C3'].map(id => ({ customer_id: id, name: `n${id}` }))],
        ])
        return new InMemoryAdapterFactory(DataSourceKind.Sql, rows)
    }

    public static Flaky(): InMemoryAdapterFactory
    {
        return new FlakyAdapterFactory(DataSourceKind.Sql, Fixtures.Rows)
    }
}

test('ModelsWithConnectors projects names/bindings with no secret fields', () =>
{
    const { services } = Fixtures.Services()
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    const infos = runtime.ModelsWithConnectors()
    assert.equal(infos.length, 1)
    assert.equal(infos[0]!.ModelId, 'shop')
    assert.deepEqual(infos[0]!.Connectors, [{ Name: 'pg', Kind: DataSourceKind.Sql }])
    assert.equal(infos[0]!.Bindings[0]!.Concept, 'shop.Customer')
    assert.equal(JSON.stringify(infos).includes('Config'), false)
})

test('PrepareModel is lazy: only the touched model opens its connector', async () =>
{
    const { services, factory } = Fixtures.Services()
    const runtime = new ConnectorRuntime([Fixtures.Model('shop'), Fixtures.Model('crm')], services)
    assert.equal(factory.OpenCount, 0)
    const entities = (await runtime.ReadEntities('shop', 'shop.Customer')).Entities
    assert.ok(entities.length >= 1)
    assert.equal(factory.OpenCount, 1)
})

test('PrepareModel caches: two prepares of one model open the connector once', async () =>
{
    const { services, factory } = Fixtures.Services()
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    await runtime.PrepareModel('shop')
    await runtime.PrepareModel('shop')
    assert.equal(factory.OpenCount, 1)
    assert.ok((await runtime.ConceptNames('shop')).length > 0)
})

test('a model id with no ConnectorModel rejects', async () =>
{
    const { services } = Fixtures.Services()
    const runtime = new ConnectorRuntime([], services)
    await assert.rejects(() => runtime.PrepareModel('nope'), /no connectors/i)
})

test('WriteBack of a writable binding applies; a read-only binding yields connector.read-only', async () =>
{
    const w = Fixtures.Services()
    const writable = new ConnectorRuntime([Fixtures.Model('shop', true)], w.services)
    const writableId = (await writable.ReadEntities('shop', 'shop.Customer')).Entities[0]!.id
    const applied = await writable.WriteBack('shop', [writableId], [])
    assert.equal(applied.Diagnostics.length, 0)
    assert.ok(w.factory.Adapters[0]!.Applied.length >= 1)

    const ro = Fixtures.Services()
    const readonlyRuntime = new ConnectorRuntime([Fixtures.Model('shop', false)], ro.services)
    const readonlyId = (await readonlyRuntime.ReadEntities('shop', 'shop.Customer')).Entities[0]!.id
    const blocked = await readonlyRuntime.WriteBack('shop', [readonlyId], [])
    assert.ok(blocked.Diagnostics.some(d => d.code === DiagnosticCode.ConnectorReadOnly))
    assert.equal(ro.factory.Adapters[0]!.Applied.length, 0)
})

test('TestConnection returns Ok for a resolvable adapter', async () =>
{
    const { services } = Fixtures.Services()
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    const probe = await runtime.TestConnection('shop', 'pg')
    assert.equal(probe.Ok, true)
})

test('TestConnection on a failing adapter returns a sanitized failure with no secret', async () =>
{
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], Fixtures.ServicesFor(new AlwaysFailingFactory()))
    const probe = await runtime.TestConnection('shop', 'pg')
    assert.equal(probe.Ok, false)
    assert.equal(probe.Detail, 'connection probe failed')
    assert.equal(JSON.stringify(probe).includes('secret-dsn'), false)
})

test('TestConnection on an unknown connector name reports unknown connector', async () =>
{
    const { services } = Fixtures.Services()
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    const probe = await runtime.TestConnection('shop', 'nope')
    assert.deepEqual(probe, { Ok: false, Detail: 'unknown connector' })
})

test('a failed PrepareModel clears the cache so a retry re-opens and succeeds', async () =>
{
    const { services, factory } = Fixtures.Services(Fixtures.Flaky())
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    await assert.rejects(() => runtime.PrepareModel('shop'))
    await runtime.PrepareModel('shop')
    assert.equal(factory.OpenCount, 2)
})

test('ReadEntities pages by id order with HasMore', async () =>
{
    const { services } = Fixtures.Services(Fixtures.FiveCustomers())
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    const pages = [
        await runtime.ReadEntities('shop', 'shop.Customer', { Skip: 0, Take: 2 }),
        await runtime.ReadEntities('shop', 'shop.Customer', { Skip: 2, Take: 2 }),
        await runtime.ReadEntities('shop', 'shop.Customer', { Skip: 4, Take: 2 }),
    ]
    assert.deepEqual(pages.map(p => p.Entities.length), [2, 2, 1])
    assert.deepEqual(pages.map(p => p.HasMore), [true, true, false])
    const ids = pages.flatMap(p => p.Entities.map(e => e.id))
    assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    assert.equal(new Set(ids).size, 5)
})

test('unpaged ReadEntities returns all', async () =>
{
    const { services } = Fixtures.Services(Fixtures.FiveCustomers())
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    const all = await runtime.ReadEntities('shop', 'shop.Customer')
    assert.equal(all.Entities.length, 5)
    assert.equal(all.HasMore, false)
})

test('Revision changes after WriteBack and differs across runtimes', async () =>
{
    const { services } = Fixtures.Services(Fixtures.FiveCustomers())
    const runtime = new ConnectorRuntime([Fixtures.Model('shop')], services)
    const other = new ConnectorRuntime([Fixtures.Model('shop')], services)
    const before = runtime.Revision
    assert.notEqual(before, other.Revision)
    const id = (await runtime.ReadEntities('shop', 'shop.Customer')).Entities[0]!.id
    await runtime.WriteBack('shop', [id], [])
    assert.notEqual(runtime.Revision, before)
})
