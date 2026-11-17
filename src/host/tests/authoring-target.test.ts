import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, SolutionProtocol, BuildState, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { GraphBuildState } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import type { IDevGraphService } from '../graphs/dev-graph-service.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AuthoringTarget } from '../solutions/authoring-target.js'

class AuthoringFixture
{
    public static readonly ActiveName = 'sol-active'
    public static readonly OtherA = 'sol-a'
    public static readonly OtherB = 'sol-b'
    private static readonly EnvironmentId = 't1'
    private static readonly PrincipalId = 'p1'
    private static readonly EnvironmentName = 'Environment One'

    public static Context(role: Role): AccessContext
    {
        const realm = new Realm(AuthoringFixture.EnvironmentId, RealmKind.SelfHosted, AuthoringFixture.EnvironmentName)
        const principal = new Principal(AuthoringFixture.PrincipalId, AuthoringFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(AuthoringFixture.PrincipalId, role, new ResourceRef(ResourceKind.Realm, AuthoringFixture.EnvironmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    public static Graphs(ids: string[]): IDevGraphService
    {
        return { ListSolutionIds: async () => ids } as unknown as IDevGraphService
    }

    public static Language(): ILanguageService
    {
        const signal = { subscribe: () => ({ dispose: () => undefined }) }
        return { GraphChanged: signal, BuildStateChanged: signal, BuildState: GraphBuildState.Ready } as unknown as ILanguageService
    }

    public static Manager(): SolutionManagerService
    {
        const solution = { Name: AuthoringFixture.ActiveName, Members: { ToArray: () => [] } }
        return { ActiveSolution: solution } as unknown as SolutionManagerService
    }

    public static Attach(manager: SolutionManagerService, role: Role = Role.Owner, purpose: EnvironmentPurpose = EnvironmentPurpose.Development, graphs?: IDevGraphService): { handler: ServerConnectionHandler; client: MessageConnection }
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, AuthoringFixture.Language(), manager, AuthoringFixture.Context(role), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, purpose, undefined, undefined, undefined, undefined, undefined, graphs)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        return { handler, client }
    }
}

test('AuthoringTarget defaults to the fallback id and an explicit Select overrides it', () =>
{
    const target = new AuthoringTarget(() => AuthoringFixture.ActiveName)
    assert.equal(target.SolutionId, AuthoringFixture.ActiveName)
    target.Select(AuthoringFixture.OtherA)
    assert.equal(target.SolutionId, AuthoringFixture.OtherA)
})

test('selectAuthoring on one connection leaves the other connection and the global ActiveSolution untouched', async () =>
{
    const manager = AuthoringFixture.Manager()
    const globalBefore = manager.ActiveSolution
    const a = AuthoringFixture.Attach(manager)
    const b = AuthoringFixture.Attach(manager)
    try
    {
        assert.equal(b.handler.Authoring.SolutionId, AuthoringFixture.ActiveName)
        await a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA })
        assert.equal(a.handler.Authoring.SolutionId, AuthoringFixture.OtherA)
        assert.equal(b.handler.Authoring.SolutionId, AuthoringFixture.ActiveName)
        await b.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherB })
        assert.equal(a.handler.Authoring.SolutionId, AuthoringFixture.OtherA)
        assert.equal(b.handler.Authoring.SolutionId, AuthoringFixture.OtherB)
        assert.equal(manager.ActiveSolution, globalBefore)
    }
    finally
    {
        a.client.dispose()
        b.client.dispose()
        a.handler.Dispose()
        b.handler.Dispose()
    }
})

test('solution/list returns the current solution', async () =>
{
    const manager = AuthoringFixture.Manager()
    const a = AuthoringFixture.Attach(manager)
    try
    {
        const list = await a.client.sendRequest(SolutionProtocol.ListSolutions)
        assert.deepEqual(list, [{ Name: AuthoringFixture.ActiveName, Id: AuthoringFixture.ActiveName }])
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('solution/list is the union of the current solution and the graph service slice ids', async () =>
{
    const graphs = AuthoringFixture.Graphs([AuthoringFixture.OtherA, AuthoringFixture.ActiveName, AuthoringFixture.OtherB])
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager(), Role.Owner, EnvironmentPurpose.Development, graphs)
    try
    {
        const list = await a.client.sendRequest(SolutionProtocol.ListSolutions)
        assert.deepEqual(list.map(s => s.Id), [AuthoringFixture.ActiveName, AuthoringFixture.OtherA, AuthoringFixture.OtherB])
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('selectAuthoring for a non-current id reports no members and a neutral build state', async () =>
{
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager())
    try
    {
        const summary = await a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA })
        assert.equal(summary.name, AuthoringFixture.OtherA)
        assert.deepEqual(summary.members, [])
        assert.equal(summary.buildState, BuildState.Building)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('a Viewer may list solutions but is denied selectAuthoring (Read vs Write)', async () =>
{
    const manager = AuthoringFixture.Manager()
    const a = AuthoringFixture.Attach(manager, Role.Viewer)
    try
    {
        const list = await a.client.sendRequest(SolutionProtocol.ListSolutions)
        assert.equal(list.length, 1)
        await assert.rejects(() => a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA }))
        assert.equal(a.handler.Authoring.SolutionId, AuthoringFixture.ActiveName)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('a Runtime environment does not register solution/list or solution/selectAuthoring', async () =>
{
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager(), Role.Owner, EnvironmentPurpose.Runtime)
    try
    {
        await assert.rejects(() => a.client.sendRequest(SolutionProtocol.ListSolutions), (e: { code?: number }) => e.code === ErrorCodes.MethodNotFound)
        await assert.rejects(() => a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA }), (e: { code?: number }) => e.code === ErrorCodes.MethodNotFound)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})
