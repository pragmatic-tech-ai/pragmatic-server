import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, SolutionProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/pragmatic-identity'
import { GraphBuildState } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'

class PromptSafetyFixture
{
    public static readonly TempPrefix = 'solution-create-prompt-'
    public static readonly Name = 'alpha'
    public static readonly EnvironmentId = 't1'
    public static readonly PrincipalId = 'p1'
    public static readonly Display = 'Environment One'
    public static readonly TimeoutMs = 10000
    public static readonly TimeoutMessage = 'solution/create hung on a prompt'

    public static Context(): AccessContext
    {
        const realm = new Realm(PromptSafetyFixture.EnvironmentId, RealmKind.SelfHosted, PromptSafetyFixture.Display)
        const principal = new Principal(PromptSafetyFixture.PrincipalId, PromptSafetyFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(PromptSafetyFixture.PrincipalId, Role.Developer, new ResourceRef(ResourceKind.Realm, PromptSafetyFixture.EnvironmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    public static Language(): ILanguageService
    {
        const signal = { subscribe: () => ({ dispose: () => undefined }) }
        return { GraphChanged: signal, BuildStateChanged: signal, BuildState: GraphBuildState.Ready, DidChange: () => undefined } as unknown as ILanguageService
    }

    public static Deadline<T>(work: Promise<T>): Promise<T>
    {
        return Promise.race([work, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(PromptSafetyFixture.TimeoutMessage)), PromptSafetyFixture.TimeoutMs).unref())])
    }
}

test('solution/create over the real manager + the server prompt service switches active even when the active solution is dirty', async () =>
{
    const base = await mkdtemp(join(tmpdir(), PromptSafetyFixture.TempPrefix))
    const server = new PragmaticServer({ purpose: EnvironmentPurpose.Development, packagesRoot: join(base, 'packages'), graphsRoot: join(base, 'graphs'), applicationsRoot: join(base, 'applications'), solutionsRoot: join(base, 'solutions') })
    try
    {
        await server.Start()
        const manager = await server.Manager()
        await manager.NewUntitledSolution()
        manager.ActiveSolution!.IsDirty = true
        const roots = await server.DevSolutionRoots()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, PromptSafetyFixture.Language(), manager, PromptSafetyFixture.Context(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, EnvironmentPurpose.Development, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, roots)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        try
        {
            const result = await PromptSafetyFixture.Deadline(client.sendRequest(SolutionProtocol.CreateSolution, { Name: PromptSafetyFixture.Name }))
            assert.deepEqual(result, { Name: PromptSafetyFixture.Name, Created: true })
            assert.equal(manager.ActiveSolution?.Name, PromptSafetyFixture.Name)
            assert.equal(handler.Authoring.Selected, PromptSafetyFixture.Name)
        }
        finally
        {
            client.dispose()
            handler.Dispose()
        }
    }
    finally
    {
        await server.Dispose()
        await rm(base, { recursive: true, force: true })
    }
})
