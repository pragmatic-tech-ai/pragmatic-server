import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { check, DataSourceAdapterCatalog, DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection, QueryRequest, WriteBatch, WriteResult, ExternalRecord } from '@pragmatic-tech-ai/todl'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, ResourceAuthorizationPolicy, Grant, Role, ResourceRef, ResourceKind, OwnershipSourceKind, PrivilegeAction, AccessLevel } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig, ITenantConfigStore } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteStatus, ConnectorWriteOp } from '@pragmatic-tech-ai/pragmatic-protocol'
import { SolutionConnectorPlanner } from '../../connectors/solution-connector-planner.js'
import { ConnectorRuntime } from '../../connectors/connector-runtime.js'
import { ConnectorService } from '../connector-service.js'
import { TenantReadAuthorization } from '../cypher/read-filter-source.js'
import { PragmaticServer } from '../../pragmatic-server.js'

class WriteFixture
{
    public static readonly Concept = 'shop.Customer'
    private static readonly Meta = `
namespace shop {
  concept Customer { owner : string; name : string; }
  datasource pg { kind = sql; }
  model shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { owner = "owner"; name = "name"; }
  }
}
`
    public readonly Queries: QueryRequest[] = []
    public readonly Applied: WriteBatch[] = []
    public Opens = 0

    private static Rows(): ExternalRecord[]
    {
        return [
            { customer_id: 'C1', owner: 'p1', name: 'a' },
            { customer_id: 'C2', owner: 'p2', name: 'b' },
        ]
    }

    public Runtime(): ConnectorRuntime
    {
        const adapter: IDataSourceAdapter =
        {
            Query: (request: QueryRequest) =>
            {
                this.Queries.push(request)
                const clause = request.Where?.All?.[0]
                return Promise.resolve(WriteFixture.Rows().filter(r => clause === undefined || r[clause.Field] === clause.Value))
            },
            Apply: (batch: WriteBatch): Promise<WriteResult> =>
            {
                this.Applied.push(batch)
                return Promise.resolve({ Applied: batch.Operations.length, Failures: [] })
            },
            Dispose(): Promise<void> { return Promise.resolve() },
        }
        const factory: IDataSourceAdapterFactory = { Kind: DataSourceKind.Sql, Open: (_c: ResolvedConnection): Promise<IDataSourceAdapter> => { this.Opens++; return Promise.resolve(adapter) } }
        const { model } = check([{ uri: 'shop.todl', text: WriteFixture.Meta }])
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, new DataSourceAdapterCatalog().Register(factory))
        return new ConnectorRuntime(SolutionConnectorPlanner.Plan(model), services)
    }

    public static Model(): ISecurityModelConfig
    {
        const concept = WriteFixture.Concept
        return {
            businessUnits: [{ id: 'root', name: 'Root' }],
            teams: [],
            membership: { claimsMapping: [], overrides: [] },
            ownershipRules: [{ concept, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: 'root' }, owner: { kind: OwnershipSourceKind.FromField, value: 'owner' } }],
            roles: [{ id: 'user-writer', name: 'User Writer', privileges: [
                { action: PrivilegeAction.Update, concept, level: AccessLevel.User },
                { action: PrivilegeAction.Delete, concept, level: AccessLevel.User },
            ] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: 'p1', roles: ['user-writer'] }], teamRoles: [] },
        }
    }

    public Service(): ConnectorService
    {
        const store = { Get: async () => ({ SecurityModel: WriteFixture.Model() }) } as unknown as ITenantConfigStore
        const auth = new TenantReadAuthorization(store)
        return new ConnectorService(() => Promise.resolve(this.Runtime()), async (ctx, target) => ({ authorizer: await auth.WriteAuthorizerFor(ctx), gate: await auth.WriteInstanceGateFor(ctx, { Keep: () => true }, target) }))
    }

    public static Ctx(id: string): AccessContext
    {
        return new AccessContext(new Principal(id, 't1', PrincipalKind.User, new Map(), []), new Tenant('t1', TenantKind.SelfHosted, 'Tenant One'), [new Grant(id, Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))], new ResourceAuthorizationPolicy())
    }

    public static async Write(service: ConnectorService, op: ConnectorWriteOp, key: string, ctx: AccessContext)
    {
        const model = (await service.List())[0]!
        const binding = model.bindings[0]!
        return service.WritePaged({ modelId: model.modelId, operations: [{ op, concept: binding.concept, connector: binding.connector, source: binding.source, key, fields: { name: 'Edited' } }] }, ctx)
    }
}

test('an upsert on a row the principal may not write is Denied, nothing sent', async () =>
{
    const fx = new WriteFixture()
    const res = await WriteFixture.Write(fx.Service(), ConnectorWriteOp.Upsert, 'C2', WriteFixture.Ctx('p1'))
    assert.equal(res.results[0]!.status, AppWriteStatus.Denied)
    assert.equal(fx.Applied.length, 0)
})

test('a delete on a non-writable row is Denied, nothing sent', async () =>
{
    const fx = new WriteFixture()
    const res = await WriteFixture.Write(fx.Service(), ConnectorWriteOp.Delete, 'C2', WriteFixture.Ctx('p1'))
    assert.equal(res.results[0]!.status, AppWriteStatus.Denied)
    assert.equal(fx.Applied.length, 0)
})

test('a writable row applies', async () =>
{
    const fx = new WriteFixture()
    const res = await WriteFixture.Write(fx.Service(), ConnectorWriteOp.Upsert, 'C1', WriteFixture.Ctx('p1'))
    assert.equal(res.results[0]!.status, AppWriteStatus.Applied)
    assert.equal(fx.Applied.length, 1)
})

test('a principal with no write role is Denied on its own row, nothing sent', async () =>
{
    const fx = new WriteFixture()
    const res = await WriteFixture.Write(fx.Service(), ConnectorWriteOp.Upsert, 'C2', WriteFixture.Ctx('p2'))
    assert.equal(res.results[0]!.status, AppWriteStatus.Denied)
    assert.equal(fx.Applied.length, 0)
})

test('authorization reads the row via the ONE keyed Fetch, not a whole-concept prefetch', async () =>
{
    const fx = new WriteFixture()
    await WriteFixture.Write(fx.Service(), ConnectorWriteOp.Upsert, 'C1', WriteFixture.Ctx('p1'))
    const keyed = fx.Queries.filter(q => q.Where?.All?.[0]?.Field === 'customer_id' && q.Where.All[0].Value === 'C1')
    assert.ok(keyed.length >= 1)
    assert.equal(fx.Queries.filter(q => q.Where === undefined).length, 0)
    assert.equal(fx.Opens, 1)
})

test('no identity => AllowAll (unchanged from item #1)', async () =>
{
    const server = new PragmaticServer({} as never)
    const fx = new WriteFixture()
    const service = new ConnectorService(() => Promise.resolve(fx.Runtime()), (ctx, target) => server.ConnectorWriteAuthorizationFor(ctx, target))
    const res = await WriteFixture.Write(service, ConnectorWriteOp.Upsert, 'C2', WriteFixture.Ctx('p1'))
    assert.equal(res.results[0]!.status, AppWriteStatus.Applied)
    assert.equal(fx.Queries.length, 0)
})
