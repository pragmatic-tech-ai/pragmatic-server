import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { RateLimitGuard } from '../rate-limit-guard.js'
import { TokenBucketRateLimiter } from '../rate-limiter.js'
import { AuditSurface, AuditOutcome } from '../access-audit.js'
import type { IAccessAuditSink, AccessAuditEvent } from '../access-audit.js'

class CapturingSink implements IAccessAuditSink
{
    public readonly Events: AccessAuditEvent[] = []

    public Record(event: AccessAuditEvent): Promise<void>
    {
        this.Events.push(event)
        return Promise.resolve()
    }
}

class Fixtures
{
    public static OwnerContext(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), 'ps-sch-rl-'))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), dir, { recursive: true })
        return dir
    }
}

test('a per-principal breach rejects the RPC and audits a RateLimited Rpc event', async () =>
{
    const sink = new CapturingSink()
    const guard = new RateLimitGuard(new TokenBucketRateLimiter({ perPrincipal: { Rps: 0.001, Burst: 1 } }), sink)
    const packages = mkdtempSync(join(tmpdir(), 'ps-pkgs-'))
    const solution = Fixtures.SolutionDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    const languageService = await server.LanguageService()
    const manager = await server.Manager()
    const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
    const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, Fixtures.OwnerContext(), () => Promise.reject(new Error('no connectors')), undefined, undefined, sink, guard)
    const client = PragmaticClient.CreateOverSocket(clientSocket)
    try
    {
        await client.OpenSolution(solution)
        await assert.rejects(() => client.ActiveSolution())
        await new Promise(resolve => setImmediate(resolve))
        const limited = sink.Events.filter(e => e.Outcome === AuditOutcome.RateLimited)
        assert.equal(limited.length, 1)
        assert.equal(limited[0]!.Surface, AuditSurface.Rpc)
        assert.equal(limited[0]!.PrincipalId, 'p1')
    }
    finally
    {
        await client.DisposeAsync()
        handler.Dispose()
        await (languageService as SolutionLanguageService).WhenIdle()
        await manager.CloseSolution()
        await server.Dispose()
        rmSync(solution, { recursive: true, force: true })
        rmSync(packages, { recursive: true, force: true })
    }
})
