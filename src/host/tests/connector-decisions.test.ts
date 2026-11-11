import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { check, DataSourceAdapterCatalog, DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection, QueryRequest, WriteBatch, WriteResult, ExternalRecord, IInstanceFilter, IInstanceView } from '@pragmatic-tech-ai/todl'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { SolutionConnectorPlanner } from '../../connectors/solution-connector-planner.js'
import { ConnectorRuntime } from '../../connectors/connector-runtime.js'
import { ConnectorService } from '../connector-service.js'
import type { IConnectorReadAuthorization } from '../connector-read-authorization.js'
import { AllowAllFieldReadMask } from '../cypher/field-read-mask.js'
import type { IFieldReadMask } from '../cypher/field-read-mask.js'

/** Hand-authored customers and CRM rows are the same people (matched on email); `merge` picks the CRM name. */
class DecisionsFixture
{
    public static readonly Model = 'shop.shop'
    public static readonly Meta = `
namespace shop {
  concept Customer { email : string; name : string?; tier : string?; }
  identity Customer key email;
  merge Customer { prefer source "crm.people" for name; }
  datasource crm { kind = sql; }
  model shop : shop {
    annotate entrypoint { }
    connect crm;
    populate Customer from crm.people key person_id { email = "email"; name = "name"; tier = "tier"; }
    Customer c1 { email = "a@x"; name = "Ada (authored)"; }
    Customer c2 { email = "b@x"; name = "Bo (authored)"; }
  }
}
`

    public static Rows(): ReadonlyMap<string, readonly ExternalRecord[]>
    {
        return new Map<string, readonly ExternalRecord[]>([
            ['people', [{ person_id: 'P1', email: 'a@x', name: 'Ada (crm)', tier: 'gold' }, { person_id: 'P2', email: 'b@x', name: 'Bo (crm)', tier: 'silver' }]],
        ])
    }

    public static Factory(kind: DataSourceKind): IDataSourceAdapterFactory
    {
        const rows = DecisionsFixture.Rows()
        const adapter: IDataSourceAdapter =
        {
            Query(request: QueryRequest): Promise<readonly ExternalRecord[]> { return Promise.resolve(rows.get(request.Source) ?? []) },
            Apply(batch: WriteBatch): Promise<WriteResult> { return Promise.resolve({ Applied: batch.Operations.length, Failures: [] }) },
            Dispose(): Promise<void> { return Promise.resolve() },
        }
        return { Kind: kind, Open(_c: ResolvedConnection): Promise<IDataSourceAdapter> { return Promise.resolve(adapter) } }
    }

    public static Service(authz?: IConnectorReadAuthorization): ConnectorService
    {
        const { model } = check([{ uri: 'shop.todl', text: DecisionsFixture.Meta }])
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, new DataSourceAdapterCatalog().Register(DecisionsFixture.Factory(DataSourceKind.Sql)))
        const runtime = new ConnectorRuntime(SolutionConnectorPlanner.Plan(model), services)
        return new ConnectorService(() => Promise.resolve(runtime), undefined, authz === undefined ? undefined : () => Promise.resolve(authz))
    }

    public static Context(): AccessContext
    {
        return new AccessContext(new Principal('p1', 't1', PrincipalKind.User, new Map(), []), new Tenant('t1', TenantKind.SelfHosted, 'Tenant One'), [], new ResourceAuthorizationPolicy())
    }
}

class HideSilver implements IInstanceFilter
{
    public Keep(view: IInstanceView): boolean { return view.Field('tier') !== 'silver' }
}

class HideName implements IFieldReadMask
{
    public CanRead(_concept: string, field: string): boolean { return field !== 'name' }
}

test('connector/decisions reports which source won each merged field', async () =>
{
    const service = DecisionsFixture.Service()
    const decisions = await service.Decisions(DecisionsFixture.Model, undefined, DecisionsFixture.Context())
    const names = decisions.filter(d => d.member === 'name')
    assert.equal(names.length, 2, JSON.stringify(decisions))
    assert.ok(names.every(d => d.source === 'crm.people' && d.strategy === 'source'), JSON.stringify(names))
    const one = await service.Decisions(DecisionsFixture.Model, names[0]!.canonical, DecisionsFixture.Context())
    assert.ok(one.length > 0 && one.every(d => d.canonical === names[0]!.canonical))
})

test('connector/decisions never lists a hidden row or a masked field', async () =>
{
    const rows = DecisionsFixture.Service({ Filter: new HideSilver(), FieldMask: AllowAllFieldReadMask.Instance, IdentityBacked: true })
    const visible = await rows.Decisions(DecisionsFixture.Model, undefined, DecisionsFixture.Context())
    assert.equal(new Set(visible.map(d => d.canonical)).size, 1, JSON.stringify(visible))
    const masked = DecisionsFixture.Service({ Filter: { Keep: () => true }, FieldMask: new HideName(), IdentityBacked: true })
    assert.ok((await masked.Decisions(DecisionsFixture.Model, undefined, DecisionsFixture.Context())).every(d => d.member !== 'name'))
})
