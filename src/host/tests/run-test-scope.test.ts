import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, RunTestProtocol, ApplicationDeployProtocol, AppDataProtocol, PragmaticAppProtocol, GraphProtocol, DataSharingProtocol, DataAssignmentProtocol, ErrorCodes, type AppDeployResultDto, type CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, DevelopMethods, RunTestMethods, ScopedAccessContext, TokenScope, TokenScopeGate } from '@pragmatic-tech-ai/pragmatic-identity'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { PolicyGate } from '../policy-gate.js'

class RunTestFixture
{
    public static readonly OutsideScopeMessage = "method is outside this credential's scope"
    public static readonly DataWriteMethod = 'data/write'
    public static readonly LoadParams = { name: 'app' } as unknown as CypherAppDeployParamsDto
    public static readonly LoadResult = { name: 'app' } as unknown as AppDeployResultDto
    private static readonly EnvironmentId = 't1'
    private static readonly PrincipalId = 'p1'

    public readonly Deployed: CypherAppDeployParamsDto[] = []

    public static Context(role: Role | null): AccessContext
    {
        const realm = new Realm(RunTestFixture.EnvironmentId, RealmKind.SelfHosted, 'Environment One')
        const principal = new Principal(RunTestFixture.PrincipalId, RunTestFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = role === null ? [] : [new Grant(RunTestFixture.PrincipalId, role, new ResourceRef(ResourceKind.Realm, RunTestFixture.EnvironmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    public static Language(): ILanguageService
    {
        const quiet = { subscribe: () => ({ dispose: () => undefined }) }
        return { GraphChanged: quiet, BuildStateChanged: quiet } as unknown as ILanguageService
    }

    public Attach(role: Role): { Handler: ServerConnectionHandler; Client: ReturnType<typeof createMessageConnection> }
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const context = new ScopedAccessContext(RunTestFixture.Context(role), [TokenScope.RunTest])
        const deploy = async (params: CypherAppDeployParamsDto): Promise<AppDeployResultDto> =>
        {
            this.Deployed.push(params)
            return RunTestFixture.LoadResult
        }
        const handler = ServerConnectionHandler.Attach(serverSocket, RunTestFixture.Language(), {} as unknown as SolutionManagerService, context, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, EnvironmentPurpose.Runtime, undefined, undefined, undefined, undefined, deploy)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        return { Handler: handler, Client: client }
    }
}

test('the run-test scope allows exactly runtime/run-test, application list and graph loaded', () =>
{
    const gate = TokenScopeGate.For([TokenScope.RunTest])
    assert.equal(TokenScope.RunTest, 'environment-run-test')
    assert.equal(gate.Allows(RunTestProtocol.Load.method), true)
    assert.equal(gate.Allows(PragmaticAppProtocol.List.method), true)
    assert.equal(gate.Allows(GraphProtocol.Loaded.method), true)
    assert.equal(gate.Allows(RunTestFixture.DataWriteMethod), false)
    assert.deepEqual([...RunTestMethods.All], [RunTestProtocol.Load.method, PragmaticAppProtocol.List.method, GraphProtocol.Loaded.method])
    for (const method of [ApplicationDeployProtocol.Deploy.method, AppDataProtocol.Write.method, PragmaticAppProtocol.Open.method, GraphProtocol.Create.method, GraphProtocol.Delete.method, DataSharingProtocol.Share.method, DataAssignmentProtocol.Assign.method])
    {
        assert.equal(gate.Allows(method), false, method)
    }
})

test('run-test is not on the develop allowlist and deploy stays administer-gated', () =>
{
    assert.ok(!DevelopMethods.All.includes(RunTestProtocol.Load.method))
    assert.equal(new PolicyGate(RunTestFixture.Context(Role.Developer), () => []).Authorize(ApplicationDeployProtocol.Deploy.method).Allowed, false)
})

test('PolicyGate classifies runtime/run-test as realm write: Developer allowed, Viewer denied', () =>
{
    assert.equal(new PolicyGate(RunTestFixture.Context(Role.Developer), () => []).Authorize(RunTestProtocol.Load.method).Allowed, true)
    assert.equal(new PolicyGate(RunTestFixture.Context(Role.Viewer), () => []).Authorize(RunTestProtocol.Load.method).Allowed, false)
})

test('a Developer+RunTest connection loads via the deploy provider and is rejected outside scope', async () =>
{
    const fx = new RunTestFixture()
    const a = fx.Attach(Role.Developer)
    try
    {
        const result = await a.Client.sendRequest(RunTestProtocol.Load, RunTestFixture.LoadParams)
        assert.deepEqual(result, RunTestFixture.LoadResult)
        assert.deepEqual(fx.Deployed, [RunTestFixture.LoadParams])
        await assert.rejects(() => a.Client.sendRequest(AppDataProtocol.Write, {} as never), (e: { code?: number; message?: string }) => e.code === ErrorCodes.InvalidRequest && e.message === RunTestFixture.OutsideScopeMessage)
        await assert.rejects(() => a.Client.sendRequest(ApplicationDeployProtocol.Deploy, RunTestFixture.LoadParams), (e: { code?: number; message?: string }) => e.code === ErrorCodes.InvalidRequest && e.message === RunTestFixture.OutsideScopeMessage)
        assert.equal(fx.Deployed.length, 1)
    }
    finally
    {
        a.Client.dispose()
        a.Handler.Dispose()
    }
})

test('a Viewer+RunTest connection is rejected on runtime/run-test by the policy check inside guarded dispatch', async () =>
{
    const fx = new RunTestFixture()
    const a = fx.Attach(Role.Viewer)
    try
    {
        await assert.rejects(() => a.Client.sendRequest(RunTestProtocol.Load, RunTestFixture.LoadParams), (e: { code?: number; message?: string }) => e.message !== RunTestFixture.OutsideScopeMessage)
        assert.equal(fx.Deployed.length, 0)
    }
    finally
    {
        a.Client.dispose()
        a.Handler.Dispose()
    }
})
