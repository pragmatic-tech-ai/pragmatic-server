import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, StorageProtocol, SolutionProtocol, GraphProtocol, PragmaticAppProtocol, AppDataProtocol, AdminProtocol, CypherProtocol, ErrorCodes, type MessageConnection, type GraphContributeParamsDto, type GraphCreateParamsDto, type GraphDetailDto, type GraphExportDto, type GraphRefParamsDto, type GraphSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, DevelopMethods, ScopedAccessContext, TokenScope, TokenScopeGate } from '@pragmatic-tech-ai/pragmatic-identity'
import { FakeStorage, Signal } from '@pragmatic-tech-ai/todl-runtime'
import { EnvSolutionRoots } from '../solutions/env-solution-roots.js'
import { MemoryStorageRegistry } from '../solutions/tests/memory-storage-registry.js'
import { GraphBuildState, type SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import { SourceChangeBridge } from '../solutions/source-change-bridge.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import type { IDevGraphService } from '../graphs/dev-graph-service.js'

class RecordingGraphService implements IDevGraphService
{
    public readonly Contributed: string[] = []

    public async ContributeGraph(params: GraphContributeParamsDto): Promise<GraphDetailDto>
    {
        this.Contributed.push(params.graphName)
        return { name: params.graphName, description: '', packages: [], createdAt: DevelopFixture.Stamp }
    }

    public async ExportGraph(params: GraphRefParamsDto): Promise<GraphExportDto>
    {
        return { name: params.graphName, packages: [] }
    }

    public async CreateGraph(params: GraphCreateParamsDto): Promise<GraphSummaryDto>
    {
        return { name: params.graphName, description: params.description, packageCount: 0, createdAt: DevelopFixture.Stamp }
    }

    public async ListGraphs(): Promise<GraphSummaryDto[]>
    {
        return []
    }

    public async GetGraph(params: GraphRefParamsDto): Promise<GraphDetailDto>
    {
        return { name: params.graphName, description: '', packages: [], createdAt: DevelopFixture.Stamp }
    }

    public async ListSolutionIds(): Promise<string[]>
    {
        return []
    }

    public async DeleteGraph(): Promise<void>
    {
    }
}

type GraphChange = { memberIds: Set<string>; fileIds: Set<string> }

/**
 * One shared dev environment: one manager, one language service, one SourceChangeBridge. The language service is a
 * minimal stand-in whose DidChange behaves as the real one does for the fan-out: it emits GraphChanged (a real
 * ILanguageService needs a full solution/compiler stack the existing harness does not stand up).
 */
class DevelopFixture
{
    public static readonly Stamp = '2026-11-17T00:00:00.000Z'
    public static readonly SourcePath = 'a/x.todl'
    public static readonly SourceText = 'entity X {}'
    public static readonly ActiveName = 'sol-active'
    public static readonly SelectedId = 'sol-x'
    public static readonly GraphName = 'g1'
    public static readonly SolutionId = 'sol-1'
    public static readonly AddedKind = 'added'
    public static readonly OutsideScopeMessage = "method is outside this credential's scope"
    public static readonly CreateParams = { graphName: 'g1', description: '' }
    private static readonly EnvironmentId = 't1'
    private static readonly PrincipalId = 'p1'
    private static readonly EnvironmentName = 'Environment One'

    public readonly DidChangeUris: string[] = []
    public readonly Graphs = new RecordingGraphService()
    public readonly Manager: SolutionManagerService
    public readonly Bridge: SourceChangeBridge
    private readonly graphChanged = new Signal<GraphChange>()
    private readonly language: ILanguageService

    public constructor()
    {
        const quiet = { subscribe: () => ({ dispose: () => undefined }) }
        this.language = {
            GraphChanged: this.graphChanged,
            BuildStateChanged: quiet,
            BuildState: GraphBuildState.Ready,
            DidChange: (uri: string) =>
            {
                this.DidChangeUris.push(uri)
                this.graphChanged.emit({ memberIds: new Set(), fileIds: new Set([uri]) })
            },
        } as unknown as ILanguageService
        this.Bridge = new SourceChangeBridge(this.language)
        this.Manager = { ActiveSolution: { Name: DevelopFixture.ActiveName, Storage: new FakeStorage(), Members: { ToArray: () => [] } } } as unknown as SolutionManagerService
    }

    public static Context(scopes: readonly string[], role: Role = Role.Owner): AccessContext
    {
        const realm = new Realm(DevelopFixture.EnvironmentId, RealmKind.SelfHosted, DevelopFixture.EnvironmentName)
        const principal = new Principal(DevelopFixture.PrincipalId, DevelopFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(DevelopFixture.PrincipalId, role, new ResourceRef(ResourceKind.Realm, DevelopFixture.EnvironmentId, []))]
        return new ScopedAccessContext(new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy()), scopes)
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(resolve => setTimeout(resolve, 50))
    }

    public Attach(scopes: readonly string[] = [TokenScope.Develop], role: Role = Role.Owner, roots?: EnvSolutionRoots): DevelopConnection
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, this.language, this.Manager, DevelopFixture.Context(scopes, role), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, EnvironmentPurpose.Development, undefined, undefined, undefined, undefined, undefined, this.Graphs, undefined, undefined, undefined, undefined, this.Bridge, roots)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        const connection = new DevelopConnection(handler, client)
        client.onNotification(StorageProtocol.Changed, payload => { connection.StoragePushes.push(payload) })
        client.onNotification(SolutionProtocol.GraphChanged, payload => { connection.GraphPushes.push(payload) })
        client.listen()
        return connection
    }
}

class DevelopConnection
{
    public readonly StoragePushes: unknown[] = []
    public readonly GraphPushes: unknown[] = []

    public constructor(public readonly Handler: ServerConnectionHandler, public readonly Client: MessageConnection)
    {
    }

    public Dispose(): void
    {
        this.Client.dispose()
        this.Handler.Dispose()
    }
}

test('a source save on connection A pushes storage/changed and solution/graphChanged to connection B', async () =>
{
    const fx = new DevelopFixture()
    const a = fx.Attach()
    const b = fx.Attach()
    try
    {
        await a.Client.sendRequest(StorageProtocol.WriteText, { Path: DevelopFixture.SourcePath, Content: DevelopFixture.SourceText })
        await DevelopFixture.Settle()
        assert.deepEqual(b.StoragePushes, [{ Kind: DevelopFixture.AddedKind, Path: DevelopFixture.SourcePath, IsDirectory: false }])
        assert.equal(fx.DidChangeUris.length, 1)
        assert.equal(b.GraphPushes.length, 1)
        const payload = b.GraphPushes[0] as { memberIds: string[]; fileIds: string[] }
        assert.deepEqual(payload.memberIds, [])
        assert.deepEqual(payload.fileIds, fx.DidChangeUris)
        assert.ok(payload.fileIds[0]!.endsWith(DevelopFixture.SourcePath))
        assert.equal(a.GraphPushes.length, 1)
    }
    finally
    {
        a.Dispose()
        b.Dispose()
    }
})

test('selectAuthoring on A leaves connection B and the global ActiveSolution untouched', async () =>
{
    const fx = new DevelopFixture()
    const globalBefore = fx.Manager.ActiveSolution
    const a = fx.Attach()
    const b = fx.Attach()
    try
    {
        await a.Client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: DevelopFixture.SelectedId })
        assert.equal(a.Handler.Authoring.SolutionId, DevelopFixture.SelectedId)
        assert.equal(b.Handler.Authoring.SolutionId, DevelopFixture.ActiveName)
        assert.equal(fx.Manager.ActiveSolution, globalBefore)
    }
    finally
    {
        a.Dispose()
        b.Dispose()
    }
})

test('graph/contribute succeeds under the develop scope, which allowlists it, while graph/create is denied by scope (and allowed without it)', async () =>
{
    const fx = new DevelopFixture()
    const a = fx.Attach([TokenScope.Develop])
    try
    {
        assert.ok(DevelopMethods.All.includes(GraphProtocol.Contribute.method))
        assert.ok(!DevelopMethods.All.includes(GraphProtocol.Create.method))
        const detail = await a.Client.sendRequest(GraphProtocol.Contribute, { graphName: DevelopFixture.GraphName, solutionId: DevelopFixture.SolutionId, packages: [] })
        assert.equal(detail.name, DevelopFixture.GraphName)
        assert.deepEqual(fx.Graphs.Contributed, [DevelopFixture.GraphName])
        await assert.rejects(() => a.Client.sendRequest(GraphProtocol.Create, DevelopFixture.CreateParams), (e: { code?: number; message?: string }) => e.code === ErrorCodes.InvalidRequest && e.message === DevelopFixture.OutsideScopeMessage)
        const control = fx.Attach([])
        try
        {
            const created = await control.Client.sendRequest(GraphProtocol.Create, DevelopFixture.CreateParams)
            assert.equal(created.name, DevelopFixture.GraphName)
        }
        finally
        {
            control.Dispose()
        }
    }
    finally
    {
        a.Dispose()
    }
})

class DeveloperAuthz
{
    public static readonly NewName = 'sol-new'
    public static readonly Area = 'env/solutions'
    public static readonly AppOpen = { name: 'app' }
    public static readonly DataWrite = { appName: 'app', changes: [] }
    public static readonly OtherLocation = 'x'
}

test('authz: solution/create is allowlisted for develop and runs under Role.Developer; escalation methods stay denied', async () =>
{
    assert.ok(DevelopMethods.All.includes(SolutionProtocol.CreateSolution.method))
    for (const escalation of [SolutionProtocol.OpenSolution.method, GraphProtocol.Create.method, GraphProtocol.Delete.method, GraphProtocol.Load.method, GraphProtocol.Loaded.method, AdminProtocol.ListGrants.method, CypherProtocol.Execute.method, PragmaticAppProtocol.Open.method, AppDataProtocol.Write.method])
    {
        assert.ok(!DevelopMethods.All.includes(escalation), escalation)
    }
    const fx = new DevelopFixture()
    const roots = new EnvSolutionRoots(DeveloperAuthz.Area, new MemoryStorageRegistry())
    const manager = fx.Manager as unknown as { OpenSolution: (location: string) => Promise<void> }
    manager.OpenSolution = async () => undefined
    const a = fx.Attach([TokenScope.Develop], Role.Developer, roots)
    try
    {
        const result = await a.Client.sendRequest(SolutionProtocol.CreateSolution, { Name: DeveloperAuthz.NewName })
        assert.deepEqual(result, { Name: DeveloperAuthz.NewName, Created: true })
        const denied = (e: { code?: number; message?: string }) => e.code === ErrorCodes.InvalidRequest && e.message === DevelopFixture.OutsideScopeMessage
        await assert.rejects(() => a.Client.sendRequest(SolutionProtocol.OpenSolution, { location: DeveloperAuthz.OtherLocation }), denied)
        await assert.rejects(() => a.Client.sendRequest(GraphProtocol.Create, DevelopFixture.CreateParams), denied)
        await assert.rejects(() => a.Client.sendRequest(PragmaticAppProtocol.Open, DeveloperAuthz.AppOpen as never), denied)
        await assert.rejects(() => a.Client.sendRequest(AppDataProtocol.Write, DeveloperAuthz.DataWrite as never), denied)
        await assert.rejects(() => a.Client.sendRequest(GraphProtocol.Loaded), denied)
        // admin/* and cypher/execute handlers are not registered in this fixture (no admin/cypher service), so assert the develop scope gate itself denies them
        const gate = TokenScopeGate.For([TokenScope.Develop])
        for (const method of [AdminProtocol.ListGrants.method, AdminProtocol.GrantRole.method, AdminProtocol.IssueToken.method, CypherProtocol.Execute.method])
        {
            assert.equal(gate.Allows(method), false, method)
        }
    }
    finally
    {
        a.Dispose()
    }
})
