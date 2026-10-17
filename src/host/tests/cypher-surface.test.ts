import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
// SnapshotReader is not re-exported from the todl package root or an exports subpath; reach the built module directly.
import { SnapshotReader } from '../../../node_modules/@pragmatic-tech-ai/todl/dist/reflection-client/index.js'
import { CypherLimits } from '../../config/cypher-limits.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'

interface CypherFixtureOptions
{
    modelTodl?: string
    secondMember?: boolean
    openSolution?: boolean
    context?: AccessContext
    limits?: CypherLimits
}

class CypherSurfaceFixture
{
    private static readonly SecondMemberDir = 'models2'
    private static readonly SecondModelFile = join('models2', 'model.todl')
    private static readonly SecondProjectFile = join('models2', 'project.plexus')
    private static readonly SecondProject = '{ "type": "meta-model", "name": "Second Model", "id": "second-model", "packageVersion": "0.1.0" }'
    private static readonly SolutionFile = 'Sample.pksln'
    private static readonly SecondMemberEntry = '{ "path": "models2", "type": "meta-model" }'
    private static readonly FirstMemberEntry = '{ "path": "models", "type": "meta-model" }'
    public static readonly SecondModelTodl = 'namespace acme { model Extra : acme { Service s3 { label = "gamma"; } } }'
    public static readonly RegionModelTodl = 'namespace acme { concept Account { region : string?; label : string?; } policy Account { allow read when entity.region == "eu"; } model Bank : acme { Account a1 { region = "eu"; label = "visible"; } Account a2 { region = "us"; label = "hidden"; } } }'
    public static readonly LabelQuery = 'MATCH (a:Service) RETURN a.label'
    public static readonly OrderedQuery = 'MATCH (a) RETURN a.label ORDER BY a.label'
    public static readonly CrossOrderedQuery = 'MATCH (a), (b) RETURN a.label ORDER BY a.label'
    public static readonly ListQuery = 'UNWIND $xs AS x RETURN x'
    public static readonly MapQuery = 'RETURN $m.k AS v'
    public static readonly WriteQuery = 'CREATE (n)'
    public static readonly AccountLabels = 'MATCH (a:Account) RETURN a.label'
    public static readonly AccountCount = 'MATCH (a:Account) RETURN count(a) AS c'
    public static readonly AccountNodes = 'MATCH (a:Account) RETURN a'

    public static Restricted(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('u1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('u1', Role.Viewer, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** Adds a second member project (models2) to the copied solution, contributing an extra instance. */
    public static AddSecondMember(solution: string): void
    {
        mkdirSync(join(solution, CypherSurfaceFixture.SecondMemberDir))
        writeFileSync(join(solution, CypherSurfaceFixture.SecondModelFile), CypherSurfaceFixture.SecondModelTodl)
        writeFileSync(join(solution, CypherSurfaceFixture.SecondProjectFile), CypherSurfaceFixture.SecondProject)
        const manifest = join(solution, CypherSurfaceFixture.SolutionFile)
        const text = readFileSync(manifest, 'utf8').replace(CypherSurfaceFixture.FirstMemberEntry, `${CypherSurfaceFixture.FirstMemberEntry}, ${CypherSurfaceFixture.SecondMemberEntry}`)
        writeFileSync(manifest, text)
    }

    public static async WithOptions(options: CypherFixtureOptions, body: (client: PragmaticClient) => Promise<void>): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), CypherSurfaceFixture.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), CypherSurfaceFixture.PackagesPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, CypherSurfaceFixture.ModelFile), options.modelTodl ?? CypherSurfaceFixture.ModelTodl)
        if (options.secondMember === true)
        {
            CypherSurfaceFixture.AddSecondMember(solution)
        }
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        if (options.openSolution !== false)
        {
            await server.OpenSolution(solution)
        }
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, options.context ?? CypherSurfaceFixture.Permissive(), () => Promise.reject(new Error(CypherSurfaceFixture.NoConnectors)), ctx => server.Graph(ctx), undefined, undefined, undefined, undefined, undefined, options.limits, TenantPurpose.Development)
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

    public static async With(body: (client: PragmaticClient) => Promise<void>, limits?: CypherLimits): Promise<void>
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
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, CypherSurfaceFixture.Permissive(), () => Promise.reject(new Error(CypherSurfaceFixture.NoConnectors)), ctx => server.Graph(ctx), undefined, undefined, undefined, undefined, undefined, limits, TenantPurpose.Development)
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
        assert.deepEqual(result.items.map(r => r[0]).sort(), ['alpha', 'beta'])
        assert.equal(result.truncated, false)
    })
})

test('cypher/query binds $param values', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.ParamQuery, { n: 'beta' })
        assert.deepEqual(result.items, [['beta']])
    })
})

test('cypher/query returns node cells as plain JSON', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.NodeQuery)
        const node = result.items.map(r => r[0]).find(c => (c as { label: string }).label === 'alpha') as { concept: string, fields: Record<string, { value: unknown }> }
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

test('cypher/query honours an overridden low row cap with truncated true', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.NameQuery)
        assert.equal(result.items.length, 1)
        assert.equal(result.truncated, true)
    }, new CypherLimits(1))
})

test('cypher/query resolves a simple-name label for a namespaced concept', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.LabelQuery)
        assert.deepEqual(result.items.map(r => r[0]).sort(), ['alpha', 'beta'])
    })
})

test('cypher/query node cell rehydrates through SnapshotReader', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.NodeQuery)
        const cells = result.items.map(r => r[0]) as unknown as ConstructorParameters<typeof SnapshotReader>[0][]
        const readers = cells.map(c => new SnapshotReader(c))
        const alpha = readers.find(r => r.field('label') === 'alpha')
        assert.ok(alpha !== undefined)
        assert.ok(alpha.concept.endsWith('Service'))
        assert.ok(alpha.fieldNames().includes('label'))
    })
})

test('cypher/query hides RBAC-restricted instances from RETURN and from count', async () =>
{
    const options = { modelTodl: CypherSurfaceFixture.RegionModelTodl, context: CypherSurfaceFixture.Restricted() }
    await CypherSurfaceFixture.WithOptions(options, async client =>
    {
        const labels = await client.CypherQuery(CypherSurfaceFixture.AccountLabels)
        assert.deepEqual(labels.items, [['visible']])
        const count = await client.CypherQuery(CypherSurfaceFixture.AccountCount)
        assert.deepEqual(count.items, [[1]])
        const nodes = await client.CypherQuery(CypherSurfaceFixture.AccountNodes)
        assert.equal(nodes.items.length, 1)
    })
})

test('cypher/query spans every member project of the active solution', async () =>
{
    // v1 scope is the tenant's ACTIVE solution; cross-solution / tenant-wide querying is deferred to SSM.
    await CypherSurfaceFixture.WithOptions({ secondMember: true }, async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.NameQuery)
        assert.deepEqual(result.items.map(r => r[0]).sort(), ['alpha', 'beta', 'gamma'])
    })
})

test('cypher/query round-trips list and map parameters', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        const list = await client.CypherQuery(CypherSurfaceFixture.ListQuery, { xs: [1, 2, 3] })
        assert.deepEqual(list.items.map(r => r[0]), [1, 2, 3])
        const map = await client.CypherQuery(CypherSurfaceFixture.MapQuery, { m: { k: 'v1' } })
        assert.deepEqual(map.items, [['v1']])
    })
})

test('cypher/query surfaces a distinct timeout error when the deadline is already expired', async () =>
{
    await CypherSurfaceFixture.WithOptions({ limits: new CypherLimits(undefined, 0) }, async client =>
    {
        await assert.rejects(() => client.CypherQuery(CypherSurfaceFixture.OrderedQuery), (error: { code?: number }) => error.code === ServerConnectionHandler.CypherTimeoutCode)
        await assert.rejects(() => client.CypherQuery(CypherSurfaceFixture.CrossOrderedQuery), (error: { code?: number }) => error.code === ServerConnectionHandler.CypherTimeoutCode)
    })
})

test('cypher/query with no solution open returns no rows and is not truncated', async () =>
{
    await CypherSurfaceFixture.WithOptions({ openSolution: false }, async client =>
    {
        const result = await client.CypherQuery(CypherSurfaceFixture.NameQuery)
        assert.deepEqual(result.items, [])
        assert.equal(result.truncated, false)
    })
})

test('cypher/query rejects a write keyword with InvalidParams', async () =>
{
    await CypherSurfaceFixture.With(async client =>
    {
        await assert.rejects(() => client.CypherQuery(CypherSurfaceFixture.WriteQuery), (error: { code?: number }) => error.code === ErrorCodes.InvalidParams)
    })
})
