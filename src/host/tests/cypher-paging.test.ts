import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes, CursorStaleError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherParamValue, CypherQueryPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { CypherLimits } from '../../config/cypher-limits.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'

/** One open sample solution plus a factory for client connections attached to its single language service. */
class CypherPagingWorld
{
    public readonly Language: SolutionLanguageService
    private readonly server: PragmaticServer
    private readonly manager: SolutionManagerService
    private readonly limits: CypherLimits | undefined
    private readonly connections: { client: PragmaticClient, handler: ServerConnectionHandler }[] = []

    public constructor(server: PragmaticServer, language: SolutionLanguageService, manager: SolutionManagerService, limits: CypherLimits | undefined)
    {
        this.server = server
        this.Language = language
        this.manager = manager
        this.limits = limits
    }

    /** The language service keys documents by the member storage root (forward-slashed), not the OS path. */
    public get ModelUri(): string
    {
        const member = [...this.manager.ActiveSolution!.Members][0]!
        return `${member.Storage!.Root}/${CypherPagingFixture.ModelFileName}`
    }

    public Connect(): PragmaticClient
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, this.Language, this.manager, CypherPagingFixture.Permissive(), () => Promise.reject(new Error(CypherPagingFixture.NoConnectors)), ctx => this.server.Graph(ctx), undefined, undefined, undefined, undefined, undefined, this.limits, TenantPurpose.Development)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.connections.push({ client, handler })
        return client
    }

    public async Dispose(): Promise<void>
    {
        for (const connection of this.connections)
        {
            await connection.client.DisposeAsync()
            connection.handler.Dispose()
        }
        await this.Language.WhenIdle()
        await this.manager.CloseSolution()
        await this.server.Dispose()
    }
}

class CypherPagingFixture
{
    private static readonly SolutionPrefix = 'cp-sol-'
    private static readonly PackagesPrefix = 'cp-pkgs-'
    private static readonly ModelFile = join('models', 'model.todl')
    public static readonly ModelFileName = 'model.todl'
    public static readonly NoConnectors = 'no connectors'
    public static readonly ModelTodl = 'namespace acme { concept Service { label : string?; } model Shop : acme { Service s1 { label = "e"; } Service s2 { label = "c"; } Service s3 { label = "a"; } Service s4 { label = "d"; } Service s5 { label = "b"; } } }'
    public static readonly EditedModelTodl = 'namespace acme { concept Service { label : string?; } model Shop : acme { Service s1 { label = "e"; } Service s2 { label = "c"; } Service s3 { label = "a"; } Service s4 { label = "d"; } Service s5 { label = "b"; } Service s6 { label = "f"; } } }'
    public static readonly OrderedLabels = 'MATCH (a:Service) RETURN a.label ORDER BY a.label'
    public static readonly UnorderedLabels = 'MATCH (a:Service) RETURN a.label'
    public static readonly UnwindQuery = 'UNWIND $xs AS x RETURN x'
    public static readonly PairQuery = 'UNWIND $xs AS x RETURN x, $tag AS t'

    public static Permissive(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static async With(body: (world: CypherPagingWorld) => Promise<void>, limits?: CypherLimits): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), CypherPagingFixture.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), CypherPagingFixture.PackagesPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, CypherPagingFixture.ModelFile), CypherPagingFixture.ModelTodl)
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        await server.OpenSolution(solution)
        const language = await server.LanguageService() as SolutionLanguageService
        const manager = await server.Manager()
        await language.WhenIdle()
        const world = new CypherPagingWorld(server, language, manager, limits)
        try
        {
            await body(world)
        }
        finally
        {
            await world.Dispose()
            rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
        }
    }

    /** Follows nextCursor from the first page to the last, returning every page fetched. */
    public static async Walk(client: PragmaticClient, cypher: string, pageSize: number, parameters?: { [name: string]: CypherParamValue }): Promise<CypherQueryPageDto[]>
    {
        const pages: CypherQueryPageDto[] = []
        let cursor: string | undefined
        do
        {
            const page = await client.CypherQuery(cypher, parameters, { cursor, pageSize })
            pages.push(page)
            cursor = page.nextCursor
        }
        while (cursor !== undefined)
        return pages
    }

    public static IsStale(error: { code?: number }): boolean
    {
        return error.code === CursorStaleError.Code
    }
}

test('walking all pages returns every row exactly once', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const client = world.Connect()
        const unpaged = await client.CypherQuery(CypherPagingFixture.OrderedLabels)
        const pages = await CypherPagingFixture.Walk(client, CypherPagingFixture.OrderedLabels, 2)
        const walked = pages.flatMap(p => p.items.map(r => r[0]))
        assert.equal(pages.length, 3)
        assert.deepEqual(walked, ['a', 'b', 'c', 'd', 'e'])
        assert.deepEqual(walked, unpaged.items.map(r => r[0]))
        assert.equal(new Set(walked).size, walked.length)
        assert.ok(pages.every(p => p.truncated === false))
        assert.deepEqual(pages[0]!.columns, ['a.label'])
    })
})

test('walking an unordered query uses the implicit first-column order', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const client = world.Connect()
        const pages = await CypherPagingFixture.Walk(client, CypherPagingFixture.UnorderedLabels, 2)
        assert.deepEqual(pages.flatMap(p => p.items.map(r => r[0])), ['a', 'b', 'c', 'd', 'e'])
    })
})

test('total divisible by pageSize has no trailing empty page', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const client = world.Connect()
        const pages = await CypherPagingFixture.Walk(client, CypherPagingFixture.UnwindQuery, 2, { xs: [1, 2, 3, 4] })
        assert.equal(pages.length, 2)
        assert.deepEqual(pages.map(p => p.items.length), [2, 2])
        assert.equal(pages[1]!.nextCursor, undefined)
    })
})

test('a graph edit between pages makes the next cursor stale (-32032)', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const client = world.Connect()
        const first = await client.CypherQuery(CypherPagingFixture.OrderedLabels, undefined, { pageSize: 2 })
        assert.ok(first.nextCursor !== undefined)
        const before = world.Language.GraphRevision
        client.DidChange(world.ModelUri, CypherPagingFixture.EditedModelTodl)
        // the notification is fire-and-forget: a round-trip request flushes it ahead of WhenIdle
        await client.CypherQuery(CypherPagingFixture.OrderedLabels, undefined, { pageSize: 1 })
        await world.Language.WhenIdle()
        assert.ok(world.Language.GraphRevision > before, 'the edit must move the graph revision')
        await assert.rejects(() => client.CypherQuery(CypherPagingFixture.OrderedLabels, undefined, { cursor: first.nextCursor, pageSize: 2 }), CypherPagingFixture.IsStale)
    })
})

test('a cursor reused with different cypher text is stale', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const client = world.Connect()
        const first = await client.CypherQuery(CypherPagingFixture.OrderedLabels, undefined, { pageSize: 2 })
        await assert.rejects(() => client.CypherQuery(CypherPagingFixture.UnorderedLabels, undefined, { cursor: first.nextCursor, pageSize: 2 }), CypherPagingFixture.IsStale)
    })
})

test('a cursor reused with different parameters is stale', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const client = world.Connect()
        const first = await client.CypherQuery(CypherPagingFixture.UnwindQuery, { xs: [1, 2, 3] }, { pageSize: 2 })
        await assert.rejects(() => client.CypherQuery(CypherPagingFixture.UnwindQuery, { xs: [1, 2, 4] }, { cursor: first.nextCursor, pageSize: 2 }), CypherPagingFixture.IsStale)
    })
})

test('a cursor stays valid when parameter keys are supplied in a different order', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const client = world.Connect()
        const first = await client.CypherQuery(CypherPagingFixture.PairQuery, { xs: [1, 2, 3], tag: 'k' }, { pageSize: 2 })
        const second = await client.CypherQuery(CypherPagingFixture.PairQuery, { tag: 'k', xs: [1, 2, 3] }, { cursor: first.nextCursor, pageSize: 2 })
        assert.deepEqual(second.items, [[3, 'k']])
        assert.equal(second.nextCursor, undefined)
    })
})

test('a cursor stays valid on a second connection when the graph is unchanged', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const first = await world.Connect().CypherQuery(CypherPagingFixture.OrderedLabels, undefined, { pageSize: 2 })
        const second = await world.Connect().CypherQuery(CypherPagingFixture.OrderedLabels, undefined, { cursor: first.nextCursor, pageSize: 2 })
        assert.deepEqual(second.items.map(r => r[0]), ['c', 'd'])
        assert.ok(second.nextCursor !== undefined)
    })
})

test('pageSize above RowCap is capped at RowCap', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const client = world.Connect()
        const first = await client.CypherQuery(CypherPagingFixture.OrderedLabels, undefined, { pageSize: 100 })
        assert.deepEqual(first.items.map(r => r[0]), ['a', 'b', 'c'])
        assert.equal(first.truncated, false)
        assert.ok(first.nextCursor !== undefined)
        const pages = await CypherPagingFixture.Walk(client, CypherPagingFixture.OrderedLabels, 100)
        assert.deepEqual(pages.flatMap(p => p.items.map(r => r[0])), ['a', 'b', 'c', 'd', 'e'])
    }, new CypherLimits(3))
})

test('pageSize 0 is InvalidParams', async () =>
{
    await CypherPagingFixture.With(async world =>
    {
        const client = world.Connect()
        await assert.rejects(() => client.CypherQuery(CypherPagingFixture.OrderedLabels, undefined, { pageSize: 0 }), (error: { code?: number }) => error.code === ErrorCodes.InvalidParams)
    })
})
