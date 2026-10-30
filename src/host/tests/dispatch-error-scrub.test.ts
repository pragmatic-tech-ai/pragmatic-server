import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'

class Fixtures
{
    public static readonly Secret = 'secret internal detail'

    public static OwnerContext(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** Drives Connectors() through the real dispatch path with a connector factory that rejects with the given error. */
    public static async Failure(thrown: unknown): Promise<{ code?: number, message?: string, data?: unknown, serialized: string }>
    {
        const packages = mkdtempSync(join(tmpdir(), 'ps-pkgs-'))
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, Fixtures.OwnerContext(), () => Promise.reject(thrown), () => Promise.reject(new Error('no graph')))
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            let captured: unknown
            try
            {
                await client.Connectors()
            }
            catch (error)
            {
                captured = error
            }
            assert.ok(captured !== undefined, 'expected the request to reject')
            const failure = captured as { code?: number, message?: string, data?: unknown }
            return { code: failure.code, message: failure.message, data: failure.data, serialized: JSON.stringify(captured, Object.getOwnPropertyNames(captured as object)) }
        }
        finally
        {
            await client.DisposeAsync()
            handler.Dispose()
            await (languageService as SolutionLanguageService).WhenIdle()
            await manager.CloseSolution()
            await server.Dispose()
        }
    }
}

test('a raw thrown Error is scrubbed to a generic InternalError and never leaks its message', async () =>
{
    const failure = await Fixtures.Failure(new Error(Fixtures.Secret))
    assert.equal(failure.code, ErrorCodes.InternalError)
    assert.ok(!(failure.message ?? '').includes(Fixtures.Secret))
    assert.ok(!failure.serialized.includes(Fixtures.Secret))
})

test('a ResponseError(InvalidParams) reaches the client unchanged', async () =>
{
    const failure = await Fixtures.Failure(new ResponseError(ErrorCodes.InvalidParams, 'bad field X'))
    assert.equal(failure.code, ErrorCodes.InvalidParams)
    assert.ok((failure.message ?? '').includes('bad field X'))
})

test('a ResponseError with a non-standard code passes through with its data', async () =>
{
    const failure = await Fixtures.Failure(new ResponseError(ServerConnectionHandler.RateLimitedCode, 'slow down', { retryAfterMs: 5 }))
    assert.equal(failure.code, ServerConnectionHandler.RateLimitedCode)
    assert.ok((failure.message ?? '').includes('slow down'))
    assert.deepEqual(failure.data, { retryAfterMs: 5 })
})
