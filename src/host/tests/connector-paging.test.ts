import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import { InMemoryMessageSocket, PragmaticClient, CursorStaleError, ConnectorProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { EntityDto, Page } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { PagingLimits } from '../../config/paging-limits.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'

/** Drives paged connector/read over the in-memory transport against a pg-mem table of N customers. */
class ConnectorPagingFixture
{
    private static readonly DirPrefix = 'c7-'
    private static readonly SolutionFile = 'Sample.pksln'
    private static readonly ModelsDir = 'models'
    private static readonly ProjectFile = 'project.plexus'
    private static readonly ModelFile = 'model.todl'
    private static readonly PackagesDir = 'packages'
    public static readonly ConceptId = 'shop.Customer'
    private static readonly CreateTable = 'CREATE TABLE "Customer" (customer_id text PRIMARY KEY, name text, description text, label text)'
    private static readonly ModelTodl = `
namespace shop {
  concept Customer { name : string; }
  datasource pg { kind = sql; database = "app"; }
  model Shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { name = "name"; }
  }
}
`

    public static IsStale(error: { code?: number }): boolean
    {
        return error.code === CursorStaleError.Code
    }

    private static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), ConnectorPagingFixture.DirPrefix))
        writeFileSync(join(dir, ConnectorPagingFixture.SolutionFile), JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: ConnectorPagingFixture.ModelsDir, type: 'meta-model' }], settings: {}, bags: {} }))
        mkdirSync(join(dir, ConnectorPagingFixture.ModelsDir), { recursive: true })
        writeFileSync(join(dir, ConnectorPagingFixture.ModelsDir, ConnectorPagingFixture.ProjectFile), JSON.stringify({ type: 'meta-model', name: 'Shop Model', id: 'shop-model', packageVersion: '0.1.0' }))
        writeFileSync(join(dir, ConnectorPagingFixture.ModelsDir, ConnectorPagingFixture.ModelFile), ConnectorPagingFixture.ModelTodl)
        return dir
    }

    private static Pool(count: number): unknown
    {
        const db = newDb()
        db.public.none(ConnectorPagingFixture.CreateTable)
        for (let i = 0; i < count; i++)
        {
            db.public.none(`INSERT INTO "Customer" (customer_id, name) VALUES ('C${i}', 'n${i}')`)
        }
        return new (db.adapters.createPg()).Pool()
    }

    private static OwnerContext(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('u1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('u1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static async With(count: number, body: (client: PragmaticClient, modelId: string) => Promise<void>, paging?: PagingLimits): Promise<void>
    {
        const dir = ConnectorPagingFixture.SolutionDir()
        const pool = ConnectorPagingFixture.Pool(count)
        const server = new PragmaticServer({ packagesRoot: join(dir, ConnectorPagingFixture.PackagesDir), connectors: { buildPool: () => pool as never } })
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        let handler: ServerConnectionHandler | undefined
        let client: PragmaticClient | undefined
        try
        {
            await server.Start()
            await server.OpenSolution(dir)
            const languageService = await server.LanguageService()
            const manager = await server.Manager()
            handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, ConnectorPagingFixture.OwnerContext(), () => server.Connectors(), ctx => server.Graph(ctx), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, paging)
            client = PragmaticClient.CreateOverSocket(clientSocket)
            const models = await client.Connectors()
            await body(client, models[0]!.modelId)
        }
        finally
        {
            try { await client?.DisposeAsync() } catch { /* keep cleaning up */ }
            try { handler?.Dispose() } catch { /* keep cleaning up */ }
            try { await server.Dispose() } catch { /* keep cleaning up */ }
            rmSync(dir, { recursive: true, force: true })
        }
    }

    /** connector/readPage via the client's request channel (the client exposes no typed wrapper yet). */
    public static ReadPage(client: PragmaticClient, modelId: string, cursor: string | undefined, pageSize: number): Promise<Page<EntityDto>>
    {
        return client['Request'](ConnectorProtocol.ReadPage, { modelId, concept: ConnectorPagingFixture.ConceptId, cursor, pageSize })
    }

    /** Follows nextCursor from the first page to the last, returning every page fetched. */
    public static async Walk(client: PragmaticClient, modelId: string, pageSize: number): Promise<EntityDto[][]>
    {
        const pages: EntityDto[][] = []
        let cursor: string | undefined
        do
        {
            const page = await client.ReadEntities(modelId, ConnectorPagingFixture.ConceptId, { cursor, pageSize })
            pages.push(page.items)
            cursor = page.nextCursor
        }
        while (cursor !== undefined)
        return pages
    }
}

test('walks every entity once', async () =>
{
    await ConnectorPagingFixture.With(5, async (client, modelId) =>
    {
        const pages = await ConnectorPagingFixture.Walk(client, modelId, 2)
        assert.deepEqual(pages.map(p => p.length), [2, 2, 1])
        const ids = pages.flat().map(e => e.id)
        assert.equal(new Set(ids).size, 5)
        assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    })
})

test('exact multiple has no trailing page', async () =>
{
    await ConnectorPagingFixture.With(4, async (client, modelId) =>
    {
        const pages = await ConnectorPagingFixture.Walk(client, modelId, 2)
        assert.deepEqual(pages.map(p => p.length), [2, 2])
        const whole = await client.ReadEntities(modelId, ConnectorPagingFixture.ConceptId, { pageSize: 4 })
        assert.equal(whole.items.length, 4)
        assert.equal(whole.nextCursor, undefined)
    })
})

test('cursor is stale after writeBack', async () =>
{
    await ConnectorPagingFixture.With(5, async (client, modelId) =>
    {
        const first = await client.ReadEntities(modelId, ConnectorPagingFixture.ConceptId, { pageSize: 2 })
        assert.ok(first.nextCursor !== undefined)
        await client.WriteBack(modelId, [first.items[0]!.id], [])
        await assert.rejects(() => client.ReadEntities(modelId, ConnectorPagingFixture.ConceptId, { cursor: first.nextCursor, pageSize: 2 }), ConnectorPagingFixture.IsStale)
    })
})

test('cursor is stale after connector/refresh', async () =>
{
    await ConnectorPagingFixture.With(5, async (client, modelId) =>
    {
        const first = await client.ReadEntities(modelId, ConnectorPagingFixture.ConceptId, { pageSize: 2 })
        assert.ok(first.nextCursor !== undefined)
        await client.RefreshConnectors()
        await assert.rejects(() => client.ReadEntities(modelId, ConnectorPagingFixture.ConceptId, { cursor: first.nextCursor, pageSize: 2 }), ConnectorPagingFixture.IsStale)
    })
})

test('cursor is stale after connector/refreshModel', async () =>
{
    await ConnectorPagingFixture.With(5, async (client, modelId) =>
    {
        const first = await client.ReadEntities(modelId, ConnectorPagingFixture.ConceptId, { pageSize: 2 })
        assert.ok(first.nextCursor !== undefined)
        const outcome = await client['Request'](ConnectorProtocol.RefreshModel, { modelId })
        assert.deepEqual(outcome.diagnostics, [])
        await assert.rejects(() => client.ReadEntities(modelId, ConnectorPagingFixture.ConceptId, { cursor: first.nextCursor, pageSize: 2 }), ConnectorPagingFixture.IsStale)
    })
})

test('pageSize above max is clamped', async () =>
{
    await ConnectorPagingFixture.With(5, async (client, modelId) =>
    {
        const page = await client.ReadEntities(modelId, ConnectorPagingFixture.ConceptId, { pageSize: 100 })
        assert.equal(page.items.length, 3)
        assert.ok(page.nextCursor !== undefined)
    }, new PagingLimits(2, 3))
})

test('connector/readPage tiles a SQL binding through the real reconnecting catalog', async () =>
{
    await ConnectorPagingFixture.With(5, async (client, modelId) =>
    {
        const ids: string[] = []
        const sizes: number[] = []
        let cursor: string | undefined
        do
        {
            const page = await ConnectorPagingFixture.ReadPage(client, modelId, cursor, 2)
            ids.push(...page.items.map((e: EntityDto) => e.id))
            sizes.push(page.items.length)
            cursor = page.nextCursor
        }
        while (cursor !== undefined)
        assert.deepEqual(sizes, [2, 2, 1])
        assert.equal(new Set(ids).size, 5)
        assert.deepEqual(ids, [...ids].sort())
    })
})
