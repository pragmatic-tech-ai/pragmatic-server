import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { check, DataSourceAdapterCatalog, DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection, QueryRequest, WriteBatch, WriteResult, ExternalRecord } from '@pragmatic-tech-ai/todl'
import { SolutionConnectorPlanner } from '../../connectors/solution-connector-planner.js'
import { ConnectorRuntime } from '../../connectors/connector-runtime.js'
import { PagingLimits } from '../../config/paging-limits.js'
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

class Harness
{
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
    service.Invalidate()
    await service.List()
    assert.equal(built, 2) // rebuilt after invalidate
})
