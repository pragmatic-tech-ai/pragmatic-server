import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'

interface IDisposeCounter
{
    Count: number
}

class Harness
{
    public readonly Handler: ServerConnectionHandler
    public readonly Client: PragmaticClient
    public readonly Disposes: IDisposeCounter = { Count: 0 }
    private readonly server: PragmaticServer
    private readonly service: SolutionLanguageService

    private constructor(server: PragmaticServer, service: SolutionLanguageService, handler: ServerConnectionHandler, client: PragmaticClient)
    {
        this.server = server
        this.service = service
        this.Handler = handler
        this.Client = client
        const connection = (handler as unknown as { connection: { dispose: () => void } }).connection
        const original = connection.dispose.bind(connection)
        connection.dispose = () =>
        {
            this.Disposes.Count++
            original()
        }
    }

    public static async Create(): Promise<Harness>
    {
        const server = new PragmaticServer({ packagesRoot: mkdtempSync(join(tmpdir(), 'ps-pkgs-revoke-')) })
        await server.Start()
        const service = (await server.LanguageService()) as SolutionLanguageService
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        const context = new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
        const handler = ServerConnectionHandler.Attach(serverSocket, service, manager, context, () => Promise.reject(new Error('no connectors')), () => Promise.reject(new Error('no graph')))
        return new Harness(server, service, handler, PragmaticClient.CreateOverSocket(clientSocket))
    }

    /** Drives the handler's private dispatch gate directly (the connection is closed after Revoke). */
    public Dispatch(): unknown
    {
        return (this.Handler as unknown as { Dispatch: (method: string, operation: () => unknown) => unknown }).Dispatch('test/method', () => 1)
    }

    public async Close(): Promise<void>
    {
        await this.Client.DisposeAsync()
        this.Handler.Dispose()
        await this.service.WhenIdle()
        await (await this.server.Manager()).CloseSolution()
        await this.server.Dispose()
    }
}

test('after Revoke a dispatched request is rejected with the revoked code', async () =>
{
    const harness = await Harness.Create()
    try
    {
        harness.Handler.Revoke()
        assert.throws(() => harness.Dispatch(), (error: unknown) =>
        {
            assert.ok(error instanceof ResponseError)
            assert.equal(error.code, ServerConnectionHandler.RevokedCode)
            assert.equal(error.code, -32031)
            return true
        })
    }
    finally
    {
        await harness.Close()
    }
})

test('Dispose twice disposes the connection exactly once', async () =>
{
    const harness = await Harness.Create()
    try
    {
        harness.Handler.Dispose()
        harness.Handler.Dispose()
        assert.equal(harness.Disposes.Count, 1)
    }
    finally
    {
        await harness.Close()
    }
})

test('Revoke disposes the connection exactly once', async () =>
{
    const harness = await Harness.Create()
    try
    {
        harness.Handler.Revoke()
        assert.equal(harness.Disposes.Count, 1)
    }
    finally
    {
        await harness.Close()
    }
})
