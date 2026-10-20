import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes, GraphProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { GraphCreateParamsDto, GraphDetailDto, GraphRefParamsDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { PolicyGate } from '../policy-gate.js'
import type { IDevGraphService } from '../graphs/dev-graph-service.js'

class FakeGraphService implements IDevGraphService
{
    public readonly Calls: string[] = []

    public async CreateGraph(params: GraphCreateParamsDto): Promise<GraphSummaryDto>
    {
        this.Calls.push(GraphFixture.CreateCall + params.graphName)
        return { name: params.graphName, description: params.description, packageCount: 0, createdAt: GraphFixture.Stamp }
    }

    public async ListGraphs(): Promise<GraphSummaryDto[]>
    {
        this.Calls.push(GraphFixture.ListCall)
        return [{ name: GraphFixture.GraphName, description: GraphFixture.Description, packageCount: 0, createdAt: GraphFixture.Stamp }]
    }

    public async GetGraph(params: GraphRefParamsDto): Promise<GraphDetailDto>
    {
        this.Calls.push(GraphFixture.GetCall + params.graphName)
        return { name: params.graphName, description: GraphFixture.Description, packages: [], createdAt: GraphFixture.Stamp }
    }

    public async DeleteGraph(params: GraphRefParamsDto): Promise<void>
    {
        this.Calls.push(GraphFixture.DeleteCall + params.graphName)
    }
}

class GraphFixture
{
    public static readonly GraphName = 'sales'
    public static readonly Description = 'sales graph'
    public static readonly Stamp = '2026-10-20T00:00:00.000Z'
    public static readonly CreateCall = 'create:'
    public static readonly ListCall = 'list'
    public static readonly GetCall = 'get:'
    public static readonly DeleteCall = 'delete:'
    public static readonly NotDevelopmentText = 'operation requires a development tenant'
    private static readonly TenantId = 't1'
    private static readonly PrincipalId = 'p1'
    private static readonly TenantName = 'Tenant One'

    public readonly Service = new FakeGraphService()

    public static Gate(role: Role | null): PolicyGate
    {
        return new PolicyGate(GraphFixture.Context(role), () => [])
    }

    public static Context(role: Role | null): AccessContext
    {
        const tenant = new Tenant(GraphFixture.TenantId, TenantKind.SelfHosted, GraphFixture.TenantName)
        const principal = new Principal(GraphFixture.PrincipalId, GraphFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = role === null ? [] : [new Grant(GraphFixture.PrincipalId, role, new ResourceRef(ResourceKind.Tenant, GraphFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static Language(): ILanguageService
    {
        const signal = { subscribe: () => ({ dispose: () => undefined }) }
        return { GraphChanged: signal, BuildStateChanged: signal } as unknown as ILanguageService
    }

    public static async ErrorOf(attempt: Promise<unknown>): Promise<{ code?: number, message?: string }>
    {
        try
        {
            await attempt
        }
        catch (error)
        {
            return error as { code?: number, message?: string }
        }
        return {}
    }

    public async With(purpose: TenantPurpose, body: (client: PragmaticClient) => Promise<void>): Promise<void>
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(
            serverSocket, GraphFixture.Language(), {} as SolutionManagerService, GraphFixture.Context(Role.Owner), () => Promise.reject(new Error()), () => Promise.reject(new Error()),
            undefined, undefined, undefined, undefined, undefined, undefined, purpose, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, undefined, undefined, this.Service)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            await body(client)
        }
        finally
        {
            await client.DisposeAsync()
            handler.Dispose()
        }
    }
}

test('graph/create routes to the service and returns a GraphSummaryDto (Development)', async () =>
{
    const fixture = new GraphFixture()
    await fixture.With(TenantPurpose.Development, async client =>
    {
        const summary = await client.CreateGraph({ graphName: GraphFixture.GraphName, description: GraphFixture.Description })
        assert.deepEqual(summary, { name: GraphFixture.GraphName, description: GraphFixture.Description, packageCount: 0, createdAt: GraphFixture.Stamp })
        assert.deepEqual(fixture.Service.Calls, [GraphFixture.CreateCall + GraphFixture.GraphName])
    })
})

test('graph/list and graph/get route to the service (Development)', async () =>
{
    const fixture = new GraphFixture()
    await fixture.With(TenantPurpose.Development, async client =>
    {
        const list = await client.ListGraphs()
        assert.equal(list[0]!.name, GraphFixture.GraphName)
        const detail = await client.GetGraph({ graphName: GraphFixture.GraphName })
        assert.equal(detail.name, GraphFixture.GraphName)
        await client.DeleteGraph({ graphName: GraphFixture.GraphName })
        assert.deepEqual(fixture.Service.Calls, [GraphFixture.ListCall, GraphFixture.GetCall + GraphFixture.GraphName, GraphFixture.DeleteCall + GraphFixture.GraphName])
    })
})

test('every graph op is rejected on a Runtime tenant with NotDevelopment', async () =>
{
    const fixture = new GraphFixture()
    await fixture.With(TenantPurpose.Runtime, async client =>
    {
        const ref = { graphName: GraphFixture.GraphName }
        const attempts = [
            client.CreateGraph({ graphName: GraphFixture.GraphName, description: GraphFixture.Description }),
            client.ListGraphs(),
            client.GetGraph(ref),
            client.DeleteGraph(ref),
        ]
        for (const attempt of attempts)
        {
            const error = await GraphFixture.ErrorOf(attempt)
            assert.equal(error.code, ErrorCodes.InvalidRequest)
            assert.ok((error.message ?? '').includes(GraphFixture.NotDevelopmentText))
        }
        assert.deepEqual(fixture.Service.Calls, [])
    })
})

test('the policy gate maps the graph ops: create/delete=administer, list/get=readTenant', () =>
{
    const administer = [GraphProtocol.Create.method, GraphProtocol.Delete.method]
    const read = [GraphProtocol.List.method, GraphProtocol.Get.method]
    for (const method of [...administer, ...read])
    {
        assert.equal(GraphFixture.Gate(Role.Owner).Authorize(method).Allowed, true, method)
        assert.equal(GraphFixture.Gate(null).Authorize(method).Allowed, false, method)
    }
    for (const method of administer)
    {
        assert.equal(GraphFixture.Gate(Role.Viewer).Authorize(method).Allowed, false, method)
    }
    for (const method of read)
    {
        assert.equal(GraphFixture.Gate(Role.Viewer).Authorize(method).Allowed, true, method)
    }
})
