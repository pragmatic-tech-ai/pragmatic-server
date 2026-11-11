import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes, GraphProtocol, AdminProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { GraphContributeParamsDto, GraphCreateParamsDto, GraphDetailDto, GraphExportDto, GraphRefParamsDto, GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { PolicyGate } from '../policy-gate.js'
import { ScopedAccessContext, TokenScope } from '../token-scope.js'
import { GraphNotFoundError, GraphExistsError, GraphNameInvalidError } from '../graphs/dev-graph-service.js'
import type { IDevGraphService } from '../graphs/dev-graph-service.js'
import { GraphPackageConflictError, GraphPackageSegmentError } from '../graphs/graph-package-ingest.js'
import { GraphPackageMissingError } from '../graphs/graph-package-reader.js'
import { GraphErrorCode } from '../graphs/graph-error-codes.js'

class FakeGraphService implements IDevGraphService
{
    public readonly Calls: string[] = []
    public Failure: Error | undefined

    public async ExportGraph(params: GraphRefParamsDto): Promise<GraphExportDto>
    {
        this.Fail()
        return { name: params.graphName, packages: [] }
    }

    private Fail(): void
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
    }

    public async CreateGraph(params: GraphCreateParamsDto): Promise<GraphSummaryDto>
    {
        this.Fail()
        this.Calls.push(GraphFixture.CreateCall + params.graphName)
        return { name: params.graphName, description: params.description, packageCount: 0, createdAt: GraphFixture.Stamp }
    }

    public async ListGraphs(): Promise<GraphSummaryDto[]>
    {
        this.Fail()
        this.Calls.push(GraphFixture.ListCall)
        return [{ name: GraphFixture.GraphName, description: GraphFixture.Description, packageCount: 0, createdAt: GraphFixture.Stamp }]
    }

    public async GetGraph(params: GraphRefParamsDto): Promise<GraphDetailDto>
    {
        this.Fail()
        this.Calls.push(GraphFixture.GetCall + params.graphName)
        return { name: params.graphName, description: GraphFixture.Description, packages: [], createdAt: GraphFixture.Stamp }
    }

    public async ContributeGraph(params: GraphContributeParamsDto): Promise<GraphDetailDto>
    {
        this.Fail()
        this.Calls.push(GraphFixture.ContributeCall + params.graphName)
        return { name: params.graphName, description: GraphFixture.Description, packages: [], createdAt: GraphFixture.Stamp }
    }

    public async DeleteGraph(params: GraphRefParamsDto): Promise<void>
    {
        this.Fail()
        this.Calls.push(GraphFixture.DeleteCall + params.graphName)
    }
}

class LanguageSpy
{
    public readonly Changes: string[] = []
    public readonly Seen: Promise<void>
    private markSeen: () => void = () => undefined

    public constructor()
    {
        this.Seen = new Promise<void>(resolve =>
        {
            this.markSeen = resolve
        })
    }

    public Service(): ILanguageService
    {
        const signal = { subscribe: () => ({ dispose: () => undefined }) }
        return {
            GraphChanged: signal,
            BuildStateChanged: signal,
            DidChange: (uri: string) =>
            {
                this.Changes.push(uri)
                this.markSeen()
            },
            DiagnosticsFor: async () => [],
        } as unknown as ILanguageService
    }
}

class GraphFixture
{
    public static readonly DocUri = 'file:///a.todl'
    public static readonly DocText = 'x'
    public static readonly GraphName = 'sales'
    public static readonly Description = 'sales graph'
    public static readonly Stamp = '2026-10-20T00:00:00.000Z'
    public static readonly CreateCall = 'create:'
    public static readonly ListCall = 'list'
    public static readonly GetCall = 'get:'
    public static readonly DeleteCall = 'delete:'
    public static readonly ContributeCall = 'contribute:'
    public static readonly SolutionId = 'sol-1'
    public static readonly NotFoundMessage = 'Graph not found: sales'
    public static readonly PackageId = 'p'
    public static readonly PackageVersion = '1.0.0'
    public static readonly InternalMessage = 'internal error'
    public static readonly SecretDetail = 'secret detail'
    public static readonly OutsideScopeText = "outside this credential's scope"
    public static readonly UnavailableText = 'graph service is not available'
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

    public async With(purpose: TenantPurpose, body: (client: PragmaticClient) => Promise<void>, wired: boolean = true, context: AccessContext = GraphFixture.Context(Role.Owner), language: ILanguageService = GraphFixture.Language()): Promise<void>
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(
            serverSocket, language, {} as SolutionManagerService, context, () => Promise.reject(new Error()), undefined,
            undefined, undefined, undefined, undefined, undefined, undefined, purpose, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, undefined, wired ? this.Service : undefined)
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
            client.ContributeGraph({ graphName: GraphFixture.GraphName, solutionId: GraphFixture.SolutionId, packages: [] }),
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

test('a Development tenant with no graph service rejects graph ops with InvalidRequest (defensive branch)', async () =>
{
    const fixture = new GraphFixture()
    await fixture.With(TenantPurpose.Development, async client =>
    {
        const error = await GraphFixture.ErrorOf(client.CreateGraph({ graphName: GraphFixture.GraphName, description: GraphFixture.Description }))
        assert.equal(error.code, ErrorCodes.InvalidRequest)
        assert.ok((error.message ?? '').includes(GraphFixture.UnavailableText))
        assert.deepEqual(fixture.Service.Calls, [])
    }, false)
})

test('graph/contribute delegates to the service and returns the detail (Development)', async () =>
{
    const fixture = new GraphFixture()
    await fixture.With(TenantPurpose.Development, async client =>
    {
        const detail = await client.ContributeGraph({ graphName: GraphFixture.GraphName, solutionId: GraphFixture.SolutionId, packages: [] })
        assert.equal(detail.name, GraphFixture.GraphName)
        assert.deepEqual(fixture.Service.Calls, [GraphFixture.ContributeCall + GraphFixture.GraphName])
    })
})

test('graph/contribute with no graph service rejects with the unavailable error', async () =>
{
    const fixture = new GraphFixture()
    await fixture.With(TenantPurpose.Development, async client =>
    {
        const error = await GraphFixture.ErrorOf(client.ContributeGraph({ graphName: GraphFixture.GraphName, solutionId: GraphFixture.SolutionId, packages: [] }))
        assert.equal(error.code, ErrorCodes.InvalidRequest)
        assert.ok((error.message ?? '').includes(GraphFixture.UnavailableText))
    }, false)
})

test('the policy gate maps graph/contribute to the Contribute action on the tenant', () =>
{
    const decision = GraphFixture.Gate(Role.Maker).Authorize(GraphProtocol.Contribute.method)
    assert.equal(decision.Allowed, true)
    assert.equal(GraphFixture.Gate(null).Authorize(GraphProtocol.Contribute.method).Allowed, false)
    assert.equal(GraphFixture.Gate(Role.Viewer).Authorize(GraphProtocol.Contribute.method).Allowed, false)
})

test('a Maker-only principal may contribute but nothing else', () =>
{
    const gate = GraphFixture.Gate(Role.Maker)
    assert.equal(gate.Authorize(GraphProtocol.Contribute.method).Allowed, true)
    for (const method of [GraphProtocol.Create.method, GraphProtocol.Delete.method, GraphProtocol.List.method, GraphProtocol.Get.method, AdminProtocol.IssueToken.method])
    {
        assert.equal(gate.Authorize(method).Allowed, false, method)
    }
})

test('an Owner may contribute', () =>
{
    assert.equal(GraphFixture.Gate(Role.Owner).Authorize(GraphProtocol.Contribute.method).Allowed, true)
})

test('a graph-contribute service credential is refused graph/delete even with an Owner role; an unscoped Owner is not', async () =>
{
    const fixture = new GraphFixture()
    const scoped = new ScopedAccessContext(GraphFixture.Context(Role.Owner), [TokenScope.GraphContribute])
    await fixture.With(TenantPurpose.Development, async client =>
    {
        const error = await GraphFixture.ErrorOf(client.DeleteGraph({ graphName: GraphFixture.GraphName }))
        assert.equal(error.code, ErrorCodes.InvalidRequest)
        assert.ok((error.message ?? '').includes(GraphFixture.OutsideScopeText))
        await client.ListGraphs()
        assert.deepEqual(fixture.Service.Calls, [GraphFixture.ListCall])
    }, true, scoped)
    const open = new GraphFixture()
    await open.With(TenantPurpose.Development, async client =>
    {
        await client.DeleteGraph({ graphName: GraphFixture.GraphName })
        assert.deepEqual(open.Service.Calls, [GraphFixture.DeleteCall + GraphFixture.GraphName])
    })
})

test('graph failures answer their typed code with the unchanged message', async () =>
{
    const fixture = new GraphFixture()
    const ref = { graphName: GraphFixture.GraphName }
    const contribute = { graphName: GraphFixture.GraphName, solutionId: GraphFixture.SolutionId, packages: [] }
    await fixture.With(TenantPurpose.Development, async client =>
    {
        fixture.Service.Failure = new GraphNotFoundError(GraphFixture.GraphName)
        let error = await GraphFixture.ErrorOf(client.GetGraph(ref))
        assert.equal(error.code, GraphErrorCode.NotFound)
        assert.equal(error.code, -32040)
        assert.equal(error.message, GraphFixture.NotFoundMessage)
        fixture.Service.Failure = new GraphExistsError(GraphFixture.GraphName)
        error = await GraphFixture.ErrorOf(client.CreateGraph({ graphName: GraphFixture.GraphName, description: GraphFixture.Description }))
        assert.equal(error.code, -32041)
        fixture.Service.Failure = new GraphNameInvalidError(GraphFixture.GraphName)
        error = await GraphFixture.ErrorOf(client.GetGraph(ref))
        assert.equal(error.code, -32042)
        fixture.Service.Failure = new GraphPackageConflictError()
        error = await GraphFixture.ErrorOf(client.ContributeGraph(contribute))
        assert.equal(error.code, -32043)
        fixture.Service.Failure = new GraphPackageSegmentError()
        error = await GraphFixture.ErrorOf(client.ContributeGraph(contribute))
        assert.equal(error.code, -32044)
        fixture.Service.Failure = new GraphPackageMissingError({ id: GraphFixture.PackageId, version: GraphFixture.PackageVersion })
        error = await GraphFixture.ErrorOf(client.ExportGraph(ref))
        assert.equal(error.code, -32045)
        assert.equal(error.message, fixture.Service.Failure.message)
    })
})

test('a non-graph failure still answers -32603 internal error', async () =>
{
    const fixture = new GraphFixture()
    await fixture.With(TenantPurpose.Development, async client =>
    {
        fixture.Service.Failure = new Error(GraphFixture.SecretDetail)
        const error = await GraphFixture.ErrorOf(client.GetGraph({ graphName: GraphFixture.GraphName }))
        assert.equal(error.code, ErrorCodes.InternalError)
        assert.equal(error.message, GraphFixture.InternalMessage)
    })
})

test('a scoped credential\'s language notifications are dropped; an unscoped one still runs them', async () =>
{
    const scoped = new ScopedAccessContext(GraphFixture.Context(Role.Owner), [TokenScope.GraphContribute])
    const droppedSpy = new LanguageSpy()
    await new GraphFixture().With(TenantPurpose.Development, async client =>
    {
        client.DidChange(GraphFixture.DocUri, GraphFixture.DocText)
        await client.ListGraphs()
        assert.deepEqual(droppedSpy.Changes, [])
    }, true, scoped, droppedSpy.Service())
    const runSpy = new LanguageSpy()
    await new GraphFixture().With(TenantPurpose.Development, async client =>
    {
        client.DidChange(GraphFixture.DocUri, GraphFixture.DocText)
        await runSpy.Seen
        assert.deepEqual(runSpy.Changes, [GraphFixture.DocUri])
    }, true, GraphFixture.Context(Role.Owner), runSpy.Service())
})
