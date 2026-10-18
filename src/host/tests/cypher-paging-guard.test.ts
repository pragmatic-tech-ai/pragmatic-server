import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'

class PagingGuardFixture
{
    public static readonly GuardMessage = 'paging cannot be combined with an explicit SKIP or LIMIT'
    public static readonly TrailingLimit = 'MATCH (a:Service) RETURN a.label ORDER BY a.label LIMIT 2'
    public static readonly TrailingSkip = 'MATCH (a:Service) RETURN a.label ORDER BY a.label SKIP 1'
    public static readonly Plain = 'MATCH (a:Service) RETURN a.label ORDER BY a.label'
    public static readonly InteriorWithLimit = 'MATCH (a:Service) WITH a ORDER BY a.label LIMIT 3 RETURN a.label ORDER BY a.label'
    public static readonly Malformed = 'MATCH (a:Service RETURN'
    private static readonly SolutionPrefix = 'cpg-sol-'
    private static readonly PackagesPrefix = 'cpg-pkgs-'
    private static readonly ModelFile = join('models', 'model.todl')
    private static readonly NoConnectors = 'no connectors'
    private static readonly ModelTodl = 'namespace acme { concept Service { label : string?; } model Shop : acme { Service s1 { label = "e"; } Service s2 { label = "c"; } Service s3 { label = "a"; } Service s4 { label = "d"; } Service s5 { label = "b"; } } }'

    public static IsInvalidParams(error: { code?: number, message?: string }): boolean
    {
        return error.code === ErrorCodes.InvalidParams
    }

    public static IsGuard(error: { code?: number, message?: string }): boolean
    {
        return error.code === ErrorCodes.InvalidParams && (error.message ?? '').includes(PagingGuardFixture.GuardMessage)
    }

    public static async With(body: (client: PragmaticClient) => Promise<void>): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), PagingGuardFixture.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), PagingGuardFixture.PackagesPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, PagingGuardFixture.ModelFile), PagingGuardFixture.ModelTodl)
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        await server.OpenSolution(solution)
        const language = await server.LanguageService() as SolutionLanguageService
        const manager = await server.Manager()
        await language.WhenIdle()
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const context = new AccessContext(principal, tenant, [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))], new ResourceAuthorizationPolicy())
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, language, manager, context, () => Promise.reject(new Error(PagingGuardFixture.NoConnectors)), ctx => server.Graph(ctx), undefined, undefined, undefined, undefined, undefined, undefined, TenantPurpose.Development)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            await body(client)
        }
        finally
        {
            await client.DisposeAsync()
            handler.Dispose()
            await language.WhenIdle()
            await manager.CloseSolution()
            await server.Dispose()
            rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
        }
    }
}

test('a paged request on a query with a trailing LIMIT is InvalidParams', async () =>
{
    await PagingGuardFixture.With(async client =>
    {
        await assert.rejects(() => client.CypherQuery(PagingGuardFixture.TrailingLimit, undefined, { pageSize: 1 }), PagingGuardFixture.IsGuard)
    })
})

test('a paged request on a query with a trailing SKIP is InvalidParams', async () =>
{
    await PagingGuardFixture.With(async client =>
    {
        await assert.rejects(() => client.CypherQuery(PagingGuardFixture.TrailingSkip, undefined, { pageSize: 1 }), PagingGuardFixture.IsGuard)
    })
})

test('a non-paged request with explicit LIMIT runs normally', async () =>
{
    await PagingGuardFixture.With(async client =>
    {
        const result = await client.CypherQuery(PagingGuardFixture.TrailingLimit)
        assert.deepEqual(result.items.map(r => r[0]), ['a', 'b'])
    })
})

test('a paged request with no explicit SKIP/LIMIT runs normally', async () =>
{
    await PagingGuardFixture.With(async client =>
    {
        const result = await client.CypherQuery(PagingGuardFixture.Plain, undefined, { pageSize: 2 })
        assert.deepEqual(result.items.map(r => r[0]), ['a', 'b'])
        assert.ok(result.nextCursor !== undefined)
    })
})

test('a paged malformed query is still InvalidParams', async () =>
{
    await PagingGuardFixture.With(async client =>
    {
        await assert.rejects(() => client.CypherQuery(PagingGuardFixture.Malformed, undefined, { pageSize: 1 }), PagingGuardFixture.IsInvalidParams)
    })
})

test('a paged request with an interior WITH ... LIMIT and a clean final RETURN is not refused', async () =>
{
    await PagingGuardFixture.With(async client =>
    {
        const result = await client.CypherQuery(PagingGuardFixture.InteriorWithLimit, undefined, { pageSize: 2 })
        assert.deepEqual(result.items.map(r => r[0]), ['a', 'b'])
        assert.ok(result.nextCursor !== undefined)
    })
})
