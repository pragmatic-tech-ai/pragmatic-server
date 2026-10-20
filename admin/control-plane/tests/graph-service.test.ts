import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GraphCreateParamsDto, GraphDetailDto, GraphRefParamsDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { EnvironmentNotFoundError } from '../environment-service.js'
import { AdminProxyError, AdminProxyErrorKind, type AdminConnectInfo, type AdminSnapshot, type IAdminProxy } from '../admin-proxy.js'
import { GraphExistsError as ContainerExistsError, GraphNotFoundError as ContainerNotFoundError, GraphNameInvalidError as ContainerInvalidError } from '../../../src/host/graphs/dev-graph-service.js'
import { GraphService, GraphExistsError, GraphNotFoundError, GraphNameInvalidError, EnvironmentNotDevelopmentError, type IEnvironmentLookup } from '../graph-service.js'

class Fixture
{
    public static readonly Dev1 = 'dev1'
    public static readonly G1 = 'g1'
    public static readonly Description = 'first'
    public static readonly Missing = 'missing'
    public static readonly CreatedAt = '2026-10-20T00:00:00.000Z'
    public static readonly ExistsMessage = 'Graph already exists: g1'
    public static readonly NotFoundMessage = 'Graph not found: g1'
    public static readonly InvalidMessage = 'Invalid graph name: Bad Name'
    public static readonly BadName = 'Bad Name'
    public static readonly NotFoundName = 'not found'
    public static readonly ExistsName = 'already exists'
    public static readonly OtherMessage = 'boom'
    public static readonly Unused = 'unused'

    public static readonly Info: AdminConnectInfo = { httpUrl: 'http://h', wsUrl: 'ws://h', tenant: 'dev1', email: 'e', password: 'p' }

    public static Record(name: string, type: EnvType): EnvironmentRecord
    {
        return {
            name,
            type,
            template: Template.DevBlank,
            tenantId: name,
            hostPort: 9100,
            containerName: name,
            volumeName: name,
            bundleDir: name,
            createdAt: Fixture.CreatedAt,
            status: EnvStatus.Running
        }
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
    public Detail: GraphDetailDto = { name: Fixture.G1, description: Fixture.Description, packages: [{ id: 'p', version: '1' }, { id: 'q', version: '2' }], createdAt: Fixture.CreatedAt }

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

    public constructor(type: EnvType = EnvType.Development)
    {
        this.Lookup.Add(Fixture.Record(Fixture.Dev1, type))
        this.Service = new GraphService(this.Lookup, this.Proxy, async name =>
        {
            this.InfoCalls.push(name)
            return Fixture.Info
        })
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

test('container errors are classified back into graph errors', async () =>
{
    const h = new Harness()
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, Fixture.ExistsMessage)
    await assert.rejects(h.Service.Create(Fixture.Dev1, Fixture.G1, ''), GraphExistsError)
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, Fixture.NotFoundMessage)
    await assert.rejects(h.Service.Get(Fixture.Dev1, Fixture.G1), GraphNotFoundError)
    await assert.rejects(h.Service.Delete(Fixture.Dev1, Fixture.G1), GraphNotFoundError)
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, Fixture.InvalidMessage)
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

test('the classifier recognises the real container error messages', async () =>
{
    const h = new Harness()
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, new ContainerExistsError(Fixture.G1).message)
    await assert.rejects(h.Service.Create(Fixture.Dev1, Fixture.G1, ''), GraphExistsError)
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, new ContainerNotFoundError(Fixture.G1).message)
    await assert.rejects(h.Service.Get(Fixture.Dev1, Fixture.G1), GraphNotFoundError)
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, new ContainerInvalidError(Fixture.BadName).message)
    await assert.rejects(h.Service.Create(Fixture.Dev1, Fixture.BadName, ''), GraphNameInvalidError)
})

test('a non-Protocol proxy error is never reclassified as a graph error', async () =>
{
    const h = new Harness()
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Connect, Fixture.NotFoundMessage)
    await assert.rejects(h.Service.Get(Fixture.Dev1, Fixture.G1), (err: unknown) => err instanceof AdminProxyError && err.Kind === AdminProxyErrorKind.Connect)
})

test('an invalid name that embeds a sentinel phrase is still classified as invalid', async () =>
{
    const h = new Harness()
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, new ContainerInvalidError(Fixture.NotFoundName).message)
    await assert.rejects(h.Service.Create(Fixture.Dev1, Fixture.NotFoundName, ''), GraphNameInvalidError)
    h.Proxy.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, new ContainerInvalidError(Fixture.ExistsName).message)
    await assert.rejects(h.Service.Create(Fixture.Dev1, Fixture.ExistsName, ''), GraphNameInvalidError)
})
