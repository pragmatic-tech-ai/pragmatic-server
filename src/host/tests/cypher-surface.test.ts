import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'

class CypherSurfaceFixture
{
    private static readonly SolutionPrefix = 'cs-sol-'
    private static readonly PackagesPrefix = 'cs-pkgs-'
    private static readonly ModelFile = join('models', 'model.todl')
    private static readonly ModelTodl = 'namespace acme { concept Service { label : string?; } model Shop : acme { Service s1 { label = "alpha"; } Service s2 { label = "beta"; } } }'
    private static readonly NoConnectors = 'no connectors'
    public static readonly NameQuery = 'MATCH (a) RETURN a.label'
    public static readonly ParamQuery = 'MATCH (a) WHERE a.label = $n RETURN a.label'
    public static readonly NodeQuery = 'MATCH (a) RETURN a'
    public static readonly BadQuery = 'MATCH (a RETURN'

    public static Permissive(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static async With(body: (client: PragmaticClient) => Promise<void>): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), CypherSurfaceFixture.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), CypherSurfaceFixture.PackagesPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, CypherSurfaceFixture.ModelFile), CypherSurfaceFixture.ModelTodl)
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        await server.OpenSolution(solution)
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, CypherSurfaceFixture.Permissive(), () => Promise.reject(new Error(CypherSurfaceFixture.NoConnectors)), ctx => server.Graph(ctx))
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            await body(client)
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
    }
}

test('cypher/query returns columns and rows over the wire', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.NameQuery)
        assert.deepEqual(result.columns, ['a.label'])
        assert.deepEqual(result.rows.map(r => r[0]).sort(), ['alpha', 'beta'])
        assert.equal(result.truncated, false)
    })
})

test('cypher/query binds $param values', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.ParamQuery, { n: 'beta' })
        assert.deepEqual(result.rows, [['beta']])
    })
})

test('cypher/query returns node cells as plain JSON', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.NodeQuery)
        const node = result.rows.map(r => r[0]).find(c => (c as { label: string }).label === 'alpha') as { concept: string, fields: Record<string, { value: unknown }> }
        assert.ok(node.concept.endsWith('Service'))
        assert.equal(node.fields.label!.value, 'alpha')
        assert.equal(node.fields.description!.value, null)
    })
})

test('cypher/query rejects a syntax error with InvalidParams', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        await assert.rejects(() => client.CypherQuery(CypherSurfaceFixture.BadQuery), (error: { code?: number }) => error.code === ErrorCodes.InvalidParams)
    })
})

test('cypher/query rejects an empty query with InvalidParams', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        await assert.rejects(() => client.CypherQuery(''), (error: { code?: number }) => error.code === ErrorCodes.InvalidParams)
    })
})
