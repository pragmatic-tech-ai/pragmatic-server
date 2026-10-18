import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { check, DataSourceAdapterCatalog, DataSourceKind, WriteConcurrency, WriteAtomicity } from '@pragmatic-tech-ai/todl'
import type { ConnectorSpec, IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection, QueryRequest, PageQuery, PageSlice, WriteBatch, WriteResult, ExternalRecord } from '@pragmatic-tech-ai/todl'
import { SolutionConnectorPlanner } from '../../connectors/solution-connector-planner.js'
import { ConnectorRuntime } from '../../connectors/connector-runtime.js'
import { PagingLimits } from '../../config/paging-limits.js'
import { AppWriteStatus, ConnectorWriteOp } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ConnectorService } from '../connector-service.js'
import { ConnectorReadAuthorizations } from '../connector-read-authorization.js'
import type { IConnectorReadAuthorization } from '../connector-read-authorization.js'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, ResourceAuthorizationPolicy, Grant, Role, ResourceRef, ResourceKind, OwnershipSourceKind, PrivilegeAction, AccessLevel } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig, ITenantConfigStore } from '@pragmatic-tech-ai/todl-identity'
import { TenantReadAuthorization } from '../cypher/read-filter-source.js'
import type { IInstanceFilter, IInstanceView } from '@pragmatic-tech-ai/todl'
import { AllowAllFieldReadMask } from '../cypher/field-masked-graph-query.js'
import type { IFieldReadMask } from '../cypher/field-masked-graph-query.js'

class Ctx
{
    public static Any(): AccessContext
    {
        return new AccessContext(new Principal('p1', 't1', PrincipalKind.User, new Map(), []), new Tenant('t1', TenantKind.SelfHosted, 'Tenant One'), [], new ResourceAuthorizationPolicy())
    }
}

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
    const entities = (await service.Read(models[0]!.modelId, 'shop.Customer', {}, new PagingLimits(), Ctx.Any())).items
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
    const entity = (await service.Read(modelId, 'shop.Customer', {}, new PagingLimits(), Ctx.Any())).items[0]!
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

test('WritePaged validates field values against the schema type: wrong-typed and non-scalar are invalid, a well-typed op still applies', async () =>
{
    const rows = Harness.Rows()
    const batches: WriteBatch[] = []
    const adapter: IDataSourceAdapter =
    {
        Query(_request: QueryRequest): Promise<readonly ExternalRecord[]> { return Promise.resolve(rows.get('Customer') ?? []) },
        Apply(batch: WriteBatch): Promise<WriteResult> { batches.push(batch); return Promise.resolve({ Applied: batch.Operations.length, Failures: [] }) },
        Dispose(): Promise<void> { return Promise.resolve() },
    }
    const factory: IDataSourceAdapterFactory = { Kind: DataSourceKind.Sql, Open(_c: ResolvedConnection): Promise<IDataSourceAdapter> { return Promise.resolve(adapter) } }
    const { model } = check([{ uri: 'shop.todl', text: META }])
    const services = new ServiceProvider()
    services.registerInstance(DataSourceAdapterCatalog.ServiceKey, new DataSourceAdapterCatalog().Register(factory))
    const service = new ConnectorService(() => Promise.resolve(new ConnectorRuntime(SolutionConnectorPlanner.Plan(model), services)))
    const models = await service.List()
    const b = models[0]!.bindings[0]!
    const op = (key: string, name: unknown): never => ({ op: ConnectorWriteOp.Upsert, concept: b.concept, connector: b.connector, source: b.source, key, fields: { name } }) as never
    const res = await service.WritePaged({ modelId: models[0]!.modelId, operations: [op('C1', 42), op('C2', { x: 1 }), op('C3', 'fine')] })
    assert.deepEqual(res.results.map(r => r.status), [AppWriteStatus.Invalid, AppWriteStatus.Invalid, AppWriteStatus.Applied])
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0]!.Operations.map(o => o.Key), ['C3'])
})

test('Read with AllowAll readAuthorizationFor returns the literal unfiltered rows and page shape', async () =>
{
    const service = new ConnectorService(() => Promise.resolve(Harness.Runtime()), undefined, async () => ConnectorReadAuthorizations.AllowAll())
    const modelId = (await service.List())[0]!.modelId
    const result = await service.Read(modelId, 'shop.Customer', {}, new PagingLimits(), Ctx.Any())
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]!.fields.name, 'Acme')
    assert.equal(result.items[0]!.concept, 'shop.Customer')
    assert.equal('nextCursor' in result, false)
})

class KeysetFixture
{
    public static Runtime(): ConnectorRuntime
    {
    const rows: ExternalRecord[] = [0, 1, 2].map(i => ({ id: `C${i}`, name: `n${i}` }))
    const factory: IDataSourceAdapterFactory =
    {
        Kind: DataSourceKind.Sql,
        Open(_c: ResolvedConnection): Promise<IDataSourceAdapter>
        {
            const adapter: IDataSourceAdapter & { CanPage: boolean } =
            {
                CanPage: true,
                Query(): Promise<readonly ExternalRecord[]> { return Promise.resolve(rows) },
                QueryPage(_r: QueryRequest, page: PageQuery): Promise<PageSlice>
                {
                    const rest = page.After === undefined ? rows : rows.filter(r => String(r['id']) > String(page.After))
                    const records = rest.slice(0, page.Limit)
                    return Promise.resolve(records.length === page.Limit ? { Records: records, NextAfter: records[records.length - 1]!['id']! } : { Records: records })
                },
                Apply(): Promise<WriteResult> { return Promise.resolve({ Applied: 0, Failures: [] }) },
                Dispose(): Promise<void> { return Promise.resolve() },
            }
            return Promise.resolve(adapter)
        },
    }
    const catalog = new DataSourceAdapterCatalog()
    catalog.Register(factory)
    const services = new ServiceProvider()
    services.registerInstance(DataSourceAdapterCatalog.ServiceKey, catalog)
    const plan = { Model: 'shop', Version: '1', Connectors: [{ Name: 'pg', Kind: DataSourceKind.Sql, Config: {} }], Bindings: [{ Concept: 'shop.Customer', Connector: 'pg', Source: 'Customer', IdKey: 'id', FieldMap: { name: 'name' }, Writable: false, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential }] }
    const runtime = new ConnectorRuntime([{ ModelId: 'shop', Plan: plan, Base: {} as never }], services)
        return runtime
    }
}

test('ReadPage with AllowAll readAuthorizationFor returns keyset pages with a nextCursor, then the tail without one', async () =>
{
    const runtime = KeysetFixture.Runtime()
    const service = new ConnectorService(() => Promise.resolve(runtime), undefined, async () => ConnectorReadAuthorizations.AllowAll())
    const first = await service.ReadPage('shop', 'shop.Customer', { pageSize: 2 }, new PagingLimits(100, 1000), Ctx.Any())
    assert.equal(first.items.length, 2)
    assert.equal(first.items[0]!.fields.name, 'n0')
    assert.equal(typeof first.nextCursor, 'string')
    const second = await service.ReadPage('shop', 'shop.Customer', { pageSize: 2, cursor: first.nextCursor }, new PagingLimits(100, 1000), Ctx.Any())
    assert.equal(second.items.length, 1)
    assert.equal(second.items[0]!.fields.name, 'n2')
    assert.equal('nextCursor' in second, false)
})

const META_OWNED = `
namespace shop {
  concept Customer { owner : string; name : string; secret : string; }
  datasource pg { kind = sql; }
  model shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { owner = "owner"; name = "name"; secret = "secret"; }
  }
}
`

/** Stand-in row visibility (NOT the real access-depth evaluator; see the real-evaluator tests below). */
enum StubVisibility
{
    All,
    OwnRows,
    NoRows,
}

class StubOwnerFilter implements IInstanceFilter
{
    public constructor(private readonly level: StubVisibility, private readonly principalId: string) {}

    public Keep(view: IInstanceView): boolean
    {
        if (this.level === StubVisibility.All)
        {
            return true
        }
        return this.level === StubVisibility.OwnRows && view.Field('owner') === this.principalId
    }
}

class SecretMask implements IFieldReadMask
{
    public CanRead(_concept: string, field: string): boolean
    {
        return field !== 'secret'
    }
}

class OwnedFixture
{
    public static Key(id: string): string
    {
        return id.slice(id.lastIndexOf('#') + 1)
    }

    public static Rows(): ExternalRecord[]
    {
        return [
            { customer_id: 'C1', owner: 'p1', name: 'a', secret: 's1' },
            { customer_id: 'C2', owner: 'p2', name: 'b', secret: 's2' },
            { customer_id: 'C3', owner: 'p1', name: 'c', secret: 's3' },
            { customer_id: 'C4', owner: 'p2', name: 'd', secret: 's4' },
            { customer_id: 'C5', owner: 'p1', name: 'e', secret: 's5' },
        ]
    }

    public static Runtime(): ConnectorRuntime
    {
        const rows = OwnedFixture.Rows()
        const adapter: IDataSourceAdapter =
        {
            Query(_request: QueryRequest): Promise<readonly ExternalRecord[]> { return Promise.resolve(rows) },
            Apply(batch: WriteBatch): Promise<WriteResult> { return Promise.resolve({ Applied: batch.Operations.length, Failures: [] }) },
            Dispose(): Promise<void> { return Promise.resolve() },
        }
        const factory: IDataSourceAdapterFactory = { Kind: DataSourceKind.Sql, Open(_c: ResolvedConnection): Promise<IDataSourceAdapter> { return Promise.resolve(adapter) } }
        const { model } = check([{ uri: 'shop.todl', text: META_OWNED }])
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, new DataSourceAdapterCatalog().Register(factory))
        return new ConnectorRuntime(SolutionConnectorPlanner.Plan(model), services)
    }

    public static Service(level: StubVisibility, mask: IFieldReadMask = AllowAllFieldReadMask.Instance): ConnectorService
    {
        return new ConnectorService(() => Promise.resolve(OwnedFixture.Runtime()), undefined, async (ctx) => ({ Filter: new StubOwnerFilter(level, ctx.Principal.Id), FieldMask: mask, IdentityBacked: true }))
    }

    public static Ctx(id: string, role: Role = Role.Owner): AccessContext
    {
        return new AccessContext(new Principal(id, 't1', PrincipalKind.User, new Map(), []), new Tenant('t1', TenantKind.SelfHosted, 'Tenant One'), [new Grant(id, role, new ResourceRef(ResourceKind.Tenant, 't1', []))], new ResourceAuthorizationPolicy())
    }

    public static async ModelId(service: ConnectorService): Promise<string>
    {
        return (await service.List())[0]!.modelId
    }
}

test('User-level read returns only the principal\'s own rows; Organization-level returns all; None returns none', async () =>
{
    const read = async (level: StubVisibility): Promise<string[]> =>
    {
        const service = OwnedFixture.Service(level)
        const result = await service.Read(await OwnedFixture.ModelId(service), 'shop.Customer', {}, new PagingLimits(), OwnedFixture.Ctx('p1'))
        return result.items.map(i => OwnedFixture.Key(i.id))
    }
    assert.deepEqual(await read(StubVisibility.OwnRows), ['C1', 'C3', 'C5'])
    assert.deepEqual(await read(StubVisibility.All), ['C1', 'C2', 'C3', 'C4', 'C5'])
    assert.deepEqual(await read(StubVisibility.NoRows), [])
})

test('offset paging counts only VISIBLE rows', async () =>
{
    const service = OwnedFixture.Service(StubVisibility.OwnRows)
    const modelId = await OwnedFixture.ModelId(service)
    const ctx = OwnedFixture.Ctx('p1')
    const first = await service.Read(modelId, 'shop.Customer', { pageSize: 2 }, new PagingLimits(), ctx)
    assert.deepEqual(first.items.map(i => OwnedFixture.Key(i.id)), ['C1', 'C3'])
    assert.ok(first.nextCursor !== undefined)
    const second = await service.Read(modelId, 'shop.Customer', { pageSize: 2, cursor: first.nextCursor }, new PagingLimits(), ctx)
    assert.deepEqual(second.items.map(i => OwnedFixture.Key(i.id)), ['C5'])
    assert.equal(second.nextCursor, undefined)
})

test('a secured field is masked in the returned EntityDto.fields', async () =>
{
    const service = OwnedFixture.Service(StubVisibility.All, new SecretMask())
    const result = await service.Read(await OwnedFixture.ModelId(service), 'shop.Customer', {}, new PagingLimits(), OwnedFixture.Ctx('p1'))
    assert.equal(result.items.length, 5)
    for (const item of result.items)
    {
        assert.equal('secret' in item.fields, false)
        assert.ok('name' in item.fields)
    }
})

test('the read fingerprint differs per principal', async () =>
{
    const service = OwnedFixture.Service(StubVisibility.All)
    const modelId = await OwnedFixture.ModelId(service)
    const first = await service.Read(modelId, 'shop.Customer', { pageSize: 2 }, new PagingLimits(), OwnedFixture.Ctx('p1'))
    const cursor = first.nextCursor!
    const same = await service.Read(modelId, 'shop.Customer', { pageSize: 2, cursor }, new PagingLimits(), OwnedFixture.Ctx('p1'))
    assert.deepEqual(same.items.map(i => OwnedFixture.Key(i.id)), ['C3', 'C4'])
    await assert.rejects(() => service.Read(modelId, 'shop.Customer', { pageSize: 2, cursor }, new PagingLimits(), OwnedFixture.Ctx('p2')))
})

test('no-identity (AllowAll) read is unchanged', async () =>
{
    const service = new ConnectorService(() => Promise.resolve(OwnedFixture.Runtime()))
    const result = await service.Read(await OwnedFixture.ModelId(service), 'shop.Customer', {}, new PagingLimits(), OwnedFixture.Ctx('p1'))
    assert.deepEqual(result.items.map(i => OwnedFixture.Key(i.id)), ['C1', 'C2', 'C3', 'C4', 'C5'])
    assert.equal(result.items[0]!.fields.secret, 's1')
    assert.equal(result.items[0]!.fields.owner, 'p1')
})

test('without readAuthorizationFor two principals mint the SAME cursor; with it they mint DIFFERENT cursors', async () =>
{
    const mint = async (service: ConnectorService, principal: string): Promise<string | undefined> =>
    {
        const first = await service.Read(await OwnedFixture.ModelId(service), 'shop.Customer', { pageSize: 2 }, new PagingLimits(), OwnedFixture.Ctx(principal))
        return first.nextCursor
    }
    const open = new ConnectorService(() => Promise.resolve(OwnedFixture.Runtime()))
    assert.equal(await mint(open, 'p1'), await mint(open, 'p2'))
    const secured = OwnedFixture.Service(StubVisibility.All)
    assert.notEqual(await mint(secured, 'p1'), await mint(secured, 'p2'))
})

test('paging skips leading hidden rows and omits nextCursor when visible count equals the page size', async () =>
{
    // p3 owns nothing in the fixture; give it exactly the LAST row via a custom filter so raw-offset paging would miss it.
    const lastOnly: IInstanceFilter = { Keep: (view: IInstanceView) => view.Field('name') === 'e' }
    const service = new ConnectorService(() => Promise.resolve(OwnedFixture.Runtime()), undefined, async () => ({ Filter: lastOnly, FieldMask: AllowAllFieldReadMask.Instance, IdentityBacked: true }))
    const modelId = await OwnedFixture.ModelId(service)
    const one = await service.Read(modelId, 'shop.Customer', { pageSize: 1 }, new PagingLimits(), OwnedFixture.Ctx('p3'))
    assert.deepEqual(one.items.map(i => OwnedFixture.Key(i.id)), ['C5'])
    assert.equal(one.nextCursor, undefined)
    const own = OwnedFixture.Service(StubVisibility.OwnRows)
    const exact = await own.Read(await OwnedFixture.ModelId(own), 'shop.Customer', { pageSize: 3 }, new PagingLimits(), OwnedFixture.Ctx('p1'))
    assert.equal(exact.items.length, 3)
    assert.equal(exact.nextCursor, undefined)
})

class RealEvaluatorFixture
{
    /** The QUALIFIED concept name: the form ReflectedEntity.concept (and so EntityInstanceView.Concept and the FieldMask.CanRead arg) carries. */
    public static readonly Concept = 'shop.Customer'

    public static Model(concept: string): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: 'root', name: 'Root' }],
            teams: [],
            membership: { claimsMapping: [], overrides: [] },
            ownershipRules: [{ concept, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: 'root' }, owner: { kind: OwnershipSourceKind.FromField, value: 'owner' } }],
            roles: [{ id: 'user-reader', name: 'User Reader', privileges: [{ action: PrivilegeAction.Read, concept, level: AccessLevel.User }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: 'p1', roles: ['user-reader'] }], teamRoles: [] },
            fieldSecurity: { securedFields: [{ concept, field: 'secret' }], profiles: [], profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] } },
        }
    }

    public static Service(concept: string): ConnectorService
    {
        const store = { Get: async () => ({ SecurityModel: RealEvaluatorFixture.Model(concept) }) } as unknown as ITenantConfigStore
        const auth = new TenantReadAuthorization(store)
        return new ConnectorService(() => Promise.resolve(OwnedFixture.Runtime()), undefined, (ctx) => ConnectorReadAuthorizations.From(auth, ctx))
    }
}

test('REAL evaluator: user-depth principal sees only its own rows and the secured field is absent', async () =>
{
    const service = RealEvaluatorFixture.Service(RealEvaluatorFixture.Concept)
    const result = await service.Read(await OwnedFixture.ModelId(service), 'shop.Customer', {}, new PagingLimits(), OwnedFixture.Ctx('p1'))
    assert.deepEqual(result.items.map(i => OwnedFixture.Key(i.id)), ['C1', 'C3', 'C5'])
    for (const item of result.items)
    {
        assert.equal(item.concept, RealEvaluatorFixture.Concept)
        assert.equal('secret' in item.fields, false)
        assert.equal(item.fields.owner, 'p1')
    }
})

test('REAL evaluator: a bare-concept security model does not match the qualified concept (form is pinned, fails closed)', async () =>
{
    const service = RealEvaluatorFixture.Service('Customer')
    const result = await service.Read(await OwnedFixture.ModelId(service), 'shop.Customer', {}, new PagingLimits(), OwnedFixture.Ctx('p1'))
    assert.deepEqual(result.items, [])
})

test('production no-identity shape: a wired AllowAll (IdentityBacked=false) factory mints the SAME cursor for different principals on Read and ReadPage', async () =>
{
    const allowAll = async (): Promise<IConnectorReadAuthorization> => ConnectorReadAuthorizations.AllowAll()
    assert.equal((await allowAll()).IdentityBacked, false)
    const read = new ConnectorService(() => Promise.resolve(OwnedFixture.Runtime()), undefined, allowAll)
    const modelId = await OwnedFixture.ModelId(read)
    const r1 = await read.Read(modelId, 'shop.Customer', { pageSize: 2 }, new PagingLimits(), OwnedFixture.Ctx('p1'))
    const r2 = await read.Read(modelId, 'shop.Customer', { pageSize: 2 }, new PagingLimits(), OwnedFixture.Ctx('p2'))
    assert.equal(typeof r1.nextCursor, 'string')
    assert.equal(r1.nextCursor, r2.nextCursor)
    const paged = new ConnectorService(() => Promise.resolve(KeysetFixture.Runtime()), undefined, allowAll)
    const limits = new PagingLimits(100, 1000)
    const p1 = await paged.ReadPage('shop', 'shop.Customer', { pageSize: 2 }, limits, OwnedFixture.Ctx('p1'))
    const p2 = await paged.ReadPage('shop', 'shop.Customer', { pageSize: 2 }, limits, OwnedFixture.Ctx('p2'))
    assert.equal(typeof p1.nextCursor, 'string')
    assert.equal(p1.nextCursor, p2.nextCursor)
})

test('identity-backed ReadPage mints DIFFERENT cursors per principal', async () =>
{
    const backed = async (): Promise<IConnectorReadAuthorization> => ({ ...ConnectorReadAuthorizations.AllowAll(), IdentityBacked: true })
    const paged = new ConnectorService(() => Promise.resolve(KeysetFixture.Runtime()), undefined, backed)
    const limits = new PagingLimits(100, 1000)
    const p1 = await paged.ReadPage('shop', 'shop.Customer', { pageSize: 2 }, limits, OwnedFixture.Ctx('p1'))
    const p2 = await paged.ReadPage('shop', 'shop.Customer', { pageSize: 2 }, limits, OwnedFixture.Ctx('p2'))
    assert.notEqual(p1.nextCursor, p2.nextCursor)
})
