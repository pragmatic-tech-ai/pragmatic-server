import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope } from '@pragmatic-tech-ai/graph'
import type { INodeView } from '@pragmatic-tech-ai/graph'
import { DataSourceAdapterCatalog, QueryCompareOp, WriteOperationKind } from '@pragmatic-tech-ai/todl'
import type { QueryRequest } from '@pragmatic-tech-ai/todl'
import { ShareRight, ShareSubject, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { AppWriteStatus, ConnectorFilterOp, ConnectorWriteOp, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ConnectorPagedWriteResultDto, ConnectorWriteOpDto, EntityDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessLevel, OwnershipSourceKind, Principal, PrincipalKind, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PagingLimits } from '../../../config/paging-limits.js'
import { EnvironmentFixture } from '../../environment/tests/environment-fixture.js'
import { AccessScopeSource } from '../access-scope-source.js'
import { DevGraphEngineHost } from '../dev-graph-engine-host.js'
import { DevScopeRules } from '../dev-scope-rules.js'
import { EngineConnectorService } from '../engine-connector-service.js'
import type { IGraphConnectorService } from '../engine-connector-service.js'
import { DevScopeFx } from './dev-scope-fixture.js'
import { EngineHostFx, FakeSolution, HeldFence, ManualTimer, MemoryStorage } from './engine-host-fixture.js'
import { MemorySourceAdapter, MemorySourceAdapterFactory } from './memory-source-adapter.js'

/**
 * A runtime tenant delivering `crm` (crm.Account, engine-stored, owned by its `owner` field) and `ext` over the
 * fixture's MemorySourceAdapter: ext.Customer (writable; `name` in `nm`, the integer `amount` in `amt`), ext.Vendor
 * (read-only), ext.Order (optimistic, version field `ver`) and ext.Ledger (an integer id member). With identity, p1
 * reads every account and deletes only its own; p3 reads only its own. Neither holds anything on the ext concepts (connector data is outside platform
 * security, amendment A6).
 */
class ConnectorFx
{
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly CrmApp = 'crm-app'
    public static readonly ExtApp = 'ext-app'
    public static readonly AppVersion = '1.0.0'
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; owner : string?; }\n  model Crm : crm { }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { id : string?; name : string?; amount : integer?; score : number?; }\n  concept Vendor { id : string?; name : string?; }\n'
        + '  concept Order { id : string?; total : integer?; ver : integer?; }\n  concept Ledger { id : integer?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n'
        + '  model Ext : ext { connect src; populate Customer key cust_id { id = "cust_id"; name = "nm"; amount = "amt"; score = "sc"; } populate Vendor key vend_id { id = "vend_id"; name = "nm"; read-only; }'
        + ' populate Order key ord_id { id = "ord_id"; total = "tot"; ver = "ver"; version ver; concurrency optimistic; } populate Ledger key led_id { id = "led_id"; } }\n}\n'
    public static readonly ModelId = 'ext'
    public static readonly Connector = 'src'
    public static readonly Account = 'crm.Account'
    public static readonly Customer = 'ext.Customer'
    public static readonly Ledger = 'ext.Ledger'
    public static readonly LedgerSource = 'Ledger'
    /** 2^63: one past the Int64 maximum. */
    public static readonly BeyondInt64 = '9223372036854775808'
    public static readonly Vendor = 'ext.Vendor'
    public static readonly Order = 'ext.Order'
    public static readonly CustomerSource = 'Customer'
    public static readonly VendorSource = 'Vendor'
    public static readonly OrderSource = 'Order'
    public static readonly CustomerKey = 'cust_id'
    public static readonly VendorKey = 'vend_id'
    public static readonly OrderKey = 'ord_id'
    public static readonly NameField = 'nm'
    public static readonly AmountField = 'amt'
    public static readonly ScoreField = 'sc'
    public static readonly Score = 'score'
    public static readonly TotalField = 'tot'
    public static readonly VersionField = 'ver'
    public static readonly Name = 'name'
    public static readonly Amount = 'amount'
    public static readonly Total = 'total'
    public static readonly Owner = 'owner'
    public static readonly Acme = 'Acme'
    public static readonly Bolt = 'Bolt'
    public static readonly Cog = 'Cog'
    public static readonly Renamed = 'Acme Two'
    public static readonly P1 = 'p1'
    public static readonly P2 = 'p2'
    public static readonly P3 = 'p3'
    public static readonly R1 = 'r1'
    public static readonly R2 = 'r2'
    public static readonly Root = 'root'
    public static readonly Reader = 'reader'
    public static readonly OwnReader = 'own-reader'
    public static readonly WriteConflict = 'write conflict'
    public static readonly RecordDenied = 'not authorized for this record'
    public static readonly NoVersionField = 'expectedVersion needs a binding with a version field'
    public static readonly KeyNotFit = 'the key does not fit the binding\'s id field'
    public static readonly G1 = 'g1'
    public static readonly NothingToFlush = 'NothingToFlush'
    public static readonly UnknownFilterField = /unknown filter field/
    public static readonly ReadWhere = /where is supported on connector\/readPage only/
    public static readonly Missing = 'nope'

    /** p1 reads every account and creates, updates, deletes its own; p3 reads its own. */
    public static Model(): ISecurityModelConfig
    {
        const own = [PrivilegeAction.Create, PrivilegeAction.Update, PrivilegeAction.Delete].map(action => ({ action, level: AccessLevel.User, concept: ConnectorFx.Account }))
        const members = [ConnectorFx.P1, ConnectorFx.P2, ConnectorFx.P3].map(principalId => ({ principalId, homeBusinessUnit: ConnectorFx.Root, teams: [] }))
        return {
            businessUnits: [{ id: ConnectorFx.Root, name: ConnectorFx.Root }],
            teams: [],
            membership: { claimsMapping: [], overrides: members },
            ownershipRules: [{ concept: ConnectorFx.Account, owner: { kind: OwnershipSourceKind.FromField, value: ConnectorFx.Owner }, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: ConnectorFx.Root } }],
            roles: [
                { id: ConnectorFx.Reader, name: ConnectorFx.Reader, privileges: [{ action: PrivilegeAction.Read, level: AccessLevel.Organization, concept: ConnectorFx.Account }, ...own] },
                { id: ConnectorFx.OwnReader, name: ConnectorFx.OwnReader, privileges: [{ action: PrivilegeAction.Read, level: AccessLevel.User, concept: ConnectorFx.Account }] },
            ],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: ConnectorFx.P1, roles: [ConnectorFx.Reader] },
                { principalId: ConnectorFx.P2, roles: [ConnectorFx.Reader] },
                { principalId: ConnectorFx.P3, roles: [ConnectorFx.OwnReader] },
            ] },
        }
    }

    /** crm and ext live, the sources seeded, the server started with identity and the security model. */
    public static async Run(body: (fx: EnvironmentFixture, service: IGraphConnectorService) => Promise<void>, adapter: MemorySourceAdapter = new MemorySourceAdapter()): Promise<void>
    {
        const fx = new EnvironmentFixture(adapter)
        try
        {
            await fx.Package(ConnectorFx.Crm.id, ConnectorFx.Crm.version, ConnectorFx.CrmTodl)
            await fx.Package(ConnectorFx.Ext.id, ConnectorFx.Ext.version, ConnectorFx.ExtTodl)
            fx.Live(ConnectorFx.CrmApp, ConnectorFx.AppVersion, [ConnectorFx.Crm])
            fx.Live(ConnectorFx.ExtApp, ConnectorFx.AppVersion, [ConnectorFx.Ext])
            fx.Source.Adapter.Seed(ConnectorFx.CustomerSource, [
                { [ConnectorFx.CustomerKey]: 'k1', [ConnectorFx.NameField]: ConnectorFx.Acme, [ConnectorFx.AmountField]: '50', [ConnectorFx.ScoreField]: '1.5' },
                { [ConnectorFx.CustomerKey]: 'k2', [ConnectorFx.NameField]: ConnectorFx.Bolt, [ConnectorFx.AmountField]: '150', [ConnectorFx.ScoreField]: '2.5' },
                { [ConnectorFx.CustomerKey]: 'k3', [ConnectorFx.NameField]: ConnectorFx.Cog, [ConnectorFx.AmountField]: '300' },
            ])
            fx.Source.Adapter.Seed(ConnectorFx.VendorSource, [{ [ConnectorFx.VendorKey]: 'v1', [ConnectorFx.NameField]: ConnectorFx.Acme }])
            fx.Source.Adapter.Seed(ConnectorFx.OrderSource, [{ [ConnectorFx.OrderKey]: 'o1', [ConnectorFx.TotalField]: '10', [ConnectorFx.VersionField]: 1 }])
            await fx.Start({ Identity: true, SecurityModel: ConnectorFx.Model() })
            await body(fx, fx.Server.EnvironmentConnectors())
        }
        finally
        {
            await fx.Dispose()
        }
    }

    public static Context(fx: EnvironmentFixture, principal: string = ConnectorFx.P1): ReturnType<EnvironmentFixture['ContextFor']>
    {
        return fx.ContextFor(new Principal(principal, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), []))
    }

    /** Every page of `concept` (pages of `pageSize`), concatenated. */
    public static async ReadAll(service: IGraphConnectorService, context: ReturnType<EnvironmentFixture['ContextFor']>, modelId: string, concept: string, pageSize: number): Promise<EntityDto[]>
    {
        const items: EntityDto[] = []
        let cursor: string | undefined
        for (let page = 0; page < 10; page++)
        {
            const result = await service.Read(context, { modelId, concept, pageSize, ...(cursor === undefined ? {} : { cursor }) }, new PagingLimits())
            items.push(...result.items)
            cursor = result.nextCursor
            if (cursor === undefined) return items
        }
        throw new Error('paging did not end')
    }

    public static Upsert(concept: string, source: string, key: string, fields: Record<string, string | number | null>, expectedVersion?: number): ConnectorWriteOpDto
    {
        return { op: ConnectorWriteOp.Upsert, concept, connector: ConnectorFx.Connector, source, key, fields, ...(expectedVersion === undefined ? {} : { expectedVersion }) }
    }

    public static Delete(concept: string, source: string, key: string): ConnectorWriteOpDto
    {
        return { op: ConnectorWriteOp.Delete, concept, connector: ConnectorFx.Connector, source, key }
    }

    public static Statuses(result: ConnectorPagedWriteResultDto): (string | undefined)[][]
    {
        return result.results.map(r => [r.status, r.reason])
    }

    /** The last QueryRequest the source received for `source`. */
    public static LastRequest(adapter: MemorySourceAdapter, source: string): QueryRequest
    {
        const requests = adapter.Requests.filter(request => request.Source === source)
        assert.ok(requests.length > 0, 'the source was read')
        return requests[requests.length - 1]!
    }

    public static Pushed(request: QueryRequest, field: string): boolean
    {
        return (request.Where?.All ?? []).some(term => term.Field === field)
    }

    public static async Node(fx: EnvironmentFixture, id: string): Promise<INodeView | undefined>
    {
        const reader = await (await fx.Server.EnvironmentEngine().Engine()).BeginRead(AccessScope.System)
        try
        {
            return await reader.ReadNode(id)
        }
        finally
        {
            reader.dispose()
        }
    }

    /** A share grant of `record` to p2 (System transaction). */
    public static async Grant(fx: EnvironmentFixture, id: string, record: string): Promise<void>
    {
        const transaction = await (await fx.Server.EnvironmentEngine().Engine()).Begin(AccessScope.System)
        transaction.CreateNode(id, SystemNames.ShareGrant, { Owner: SystemNames.Model })
        transaction.SetProperty(id, SystemNames.SubjectKind, ShareSubject.Principal)
        transaction.SetProperty(id, SystemNames.SubjectId, ConnectorFx.P2)
        transaction.SetProperty(id, ShareRight.Read, true)
        transaction.Link(id, SystemNames.Record, record)
        await transaction.Commit()
    }

    public static async CustomerId(fx: EnvironmentFixture, key: string): Promise<string>
    {
        const identity = (await fx.Server.EnvironmentEngine().Snapshot()).Catalog.Identity
        return identity.Mint(identity.CreateTarget(ConnectorFx.Customer)!, key)
    }

    public static async VendorId(fx: EnvironmentFixture, key: string): Promise<string>
    {
        const identity = (await fx.Server.EnvironmentEngine().Snapshot()).Catalog.Identity
        return identity.Mint(identity.CreateTarget(ConnectorFx.Vendor)!, key)
    }

    public static IsInvalidParams(pattern: RegExp): (error: unknown) => boolean
    {
        return (error: unknown) => error instanceof ResponseError && error.code === ErrorCodes.InvalidParams && pattern.test(error.message)
    }
}

/** A dev engine over the shared engine-host fixture plus member `c` binding crm.Customer to a MemorySourceAdapter. */
class DevConnectorFx
{
    public static readonly Root = 'mem/c'
    public static readonly File = 'crm.todl'
    public static readonly Customer = 'crm.Customer'
    public static readonly Bound = 'namespace crm {\n  concept Customer { id : string?; name : string?; }\n  datasource crm { kind = sql; connection = "crm-db"; }\n  model App : crm { connect crm; populate Customer key cust_id { id = "cust_id"; name = "nm"; } }\n}\n'

    public static readonly Source = 'Customer'
    public static readonly Connector = 'crm'
    public static readonly KeyField = 'cust_id'
    public static readonly NameField = 'nm'

    public readonly Fx = new EngineHostFx()
    public readonly Factory = new MemorySourceAdapterFactory()
    public readonly Host: DevGraphEngineHost
    public readonly Service: EngineConnectorService

    public constructor()
    {
        const c = new MemoryStorage(DevConnectorFx.Root, { [DevConnectorFx.File]: DevConnectorFx.Bound })
        this.Fx.Solution = new FakeSolution(EngineHostFx.SolutionName, [{ Storage: this.Fx.A }, { Storage: this.Fx.B }, { Storage: c }])
        this.Factory.Adapter.Seed(DevConnectorFx.Source, [
            { [DevConnectorFx.KeyField]: '1', [DevConnectorFx.NameField]: ConnectorFx.Acme },
            { [DevConnectorFx.KeyField]: '2', [DevConnectorFx.NameField]: ConnectorFx.Bolt },
        ])
        const services = new ServiceProvider()
        const adapters = new DataSourceAdapterCatalog().Register(this.Factory)
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, adapters)
        this.Host = new DevGraphEngineHost(this.Fx.Source, () => Promise.resolve(this.Fx.Lang), new ManualTimer(), undefined, undefined, undefined, undefined, () => services)
        this.Host.InstallWriteFence(HeldFence.Instance)
        const scopes = new AccessScopeSource(this.Host, new DevScopeRules(this.Host, undefined, false))
        this.Service = new EngineConnectorService(this.Host, () => Promise.resolve(scopes), adapters, services)
    }

    /** The one connector model of the dev solution. */
    public async ModelId(): Promise<string>
    {
        const listed = await this.Service.List()
        assert.equal(listed.length, 1, JSON.stringify(listed))
        return listed[0]!.modelId
    }

    public static Op(op: ConnectorWriteOp, key: string, fields?: Record<string, string>): ConnectorWriteOpDto
    {
        return { op, concept: DevConnectorFx.Customer, connector: DevConnectorFx.Connector, source: DevConnectorFx.Source, key, ...(fields === undefined ? {} : { fields }) }
    }
}

describe('connector endpoints on the engine', () =>
{
    test('read pages a binding through the scope', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            const listed = await service.List()
            const ext = listed.find(model => model.modelId === ConnectorFx.ModelId)
            assert.ok(ext !== undefined, JSON.stringify(listed))
            assert.deepEqual(ext.bindings.map(b => [b.concept, b.connector, b.writable]).sort(), [
                [ConnectorFx.Customer, ConnectorFx.Connector, true],
                [ConnectorFx.Ledger, ConnectorFx.Connector, true],
                [ConnectorFx.Order, ConnectorFx.Connector, true],
                [ConnectorFx.Vendor, ConnectorFx.Connector, false],
            ])
            assert.deepEqual(await service.Decisions(ConnectorFx.Context(fx), ConnectorFx.ModelId, undefined), [], 'nothing is merged (Q4)')
            // the handler serves the same service over the wire (RuntimeAttachArgs.connectors)
            const client = await fx.Connect(new Principal(ConnectorFx.P1, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), []))
            assert.deepEqual((await client.Connectors()).map(model => model.modelId), listed.map(model => model.modelId))
            assert.equal((await client.ReadEntitiesPage(ConnectorFx.ModelId, ConnectorFx.Customer, {}, [{ field: ConnectorFx.Name, op: ConnectorFilterOp.Eq, value: ConnectorFx.Bolt }])).items.length, 1)
            // p1 holds nothing on ext.Customer: connector data is outside platform security (A6); pages concatenate
            const rows = await ConnectorFx.ReadAll(service, ConnectorFx.Context(fx), ConnectorFx.ModelId, ConnectorFx.Customer, 2)
            assert.deepEqual(rows.map(row => row.fields[ConnectorFx.Name]).sort(), [ConnectorFx.Acme, ConnectorFx.Bolt, ConnectorFx.Cog])
            assert.equal(new Set(rows.map(row => row.id)).size, 3, 'no row repeats across pages')
            const acme = rows.find(row => row.fields[ConnectorFx.Name] === ConnectorFx.Acme)!
            assert.equal(acme.id, await ConnectorFx.CustomerId(fx, 'k1'))
            assert.equal(acme.concept, ConnectorFx.Customer)
            assert.deepEqual([acme.fields.id, acme.fields[ConnectorFx.Name], acme.fields[ConnectorFx.Amount]], ['k1', ConnectorFx.Acme, 50], 'an Int64 is a number on the wire')
            // an engine-stored concept keeps the caller scope: p3 reads only its own account
            await fx.Seed([
                { Concept: ConnectorFx.Account, Id: ConnectorFx.R1, Properties: { [ConnectorFx.Name]: ConnectorFx.R1, [ConnectorFx.Owner]: ConnectorFx.P3 } },
                { Concept: ConnectorFx.Account, Id: ConnectorFx.R2, Properties: { [ConnectorFx.Name]: ConnectorFx.R2, [ConnectorFx.Owner]: ConnectorFx.P2 } },
            ])
            const own = await ConnectorFx.ReadAll(service, ConnectorFx.Context(fx, ConnectorFx.P3), ConnectorFx.Crm.id, ConnectorFx.Account, 1)
            assert.deepEqual(own.map(row => row.id), [ConnectorFx.R1], 'the hidden account is absent')
        })
    })

    test('readPage string equality is pushed to the source', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            const page = await service.ReadPage(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, concept: ConnectorFx.Customer, where: [{ field: ConnectorFx.Name, op: ConnectorFilterOp.Eq, value: ConnectorFx.Acme }] }, new PagingLimits())
            assert.deepEqual(page.items.map(row => row.fields[ConnectorFx.Name]), [ConnectorFx.Acme])
            const request = ConnectorFx.LastRequest(fx.Source.Adapter, ConnectorFx.CustomerSource)
            assert.ok((request.Where?.All ?? []).some(term => term.Field === ConnectorFx.NameField && term.Op === QueryCompareOp.Eq && term.Value === ConnectorFx.Acme), JSON.stringify(request))
            // isNull on a typed property is pushed too
            await service.ReadPage(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, concept: ConnectorFx.Customer, where: [{ field: ConnectorFx.Amount, op: ConnectorFilterOp.IsNull }] }, new PagingLimits())
            assert.ok(ConnectorFx.Pushed(ConnectorFx.LastRequest(fx.Source.Adapter, ConnectorFx.CustomerSource), ConnectorFx.AmountField))
        })
    })

    test('readPage numeric filter is evaluated by the engine', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            const read = async (field: string, op: ConnectorFilterOp, value: string | number): Promise<unknown[]> =>
            {
                const page = await service.ReadPage(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, concept: ConnectorFx.Customer, where: [{ field, op, value }] }, new PagingLimits())
                return page.items.map(row => row.fields[ConnectorFx.Name]).sort()
            }
            assert.deepEqual(await read(ConnectorFx.Amount, ConnectorFilterOp.Gt, 100), [ConnectorFx.Bolt, ConnectorFx.Cog])
            const request = ConnectorFx.LastRequest(fx.Source.Adapter, ConnectorFx.CustomerSource)
            assert.equal(ConnectorFx.Pushed(request, ConnectorFx.AmountField), false, 'no numeric term reaches the source: every row is fetched')
            assert.deepEqual(await read(ConnectorFx.Amount, ConnectorFilterOp.Eq, 150), [ConnectorFx.Bolt])
            assert.equal(ConnectorFx.Pushed(ConnectorFx.LastRequest(fx.Source.Adapter, ConnectorFx.CustomerSource), ConnectorFx.AmountField), false)
            assert.deepEqual(await read(ConnectorFx.Score, ConnectorFilterOp.Eq, 2.5), [ConnectorFx.Bolt])
            assert.equal(ConnectorFx.Pushed(ConnectorFx.LastRequest(fx.Source.Adapter, ConnectorFx.CustomerSource), ConnectorFx.ScoreField), false, 'eq on a Float64 member is not pushed')
            assert.deepEqual(await read(ConnectorFx.Name, ConnectorFilterOp.Neq, ConnectorFx.Acme), [ConnectorFx.Bolt, ConnectorFx.Cog])
            assert.equal(ConnectorFx.Pushed(ConnectorFx.LastRequest(fx.Source.Adapter, ConnectorFx.CustomerSource), ConnectorFx.NameField), false, 'ne on a String member is not pushed')
            assert.deepEqual(await read(ConnectorFx.Name, ConnectorFilterOp.Lt, ConnectorFx.Bolt), [ConnectorFx.Acme])
            assert.equal(ConnectorFx.Pushed(ConnectorFx.LastRequest(fx.Source.Adapter, ConnectorFx.CustomerSource), ConnectorFx.NameField), false, 'lt on a String member is not pushed')
            // an unknown field is InvalidParams; connector/read still refuses where
            await assert.rejects(service.ReadPage(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, concept: ConnectorFx.Customer, where: [{ field: ConnectorFx.Missing, op: ConnectorFilterOp.Eq, value: 1 }] }, new PagingLimits()),
                ConnectorFx.IsInvalidParams(ConnectorFx.UnknownFilterField))
            await assert.rejects(service.Read(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, concept: ConnectorFx.Customer, where: [{ field: ConnectorFx.Name, op: ConnectorFilterOp.Eq, value: ConnectorFx.Acme }] }, new PagingLimits()),
                ConnectorFx.IsInvalidParams(ConnectorFx.ReadWhere))
        })
    })

    test('writePaged creates new keys', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            const result = await service.WritePaged(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, operations: [
                ConnectorFx.Upsert(ConnectorFx.Customer, ConnectorFx.CustomerSource, 'k8', { [ConnectorFx.Name]: 'Dyn', [ConnectorFx.Amount]: 7 }),
                ConnectorFx.Upsert(ConnectorFx.Customer, ConnectorFx.CustomerSource, 'k9', { [ConnectorFx.Name]: 'Eon' }),
            ] })
            assert.deepEqual(result.results, [{ key: 'k8', status: AppWriteStatus.Applied }, { key: 'k9', status: AppWriteStatus.Applied }], JSON.stringify(result))
            const rows = fx.Source.Adapter.Rows(ConnectorFx.CustomerSource)
            assert.deepEqual(rows.find(row => row[ConnectorFx.CustomerKey] === 'k8'), { [ConnectorFx.CustomerKey]: 'k8', [ConnectorFx.NameField]: 'Dyn', [ConnectorFx.AmountField]: 7 })
            assert.ok(rows.some(row => row[ConnectorFx.CustomerKey] === 'k9' && row[ConnectorFx.NameField] === 'Eon'))
            const unfit = await service.WritePaged(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, operations: [{ ...ConnectorFx.Upsert(ConnectorFx.Customer, ConnectorFx.CustomerSource, 'x', {}), key: true }] })
            assert.deepEqual(ConnectorFx.Statuses(unfit), [[AppWriteStatus.Invalid, ConnectorFx.KeyNotFit]], 'a boolean key does not fit a String id member')
            const beyond = await service.WritePaged(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, operations: [ConnectorFx.Upsert(ConnectorFx.Ledger, ConnectorFx.LedgerSource, ConnectorFx.BeyondInt64, {})] })
            assert.deepEqual(ConnectorFx.Statuses(beyond), [[AppWriteStatus.Invalid, ConnectorFx.KeyNotFit]], 'an integer key beyond the Int64 range does not fit an Int64 id member')
        })
    })

    test('writePaged upserts existing rows and deletes', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            const result = await service.WritePaged(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, operations: [
                ConnectorFx.Upsert(ConnectorFx.Customer, ConnectorFx.CustomerSource, 'k1', { [ConnectorFx.Name]: ConnectorFx.Renamed }),
                ConnectorFx.Delete(ConnectorFx.Customer, ConnectorFx.CustomerSource, 'k2'),
                ConnectorFx.Delete(ConnectorFx.Customer, ConnectorFx.CustomerSource, 'k404'),
            ] })
            assert.deepEqual(result.results, [{ key: 'k1', status: AppWriteStatus.Applied }, { key: 'k2', status: AppWriteStatus.Applied }, { key: 'k404', status: AppWriteStatus.Applied }],
                'a key the source no longer holds is already deleted (R48)')
            const rows = fx.Source.Adapter.Rows(ConnectorFx.CustomerSource)
            assert.equal(rows.find(row => row[ConnectorFx.CustomerKey] === 'k1')![ConnectorFx.NameField], ConnectorFx.Renamed, 'the existing row is updated, not created')
            assert.equal(rows.some(row => row[ConnectorFx.CustomerKey] === 'k2'), false, 'the deleted row is gone')
            assert.deepEqual(fx.Source.Adapter.Batches.flatMap(batch => batch.Operations.map(op => [op.Kind, op.Key])).sort(), [[WriteOperationKind.Delete, 'k2'], [WriteOperationKind.Upsert, 'k1']])
        })
    })

    test('writePaged expectedVersion guards the write', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            const stale = await service.WritePaged(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, operations: [ConnectorFx.Upsert(ConnectorFx.Order, ConnectorFx.OrderSource, 'o1', { [ConnectorFx.Total]: 11 }, 7)] })
            assert.deepEqual(ConnectorFx.Statuses(stale), [[AppWriteStatus.Conflict, ConnectorFx.WriteConflict]])
            assert.equal(fx.Source.Adapter.Batches.length, 0, 'nothing was written')
            const unversioned = await service.WritePaged(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, operations: [ConnectorFx.Upsert(ConnectorFx.Customer, ConnectorFx.CustomerSource, 'k1', { [ConnectorFx.Name]: ConnectorFx.Renamed }, 1)] })
            assert.deepEqual(ConnectorFx.Statuses(unversioned), [[AppWriteStatus.Invalid, ConnectorFx.NoVersionField]])
            const applied = await service.WritePaged(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, operations: [ConnectorFx.Upsert(ConnectorFx.Order, ConnectorFx.OrderSource, 'o1', { [ConnectorFx.Total]: 12 }, 1)] })
            assert.deepEqual(applied.results, [{ key: 'o1', status: AppWriteStatus.Applied }], 'no version is reported (R50)')
            assert.equal(fx.Source.Adapter.Rows(ConnectorFx.OrderSource)[0]![ConnectorFx.TotalField], 12)
            assert.equal(fx.Source.Adapter.Batches.length, 1)
        })
    })

    test('writePaged outside the scope is denied', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            const result = await service.WritePaged(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, operations: [
                ConnectorFx.Upsert(ConnectorFx.Vendor, ConnectorFx.VendorSource, 'v1', { [ConnectorFx.Name]: ConnectorFx.Renamed }),
                ConnectorFx.Upsert(ConnectorFx.Customer, ConnectorFx.CustomerSource, 'k1', { [ConnectorFx.Name]: ConnectorFx.Renamed }),
            ] })
            assert.deepEqual(result.results[0], { key: 'v1', status: AppWriteStatus.Denied, reason: ConnectorFx.RecordDenied }, 'the read-only guard (Finish (c)) refuses the write')
            assert.equal(result.results[1]!.status, AppWriteStatus.Failed, 'the batch is one transaction')
            assert.equal(fx.Source.Adapter.Batches.length, 0, 'nothing was written')
            assert.equal(fx.Source.Adapter.Rows(ConnectorFx.VendorSource)[0]![ConnectorFx.NameField], ConnectorFx.Acme)
        })
    })

    test('writeBack deletes under the scope', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            await fx.Seed([
                { Concept: ConnectorFx.Account, Id: ConnectorFx.R1, Properties: { [ConnectorFx.Name]: ConnectorFx.R1, [ConnectorFx.Owner]: ConnectorFx.P1 } },
                { Concept: ConnectorFx.Account, Id: ConnectorFx.R2, Properties: { [ConnectorFx.Name]: ConnectorFx.R2, [ConnectorFx.Owner]: ConnectorFx.P2 } },
            ])
            // engine-resident: p1 may delete its own account, not p2's; nothing is removed (audit defect 2)
            const denied = await service.WriteBack(ConnectorFx.Context(fx), { modelId: ConnectorFx.Crm.id, dirty: [], deleted: [ConnectorFx.R1, ConnectorFx.R2] })
            assert.equal(denied.results.length, 1)
            assert.equal(denied.results[0]!.applied, 0)
            assert.deepEqual(denied.results[0]!.failures.map(f => f.key), [ConnectorFx.R2], JSON.stringify(denied))
            assert.ok(await ConnectorFx.Node(fx, ConnectorFx.R1) !== undefined && await ConnectorFx.Node(fx, ConnectorFx.R2) !== undefined, 'nothing was removed')
            // p1's own account goes, with the share grant linking it, in the same transaction (R49)
            await ConnectorFx.Grant(fx, ConnectorFx.G1, ConnectorFx.R1)
            const own = await service.WriteBack(ConnectorFx.Context(fx), { modelId: ConnectorFx.Crm.id, dirty: [], deleted: [ConnectorFx.R1] })
            assert.deepEqual(own, { results: [{ applied: 1, failures: [] }], diagnostics: [] }, JSON.stringify(own))
            assert.equal(await ConnectorFx.Node(fx, ConnectorFx.R1), undefined)
            assert.equal(await ConnectorFx.Node(fx, ConnectorFx.G1), undefined, 'the grant is gone with its record')
            // external: a read-only binding's row cannot be deleted, a writable one's is, after the fetch
            const vendor = await ConnectorFx.VendorId(fx, 'v1')
            const refused = await service.WriteBack(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, dirty: [], deleted: [vendor] })
            assert.equal(refused.results[0]!.applied, 0)
            assert.deepEqual(refused.results[0]!.failures.map(f => f.key), [vendor], JSON.stringify(refused))
            assert.equal(fx.Source.Adapter.Rows(ConnectorFx.VendorSource).length, 1)
            const customer = await ConnectorFx.CustomerId(fx, 'k3')
            const removed = await service.WriteBack(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, dirty: [], deleted: [customer] })
            assert.deepEqual(removed, { results: [{ applied: 1, failures: [] }], diagnostics: [] })
            assert.equal(fx.Source.Adapter.Rows(ConnectorFx.CustomerSource).some(row => row[ConnectorFx.CustomerKey] === 'k3'), false)
        })
    })

    test('writeBack dirty reports nothing to flush', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            const outcome = await service.WriteBack(ConnectorFx.Context(fx), { modelId: ConnectorFx.ModelId, dirty: [await ConnectorFx.CustomerId(fx, 'k1')], deleted: [] })
            assert.deepEqual(outcome.results, [{ applied: 0, failures: [] }])
            assert.deepEqual(outcome.diagnostics.map(d => d.code), [ConnectorFx.NothingToFlush])
            assert.equal(fx.Source.Adapter.Batches.length, 0)
        })
    })

    test('refresh invalidates the adapters', async () =>
    {
        await ConnectorFx.Run(async (fx, service) =>
        {
            assert.deepEqual(await service.Test(ConnectorFx.ModelId, ConnectorFx.Connector), { ok: true })
            await ConnectorFx.ReadAll(service, ConnectorFx.Context(fx), ConnectorFx.ModelId, ConnectorFx.Customer, 10)
            const opened = fx.Source.Opened.length
            await ConnectorFx.ReadAll(service, ConnectorFx.Context(fx), ConnectorFx.ModelId, ConnectorFx.Customer, 10)
            assert.equal(fx.Source.Opened.length, opened, 'the adapter stays open between reads')
            await service.Refresh()
            const rows = await ConnectorFx.ReadAll(service, ConnectorFx.Context(fx), ConnectorFx.ModelId, ConnectorFx.Customer, 10)
            assert.equal(rows.length, 3)
            assert.equal(fx.Source.Opened.length, opened + 1, 'the next use re-opened the adapter: the catalog dropped it and the lazy connector reset')
        })
    })

    test('dev reads an external binding through the shared service', async () =>
    {
        const dev = new DevConnectorFx()
        try
        {
            const listed = await dev.Service.List()
            assert.equal(listed.length, 1, JSON.stringify(listed))
            const modelId = listed[0]!.modelId
            assert.deepEqual(listed[0]!.bindings.map(b => b.concept), [DevConnectorFx.Customer])
            const page = await dev.Service.Read(DevScopeFx.Context(DevScopeFx.P1), { modelId, concept: DevConnectorFx.Customer }, new PagingLimits())
            assert.deepEqual(page.items.map(row => row.fields[ConnectorFx.Name]).sort(), [ConnectorFx.Acme, ConnectorFx.Bolt])
        }
        finally
        {
            await dev.Host.dispose()
        }
    })

    test('dev writePaged creates and deletes through the shared service', async () =>
    {
        const dev = new DevConnectorFx()
        try
        {
            const modelId = await dev.ModelId()
            const result = await dev.Service.WritePaged(DevScopeFx.Context(DevScopeFx.P1), { modelId, operations: [
                DevConnectorFx.Op(ConnectorWriteOp.Upsert, '3', { [ConnectorFx.Name]: ConnectorFx.Cog }),
                DevConnectorFx.Op(ConnectorWriteOp.Delete, '1'),
            ] })
            assert.deepEqual(result.results, [{ key: '3', status: AppWriteStatus.Applied }, { key: '1', status: AppWriteStatus.Applied }], JSON.stringify(result))
            const rows = dev.Factory.Adapter.Rows(DevConnectorFx.Source).map(row => [row[DevConnectorFx.KeyField], row[DevConnectorFx.NameField]])
            assert.deepEqual(rows.sort(), [['2', ConnectorFx.Bolt], ['3', ConnectorFx.Cog]])
        }
        finally
        {
            await dev.Host.dispose()
        }
    })

    test('dev refresh resets the running engine\'s connectors', async () =>
    {
        const dev = new DevConnectorFx()
        try
        {
            const modelId = await dev.ModelId()
            const read = async (): Promise<number> => (await dev.Service.Read(DevScopeFx.Context(DevScopeFx.P1), { modelId, concept: DevConnectorFx.Customer }, new PagingLimits())).items.length
            assert.equal(await read(), 2)
            const opened = dev.Factory.Opened.length
            await dev.Service.Refresh()
            assert.equal(await read(), 2)
            assert.equal(dev.Factory.Opened.length, opened + 1, 'the dev host reset its lazy connectors and the catalog re-opened the adapter')
            await dev.Host.dispose()
            dev.Host.ResetConnectors()
            assert.equal(dev.Factory.Opened.length, opened + 1, 'a reset after dispose is a no-op')
        }
        finally
        {
            await dev.Host.dispose()
        }
    })
})
