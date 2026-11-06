import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GraphCreateParamsDto, GraphDetailDto, GraphExportDto, GraphLoadParamsDto, GraphLoadedDto, GraphRefParamsDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { EnvironmentNotFoundError } from '../environment-service.js'
import { GraphWireCodes } from '../graph-error-code.js'
import { AdminProxyError, AdminProxyErrorKind, type AdminConnectInfo, type AdminSnapshot, type IAdminProxy } from '../admin-proxy.js'
import { GraphService, GraphExistsError, GraphNotFoundError, GraphNameInvalidError, type IEnvironmentLookup } from '../graph-service.js'
import { EnvironmentNotDevelopmentError, EnvironmentNotRuntimeError } from '../environment-service.js'

class Fixture
{
    public static readonly Dev1 = 'dev1'
    public static readonly G1 = 'g1'
    public static readonly Description = 'first'
    public static readonly Missing = 'missing'
    public static readonly CreatedAt = '2026-10-20T00:00:00.000Z'
    public static readonly ExistsCode = -32041
    public static readonly NotFoundCode = -32040
    public static readonly NameInvalidCode = -32042
    public static readonly PackageConflictCode = -32043
    public static readonly PackageSegmentCode = -32044
    public static readonly PackageMissingCode = -32045
    public static readonly NotFoundMessage = 'Graph not found: g1'
    public static readonly BadName = 'Bad Name'
    public static readonly OtherMessage = 'boom'
    public static readonly Unused = 'unused'
    public static readonly Rt1 = 'rt1'
    public static readonly Dev2 = 'dev2'
    public static readonly PromotedAt = '2026-10-20T01:00:00.000Z'

    public static readonly Info: AdminConnectInfo = { httpUrl: 'http://h', wsUrl: 'ws://h', tenant: 'dev1', email: 'e', password: 'p' }

    public static Record(name: string, type: EnvType): EnvironmentRecord
    {
        return {
            name,
            type,
            template: Template.DevBlank,
            environmentId: name,
            hostPort: 9100,
            containerName: name,
            volumeName: name,
            bundleDir: name,
            createdAt: Fixture.CreatedAt,
            status: EnvStatus.Running
        }
    }

    public static Coded(code: number): AdminProxyError
    {
        return new AdminProxyError(AdminProxyErrorKind.Protocol, Fixture.OtherMessage, false, code)
    }

    public static Summary(name: string, count: number): GraphSummaryDto
    {
        return { name, description: Fixture.Description, packageCount: count, createdAt: Fixture.CreatedAt }
    }
}

class FakeLookup implements IEnvironmentLookup
{
    private readonly records = new Map<string, EnvironmentRecord>()

    public Add(record: EnvironmentRecord): void
    {
        this.records.set(record.name, record)
    }

    public Get(name: string): EnvironmentRecord | undefined
    {
        return this.records.get(name)
    }
}

class FakeAdminProxy implements IAdminProxy
{
    public Calls: string[] = []
    public Infos: AdminConnectInfo[] = []
    public Throw: Error | undefined
    /** When set, sampled at every Track: how many admin leases are held during each proxy call. */
    public HeldProbe: (() => number) | undefined
    public HeldAtCalls: number[] = []
    public Detail: GraphDetailDto = { name: Fixture.G1, description: Fixture.Description, packages: [{ id: 'p', version: '1' }, { id: 'q', version: '2' }], createdAt: Fixture.CreatedAt }
    public Export: GraphExportDto = { name: Fixture.G1, packages: [{ id: 'p', version: '1', modelJson: '{"p":1}' }, { id: 'q', version: '2', modelJson: '{"q":2}' }] }
    public Loaded: GraphLoadedDto = { name: Fixture.G1, packages: [{ id: 'p', version: '1' }, { id: 'q', version: '2' }], promotedAt: Fixture.PromotedAt }

    public async ExportGraph(info: AdminConnectInfo, params: GraphRefParamsDto): Promise<GraphExportDto>
    {
        this.Track(info, `export:${params.graphName}`)
        return this.Export
    }

    public async LoadGraph(info: AdminConnectInfo, params: GraphLoadParamsDto): Promise<GraphLoadedDto>
    {
        this.Track(info, `load:${params.graphName}:${params.packages.length}`)
        return this.Loaded
    }

    public async GetLoadedGraph(info: AdminConnectInfo): Promise<GraphLoadedDto | null>
    {
        this.Track(info, 'loaded')
        return this.Loaded
    }

    public async CreateGraph(info: AdminConnectInfo, params: GraphCreateParamsDto): Promise<GraphSummaryDto>
    {
        this.Track(info, `create:${params.graphName}:${params.description}`)
        return Fixture.Summary(params.graphName, 0)
    }

    public async ListGraphs(info: AdminConnectInfo): Promise<GraphSummaryDto[]>
    {
        this.Track(info, 'list')
        return [Fixture.Summary(Fixture.G1, 3)]
    }

    public async GetGraph(info: AdminConnectInfo, params: GraphRefParamsDto): Promise<GraphDetailDto>
    {
        this.Track(info, `get:${params.graphName}`)
        return this.Detail
    }

    public async IssueToken(_info: AdminConnectInfo, _params: any): Promise<any>
    {
        throw new Error('unused')
    }

    public async ListTokens(_info: AdminConnectInfo): Promise<any>
    {
        throw new Error('unused')
    }

    public async RevokeToken(_info: AdminConnectInfo, _params: any): Promise<any>
    {
        throw new Error('unused')
    }

    public async DeleteGraph(info: AdminConnectInfo, params: GraphRefParamsDto): Promise<void>
    {
        this.Track(info, `delete:${params.graphName}`)
    }

    public async LoadAdmin(): Promise<AdminSnapshot>
    {
        throw new Error(Fixture.Unused)
    }

    public async CreateAccount(): Promise<void>
    {
        throw new Error(Fixture.Unused)
    }

    public async DisableAccount(): Promise<void>
    {
        throw new Error(Fixture.Unused)
    }

    public async GrantRole(): Promise<void>
    {
        throw new Error(Fixture.Unused)
    }

    public async RevokeRole(): Promise<void>
    {
        throw new Error(Fixture.Unused)
    }

    public async GetConfig(): Promise<never>
    {
        throw new Error(Fixture.Unused)
    }

    public async SetConfig(): Promise<void>
    {
        throw new Error(Fixture.Unused)
    }

    public async GetSecurityModel(): Promise<never>
    {
        throw new Error(Fixture.Unused)
    }

    public async SetSecurityModel(): Promise<void>
    {
        throw new Error(Fixture.Unused)
    }

    private Track(info: AdminConnectInfo, call: string): void
    {
        this.Calls.push(call)
        this.Infos.push(info)
        if (this.HeldProbe)
        {
            this.HeldAtCalls.push(this.HeldProbe())
        }
        if (this.Throw)
        {
            throw this.Throw
        }
    }
}

class Harness
{
    public readonly Proxy = new FakeAdminProxy()
    public readonly Lookup = new FakeLookup()
    public InfoCalls: string[] = []
    public readonly Service: GraphService
    /** IAdminAccess: records which env each admin call ran against and how many stay held. */
    public Held = 0

    public constructor(type: EnvType = EnvType.Development)
    {
        this.Lookup.Add(Fixture.Record(Fixture.Dev1, type))
        this.Service = new GraphService(this.Lookup, this.Proxy, this)
    }

    public async WithAdmin<T>(name: string, op: (info: AdminConnectInfo) => Promise<T>): Promise<T>
    {
        this.InfoCalls.push(name)
        this.Held++
        try
        {
            return await op(Fixture.Info)
        }
        finally
        {
            this.Held--
        }
    }
}

test('Create delegates to the proxy with the env admin info and maps the summary', async () =>
{
    const h = new Harness()
    const dto = await h.Service.Create(Fixture.Dev1, Fixture.G1, Fixture.Description)
    assert.deepEqual(h.Proxy.Calls, ['create:g1:first'])
    assert.deepEqual(h.Proxy.Infos, [Fixture.Info])
    assert.deepEqual(h.InfoCalls, [Fixture.Dev1])
    assert.deepEqual(dto, { name: Fixture.G1, description: Fixture.Description, packageCount: 0, createdAt: Fixture.CreatedAt })
})

test('List maps each summary', async () =>
{
    const h = new Harness()
    const list = await h.Service.List(Fixture.Dev1)
    assert.equal(list.length, 1)
    assert.equal(list[0]!.packageCount, 3)
    assert.deepEqual(h.Proxy.Infos, [Fixture.Info])
})

test('Get maps the detail with packageCount from packages', async () =>
{
    const h = new Harness()
    const dto = await h.Service.Get(Fixture.Dev1, Fixture.G1)
    assert.deepEqual(h.Proxy.Calls, ['get:g1'])
    assert.deepEqual(dto, { name: Fixture.G1, description: Fixture.Description, packageCount: 2, createdAt: Fixture.CreatedAt })
})

test('Delete delegates to the proxy', async () =>
{
    const h = new Harness()
    await h.Service.Delete(Fixture.Dev1, Fixture.G1)
    assert.deepEqual(h.Proxy.Calls, ['delete:g1'])
    assert.deepEqual(h.Proxy.Infos, [Fixture.Info])
})

test('a Runtime environment is rejected locally without proxying', async () =>
{
    const h = new Harness(EnvType.Runtime)
    await assert.rejects(h.Service.Create(Fixture.Dev1, Fixture.G1, ''), EnvironmentNotDevelopmentError)
    await assert.rejects(h.Service.List(Fixture.Dev1), EnvironmentNotDevelopmentError)
    assert.deepEqual(h.Proxy.Calls, [])
    assert.deepEqual(h.InfoCalls, [])
})

test('an unknown environment is rejected locally without proxying', async () =>
{
    const h = new Harness()
    await assert.rejects(h.Service.Create(Fixture.Missing, Fixture.G1, ''), EnvironmentNotFoundError)
    assert.deepEqual(h.Proxy.Calls, [])
})

test('graph codes are classified back into graph errors', async () =>
{
    const h = new Harness()
    h.Lookup.Add(Fixture.Record(Fixture.Rt1, EnvType.Runtime))
    h.Proxy.Throw = Fixture.Coded(Fixture.ExistsCode)
    await assert.rejects(h.Service.Create(Fixture.Dev1, Fixture.G1, ''), GraphExistsError)
    h.Proxy.Throw = Fixture.Coded(Fixture.NotFoundCode)
    await assert.rejects(h.Service.Get(Fixture.Dev1, Fixture.G1), GraphNotFoundError)
    await assert.rejects(h.Service.Delete(Fixture.Dev1, Fixture.G1), GraphNotFoundError)
    await assert.rejects(h.Service.Promote(Fixture.Dev1, Fixture.G1, Fixture.Rt1), GraphNotFoundError)
    h.Proxy.Throw = Fixture.Coded(Fixture.NameInvalidCode)
    await assert.rejects(h.Service.Create(Fixture.Dev1, Fixture.BadName, ''), GraphNameInvalidError)
})

test('a connection failure surfaces as the AdminProxyError', async () =>
{
    const h = new Harness()
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Connect)
    await assert.rejects(h.Service.List(Fixture.Dev1), (err: unknown) => err instanceof AdminProxyError && err.Kind === AdminProxyErrorKind.Connect)
})

test('an unrecognised container error passes through unchanged', async () =>
{
    const h = new Harness()
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, Fixture.OtherMessage)
    await assert.rejects(h.Service.Get(Fixture.Dev1, Fixture.G1), (err: unknown) => err instanceof AdminProxyError && err.message === Fixture.OtherMessage)
})

test('a Protocol error without a graph code passes through even when its text says not found', async () =>
{
    const h = new Harness()
    const thrown = new AdminProxyError(AdminProxyErrorKind.Protocol, Fixture.NotFoundMessage)
    h.Proxy.Throw = thrown
    await assert.rejects(h.Service.Get(Fixture.Dev1, Fixture.G1), (err: unknown) => err === thrown)
})

test('package codes pass through as the AdminProxyError with its Code', async () =>
{
    const h = new Harness()
    h.Lookup.Add(Fixture.Record(Fixture.Rt1, EnvType.Runtime))
    h.Proxy.Throw = Fixture.Coded(Fixture.PackageConflictCode)
    await assert.rejects(h.Service.Promote(Fixture.Dev1, Fixture.G1, Fixture.Rt1), (err: unknown) => err instanceof AdminProxyError && err.Code === Fixture.PackageConflictCode)
})

test('segment and missing package codes pass through as the AdminProxyError with their Code', async () =>
{
    const h = new Harness()
    h.Lookup.Add(Fixture.Record(Fixture.Rt1, EnvType.Runtime))
    for (const code of [Fixture.PackageSegmentCode, Fixture.PackageMissingCode])
    {
        h.Proxy.Throw = Fixture.Coded(code)
        await assert.rejects(h.Service.Promote(Fixture.Dev1, Fixture.G1, Fixture.Rt1), (err: unknown) => err instanceof AdminProxyError && err.Code === code)
    }
})

test('a non-Protocol proxy error carrying a graph code is never reclassified', async () =>
{
    const h = new Harness()
    const thrown = new AdminProxyError(AdminProxyErrorKind.Connect, Fixture.OtherMessage, false, Fixture.NotFoundCode)
    h.Proxy.Throw = thrown
    await assert.rejects(h.Service.Get(Fixture.Dev1, Fixture.G1), (err: unknown) => err === thrown)
})

test('GraphWireCodes.Includes is true for every graph code and false for others', () =>
{
    for (const code of [-32040, -32041, -32042, -32043, -32044, -32045])
    {
        assert.equal(GraphWireCodes.Includes(code), true)
    }
    assert.equal(GraphWireCodes.Includes(-32603), false)
    assert.equal(GraphWireCodes.Includes(undefined), false)
})

test('promote_rejects_runtime_source_and_development_target', async () =>
{
    // A Runtime SOURCE fails the Development gate before any proxy call.
    const runtimeSource = new Harness()
    runtimeSource.Lookup.Add(Fixture.Record(Fixture.Rt1, EnvType.Runtime))
    await assert.rejects(runtimeSource.Service.Promote(Fixture.Rt1, Fixture.G1, Fixture.Dev1), EnvironmentNotDevelopmentError)
    assert.deepEqual(runtimeSource.Proxy.Calls, [])

    // A Development TARGET fails the Runtime gate before any proxy call.
    const devTarget = new Harness()
    devTarget.Lookup.Add(Fixture.Record(Fixture.Dev2, EnvType.Development))
    await assert.rejects(devTarget.Service.Promote(Fixture.Dev1, Fixture.G1, Fixture.Dev2), EnvironmentNotRuntimeError)
    assert.deepEqual(devTarget.Proxy.Calls, [])
})

test('Promote exports from the dev source and loads the exported packages into the runtime target', async () =>
{
    const h = new Harness()
    h.Lookup.Add(Fixture.Record(Fixture.Rt1, EnvType.Runtime))
    const result = await h.Service.Promote(Fixture.Dev1, Fixture.G1, Fixture.Rt1)
    assert.deepEqual(h.Proxy.Calls, [`export:${Fixture.G1}`, `load:${Fixture.G1}:2`])
    assert.deepEqual(h.InfoCalls, [Fixture.Dev1, Fixture.Rt1])
    assert.deepEqual(result, { graphName: Fixture.G1, packageCount: 2, targetEnv: Fixture.Rt1 })
})

test('every graph call holds its environment lease for the proxy call and releases it after', async () =>
{
    const h = new Harness()
    h.Lookup.Add(Fixture.Record(Fixture.Rt1, EnvType.Runtime))
    h.Proxy.HeldProbe = () => h.Held
    await h.Service.List(Fixture.Dev1)
    await h.Service.Get(Fixture.Dev1, Fixture.G1)
    await h.Service.Promote(Fixture.Dev1, Fixture.G1, Fixture.Rt1)
    await h.Service.GetLoaded(Fixture.Rt1)
    // List, Get: one lease each; Promote's export AND load both run with source and target leased; GetLoaded: one.
    assert.deepEqual(h.Proxy.HeldAtCalls, [1, 1, 2, 2, 1])
    assert.equal(h.Held, 0)
})

test('a failing graph call still releases its lease', async () =>
{
    const h = new Harness()
    h.Proxy.Throw = new Error('boom')
    await assert.rejects(h.Service.List(Fixture.Dev1))
    assert.equal(h.Held, 0)
})

test('GetLoaded requires a Runtime environment and returns the loaded manifest', async () =>
{
    const h = new Harness()
    h.Lookup.Add(Fixture.Record(Fixture.Rt1, EnvType.Runtime))
    const loaded = await h.Service.GetLoaded(Fixture.Rt1)
    assert.deepEqual(h.Proxy.Calls, ['loaded'])
    assert.deepEqual(loaded, { name: Fixture.G1, packages: [{ id: 'p', version: '1' }, { id: 'q', version: '2' }], promotedAt: Fixture.PromotedAt })
    await assert.rejects(h.Service.GetLoaded(Fixture.Dev1), EnvironmentNotRuntimeError)
})
