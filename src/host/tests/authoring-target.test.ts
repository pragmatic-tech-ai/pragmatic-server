import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, SolutionProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { GraphBuildState } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
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

    public static Attach(manager: SolutionManagerService, role: Role = Role.Owner): { handler: ServerConnectionHandler; client: MessageConnection }
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, AuthoringFixture.Language(), manager, AuthoringFixture.Context(role), undefined, undefined)
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
        assert.equal(b.handler.AuthoringTarget.SolutionId, AuthoringFixture.ActiveName)
        await a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA })
        assert.equal(a.handler.AuthoringTarget.SolutionId, AuthoringFixture.OtherA)
        assert.equal(b.handler.AuthoringTarget.SolutionId, AuthoringFixture.ActiveName)
        await b.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherB })
        assert.equal(a.handler.AuthoringTarget.SolutionId, AuthoringFixture.OtherA)
        assert.equal(b.handler.AuthoringTarget.SolutionId, AuthoringFixture.OtherB)
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
