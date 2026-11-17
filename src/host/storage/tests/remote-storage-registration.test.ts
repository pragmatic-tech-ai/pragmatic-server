import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, StorageProtocol, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { GraphBuildState } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { EnvironmentPurpose } from '../../../environments/environment-purpose.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'

class RegistrationFixture
{
    private static readonly EnvironmentId = 't1'
    private static readonly PrincipalId = 'p1'
    private static readonly EnvironmentName = 'Environment One'

    public static Context(role: Role): AccessContext
    {
        const realm = new Realm(RegistrationFixture.EnvironmentId, RealmKind.SelfHosted, RegistrationFixture.EnvironmentName)
        const principal = new Principal(RegistrationFixture.PrincipalId, RegistrationFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(RegistrationFixture.PrincipalId, role, new ResourceRef(ResourceKind.Realm, RegistrationFixture.EnvironmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    public static Language(): ILanguageService
    {
        const signal = { subscribe: () => ({ dispose: () => undefined }) }
        return { GraphChanged: signal, BuildStateChanged: signal, BuildState: GraphBuildState.Ready, DidChange: () => undefined } as unknown as ILanguageService
    }

    public static Manager(): SolutionManagerService
    {
        return { ActiveSolution: { Name: 'sol', Storage: new FakeStorage(), Members: { ToArray: () => [] } } } as unknown as SolutionManagerService
    }

    public static Attach(purpose: EnvironmentPurpose, role: Role = Role.Owner): { handler: ServerConnectionHandler; client: MessageConnection }
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, RegistrationFixture.Language(), RegistrationFixture.Manager(), RegistrationFixture.Context(role), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, purpose)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        return { handler, client }
    }
}

test('a Development environment serves storage/* over the wire', async () =>
{
    const a = RegistrationFixture.Attach(EnvironmentPurpose.Development)
    try
    {
        await a.client.sendRequest(StorageProtocol.WriteText, { Path: 'a/x.todl', Content: 'hi' })
        assert.deepEqual(await a.client.sendRequest(StorageProtocol.ReadText, { Path: 'a/x.todl' }), { Content: 'hi' })
        assert.deepEqual(await a.client.sendRequest(StorageProtocol.List, { Path: 'a' }), [{ Name: 'x.todl', IsDirectory: false }])
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('a Runtime environment does not register storage/*', async () =>
{
    const a = RegistrationFixture.Attach(EnvironmentPurpose.Runtime)
    try
    {
        await assert.rejects(() => a.client.sendRequest(StorageProtocol.ReadText, { Path: 'a' }), (e: { code?: number }) => e.code === ErrorCodes.MethodNotFound)
        await assert.rejects(() => a.client.sendRequest(StorageProtocol.Delete, { Path: 'a' }), (e: { code?: number }) => e.code === ErrorCodes.MethodNotFound)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('a save on one connection pushes storage/changed to a second connection and drives one DidChange', async () =>
{
    const calls: string[] = []
    const signal = { subscribe: () => ({ dispose: () => undefined }) }
    const language = { GraphChanged: signal, BuildStateChanged: signal, BuildState: GraphBuildState.Ready, DidChange: (uri: string) => { calls.push(uri) } } as unknown as ILanguageService
    const manager = RegistrationFixture.Manager()
    const attach = (): { handler: ServerConnectionHandler; client: MessageConnection } =>
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, language, manager, RegistrationFixture.Context(Role.Owner), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, EnvironmentPurpose.Development)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        return { handler, client }
    }
    const a = attach()
    const b = attach()
    try
    {
        const received = new Promise<unknown>(resolve => b.client.onNotification(StorageProtocol.Changed, resolve))
        await a.client.sendRequest(StorageProtocol.WriteText, { Path: 'a/x.todl', Content: 'hi' })
        assert.deepEqual(await received, { Kind: 'added', Path: 'a/x.todl', IsDirectory: false })
        assert.equal(calls.length, 1)
    }
    finally
    {
        a.client.dispose()
        b.client.dispose()
        a.handler.Dispose()
        b.handler.Dispose()
    }
})
