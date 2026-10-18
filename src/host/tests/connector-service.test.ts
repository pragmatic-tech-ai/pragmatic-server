import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { check, DataSourceAdapterCatalog, DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { ConnectorSpec, IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection, QueryRequest, WriteBatch, WriteResult, ExternalRecord } from '@pragmatic-tech-ai/todl'
import { SolutionConnectorPlanner } from '../../connectors/solution-connector-planner.js'
import { ConnectorRuntime } from '../../connectors/connector-runtime.js'
import { PagingLimits } from '../../config/paging-limits.js'
import { AppWriteStatus, ConnectorWriteOp } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ConnectorService } from '../connector-service.js'

const META = `
namespace shop {
  concept Customer { name : string; }
  datasource pg { kind = sql; }
  model shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { name = "name"; }
  }
}
`

const META_TWO = `
namespace shop {
  concept Customer { name : string; }
  concept Order { total : string; }
  datasource pg { kind = sql; }
  datasource rest { kind = rest; }
  model shop : shop {
    annotate entrypoint { }
    connect pg;
    connect rest;
    populate Customer key customer_id { name = "name"; }
    populate Order from rest.orders key order_id { total = "total"; }
  }
}
`

class RecordingCatalog extends DataSourceAdapterCatalog
{
    public readonly Invalidated: string[] = []
    public DisposeCalls = 0

    public override async Invalidate(spec: ConnectorSpec): Promise<void>
    {
        this.Invalidated.push(spec.Name)
        await super.Invalidate(spec)
    }

    public override async Dispose(): Promise<void>
    {
        this.DisposeCalls++
        await super.Dispose()
    }
}

class Harness
{
    public static TwoConnectorRuntime(catalog: DataSourceAdapterCatalog): ConnectorRuntime
    {
        const { model } = check([{ uri: 'shop.todl', text: META_TWO }])
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, catalog)
        return new ConnectorRuntime(SolutionConnectorPlanner.Plan(model), services)
    }

    public static CatalogRuntime(catalog: DataSourceAdapterCatalog): ConnectorRuntime
    {
        const { model } = check([{ uri: 'shop.todl', text: META }])
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, catalog)
        return new ConnectorRuntime(SolutionConnectorPlanner.Plan(model), services)
    }

    public static Rows(): ReadonlyMap<string, readonly ExternalRecord[]>
    {
        return new Map<string, readonly ExternalRecord[]>([['Customer', [{ customer_id: 'C1', name: 'Acme' }]]])
    }

    public static Factory(): IDataSourceAdapterFactory
    {
        const rows = Harness.Rows()
        const adapter: IDataSourceAdapter =
        {
            Query(_request: QueryRequest): Promise<readonly ExternalRecord[]> { return Promise.resolve(rows.get('Customer') ?? []) },
            Apply(batch: WriteBatch): Promise<WriteResult> { return Promise.resolve({ Applied: batch.Operations.length, Failures: [] }) },
            Dispose(): Promise<void> { return Promise.resolve() },
        }
        return { Kind: DataSourceKind.Sql, Open(_c: ResolvedConnection): Promise<IDataSourceAdapter> { return Promise.resolve(adapter) } }
    }

    public static Runtime(): ConnectorRuntime
    {
        const { model } = check([{ uri: 'shop.todl', text: META }])
        const models = SolutionConnectorPlanner.Plan(model)
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, new DataSourceAdapterCatalog().Register(Harness.Factory()))
        return new ConnectorRuntime(models, services)
    }
}

test('List maps models/bindings to wire DTOs with no Config/secret fields', async () =>
{
    const service = new ConnectorService(() => Promise.resolve(Harness.Runtime()))
    const models = await service.List()
    assert.equal(models.length, 1)
    assert.equal(models[0]!.connectors[0]!.name, 'pg')
    assert.equal(models[0]!.connectors[0]!.kind, 'sql')
    assert.equal(models[0]!.bindings[0]!.concept, 'shop.Customer')
    assert.equal(JSON.stringify(models).includes('Config'), false)
})

test('Read projects entity id/concept + scalar fields via Snapshot', async () =>
{
    const service = new ConnectorService(() => Promise.resolve(Harness.Runtime()))
    const models = await service.List()
    const entities = (await service.Read(models[0]!.modelId, 'shop.Customer', {}, new PagingLimits())).items
    assert.ok(entities.length >= 1)
    assert.equal(entities[0]!.concept, 'shop.Customer')
    assert.equal(entities[0]!.fields.name, 'Acme')
})

test('Test returns ok for a resolvable connector', async () =>
{
    const service = new ConnectorService(() => Promise.resolve(Harness.Runtime()))
    const models = await service.List()
    const probe = await service.Test(models[0]!.modelId, 'pg')
    assert.equal(probe.ok, true)
})

test('Invalidate forces the factory to run again on the next call', async () =>
{
    let built = 0
    const service = new ConnectorService(() => { built++; return Promise.resolve(Harness.Runtime()) })
    await service.List()
    await service.List()
    assert.equal(built, 1) // cached
    await service.Invalidate()
    await service.List()
    assert.equal(built, 2) // rebuilt after invalidate
})

test("refresh evicts exactly this connection's connector specs, never Dispose", async () =>
{
    const catalog = new RecordingCatalog().Register(Harness.Factory()) as RecordingCatalog
    let built = 0
    const service = new ConnectorService(() => { built++; return Promise.resolve(Harness.TwoConnectorRuntime(catalog)) })
    await service.List()
    assert.equal(built, 1)
    await service.Invalidate()
    assert.deepEqual([...catalog.Invalidated].sort(), ['pg', 'rest'])
    assert.equal(catalog.DisposeCalls, 0)
    await service.List()
    assert.equal(built, 2)
})

test('refresh with no runtime loaded evicts nothing', async () =>
{
    const catalog = new RecordingCatalog().Register(Harness.Factory()) as RecordingCatalog
    const service = new ConnectorService(() => Promise.resolve(Harness.TwoConnectorRuntime(catalog)))
    await service.Invalidate()
    assert.equal(catalog.Invalidated.length, 0)
    assert.equal(catalog.DisposeCalls, 0)
})

test('refresh after a rejected build resolves and evicts nothing', async () =>
{
    const catalog = new RecordingCatalog().Register(Harness.Factory()) as RecordingCatalog
    const service = new ConnectorService(() => Promise.reject(new Error('build failed')))
    await assert.rejects(service.List())
    await service.Invalidate()
    assert.equal(catalog.Invalidated.length, 0)
    assert.equal(catalog.DisposeCalls, 0)
})

test('refresh during an in-flight build evicts after the build resolves', async () =>
{
    const catalog = new RecordingCatalog().Register(Harness.Factory()) as RecordingCatalog
    let release: (runtime: ConnectorRuntime) => void = () => undefined
    const gate = new Promise<ConnectorRuntime>((resolve) => { release = resolve })
    const service = new ConnectorService(() => gate)
    const listing = service.List()
    const invalidating = service.Invalidate()
    await Promise.resolve()
    assert.equal(catalog.Invalidated.length, 0)
    release(Harness.TwoConnectorRuntime(catalog))
    await invalidating
    await listing
    assert.deepEqual([...catalog.Invalidated].sort(), ['pg', 'rest'])
    assert.equal(catalog.DisposeCalls, 0)
})

test('RefreshModel with no runtime loaded is a no-op and evicts nothing', async () =>
{
    const catalog = new RecordingCatalog().Register(Harness.Factory()) as RecordingCatalog
    let built = 0
    const service = new ConnectorService(() => { built++; return Promise.resolve(Harness.TwoConnectorRuntime(catalog)) })
    const outcome = await service.RefreshModel('m')
    assert.deepEqual(outcome, { diagnostics: [] })
    assert.equal(built, 0)
    assert.equal(catalog.Invalidated.length, 0)
    assert.equal(catalog.DisposeCalls, 0)
})

test('RefreshModel on a loaded runtime refreshes and maps dropped-op diagnostics to DiagnosticDto', async () =>
{
    const rows: ExternalRecord[] = [{ customer_id: 'C1', name: 'Acme' }]
    const adapter: IDataSourceAdapter =
    {
        Query(_request: QueryRequest): Promise<readonly ExternalRecord[]> { return Promise.resolve([...rows]) },
        Apply(_batch: WriteBatch): Promise<WriteResult> { return Promise.reject(new Error('apply failed')) },
        Dispose(): Promise<void> { return Promise.resolve() },
    }
    const factory: IDataSourceAdapterFactory = { Kind: DataSourceKind.Sql, Open(_c: ResolvedConnection): Promise<IDataSourceAdapter> { return Promise.resolve(adapter) } }
    const { model } = check([{ uri: 'shop.todl', text: META }])
    const services = new ServiceProvider()
    services.registerInstance(DataSourceAdapterCatalog.ServiceKey, new DataSourceAdapterCatalog().Register(factory))
    const runtime = new ConnectorRuntime(SolutionConnectorPlanner.Plan(model), services)
    const service = new ConnectorService(() => Promise.resolve(runtime))
    const modelId = (await service.List())[0]!.modelId
    const entity = (await service.Read(modelId, 'shop.Customer', {}, new PagingLimits())).items[0]!
    await runtime.WriteBack(modelId, [entity.id], [])
    rows.splice(0, rows.length, { customer_id: 'C9', name: 'Other' })
    const outcome = await service.RefreshModel(modelId)
    assert.ok(outcome.diagnostics.length > 0)
    assert.equal(typeof outcome.diagnostics[0]!.code, 'string')
    assert.equal(typeof outcome.diagnostics[0]!.message, 'string')
    assert.deepEqual(Object.keys(outcome.diagnostics[0]!).sort(), ['code', 'message'])
})

test('RefreshModel does not evict adapters, unlike Invalidate', async () =>
{
    const catalog = new RecordingCatalog().Register(Harness.Factory()) as RecordingCatalog
    const service = new ConnectorService(() => Promise.resolve(Harness.CatalogRuntime(catalog)))
    const modelId = (await service.List())[0]!.modelId
    await service.RefreshModel(modelId)
    assert.equal(catalog.Invalidated.length, 0)
    assert.equal(catalog.DisposeCalls, 0)
    await service.Invalidate()
    assert.deepEqual([...catalog.Invalidated].sort(), ['pg'])
})

test('WritePaged applies a keyed edit through the real plan without preparing the model', async () =>
{
    const service = new ConnectorService(() => Promise.resolve(Harness.Runtime()))
    const models = await service.List()
    const binding = models[0]!.bindings[0]!
    const res = await service.WritePaged({ modelId: models[0]!.modelId, operations: [{ op: ConnectorWriteOp.Upsert, concept: binding.concept, connector: binding.connector, source: binding.source, key: 'C1', fields: { name: 'Edited' } }] })
    assert.equal(res.results.length, 1)
    assert.equal(res.results[0]!.key, 'C1')
    assert.equal(res.results[0]!.status, AppWriteStatus.Applied)
    assert.equal(JSON.stringify(res).includes('Config'), false)
})
