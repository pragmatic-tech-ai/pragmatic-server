import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'

class ContextFixture
{
    public static Permissive(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }
}

class HandlerFixture
{
    private static readonly SolutionPrefix = 'ps-sol-'
    private static readonly PackagesPrefix = 'ps-pkgs-'

    public static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), HandlerFixture.SolutionPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), dir, { recursive: true })
        return dir
    }

    public static PackagesDir(): string
    {
        return mkdtempSync(join(tmpdir(), HandlerFixture.PackagesPrefix))
    }

    public static Cleanup(dir: string): void
    {
        rmSync(dir, { recursive: true, force: true })
    }
}

test('a client opens a solution and reads diagnostics over the handler', async () =>
{
    const packages = HandlerFixture.PackagesDir()
    const solution = HandlerFixture.SolutionDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    const languageService = await server.LanguageService()
    const manager = await server.Manager()
    const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
    const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, ContextFixture.Permissive(), () => Promise.reject(new Error('no connectors in this test')))
    const client = PragmaticClient.CreateOverSocket(clientSocket)
    try
    {
        const summary = await client.OpenSolution(solution)
        assert.equal(summary.members.length, 1)
        const diagnostics = await client.DiagnosticsFor(join(solution, 'models', 'model.todl'))
        assert.ok(Array.isArray(diagnostics))
    }
    finally
    {
        await client.DisposeAsync()
        handler.Dispose()
        await (languageService as SolutionLanguageService).WhenIdle()
        await manager.CloseSolution()
        await server.Dispose()
        HandlerFixture.Cleanup(solution)
        HandlerFixture.Cleanup(packages)
    }
})

test('disposing the handler stops graph-change pushes', async () =>
{
    const packages = HandlerFixture.PackagesDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    const languageService = await server.LanguageService()
    const manager = await server.Manager()
    const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
    const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, ContextFixture.Permissive(), () => Promise.reject(new Error('no connectors in this test')))
    const client = PragmaticClient.CreateOverSocket(clientSocket)
    let pushes = 0
    client.OnGraphChanged(() => { pushes += 1 })
    handler.Dispose()
    languageService.GraphChanged.emit({ memberIds: ['m'], fileIds: ['f'] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(pushes, 0)
    await client.DisposeAsync()
    await server.Dispose()
    HandlerFixture.Cleanup(packages)
})

test('an unknown method rejects', async () =>
{
    const packages = HandlerFixture.PackagesDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    const languageService = await server.LanguageService()
    const manager = await server.Manager()
    const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
    const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, ContextFixture.Permissive(), () => Promise.reject(new Error('no connectors in this test')))
    const connection = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
    connection.listen()
    try
    {
        await assert.rejects(connection.sendRequest('does/not/exist'))
    }
    finally
    {
        connection.dispose()
        handler.Dispose()
        await server.Dispose()
        HandlerFixture.Cleanup(packages)
    }
})
