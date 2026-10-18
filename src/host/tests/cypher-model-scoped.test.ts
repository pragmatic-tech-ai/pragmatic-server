import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes, CursorStaleError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherQueryParams, CypherQueryPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { toJSON, ModelShardExtractor } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { AccessContext, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { CypherLimits } from '../../config/cypher-limits.js'
import { PagingLimits } from '../../config/paging-limits.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { PageFingerprint, PageRequest } from '../paging/page-request.js'
import { CypherParamConverter } from '../cypher/cypher-param-converter.js'
import type { IFieldReadMaskSource } from '../cypher/read-filter-source.js'
import { PpSecurityHarness } from '../cypher/tests/pp-security-harness.js'

/** One open solution holding three models (A, B, C), served through real handlers for chosen principals. */
class ModelScopedWorld
{
    public readonly ModelIds: readonly string[]
    private readonly server: PragmaticServer
    private readonly language: SolutionLanguageService
    private readonly manager: SolutionManagerService
    private readonly fieldMasks: IFieldReadMaskSource
    private readonly handlers: ServerConnectionHandler[] = []
    private readonly clients: PragmaticClient[] = []

    public constructor(server: PragmaticServer, language: SolutionLanguageService, manager: SolutionManagerService, fieldMasks: IFieldReadMaskSource, modelIds: readonly string[])
    {
        this.server = server
        this.language = language
        this.manager = manager
        this.fieldMasks = fieldMasks
        this.ModelIds = modelIds
    }

    public get GraphRevision(): number
    {
        return this.language.GraphRevision
    }

    public Connect(context: AccessContext, purpose: TenantPurpose = TenantPurpose.Development): ServerConnectionHandler
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(
            serverSocket, this.language, this.manager, context, () => Promise.reject(new Error(ModelScopedFixture.NoConnectors)), ctx => this.server.Graph(ctx),
            undefined, undefined, undefined, undefined, undefined, undefined, purpose, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            this.fieldMasks, ctx => this.server.ConnectorReadAuthorizationFor(ctx), undefined, (ctx, id) => this.server.ModelGraph(ctx, id))
        this.clients.push(PragmaticClient.CreateOverSocket(clientSocket))
        this.handlers.push(handler)
        return handler
    }

    public async Dispose(): Promise<void>
    {
        for (const client of this.clients)
        {
            await client.DisposeAsync()
        }
        for (const handler of this.handlers)
        {
            handler.Dispose()
        }
        await this.language.WhenIdle()
        await this.manager.CloseSolution()
        await this.server.Dispose()
    }
}

class ModelScopedFixture
{
    public static readonly NoConnectors = 'no connectors'
    public static readonly Plain = 'p1'
    public static readonly Granted = 'p2'
    public static readonly Unknown = 'no-such-model'
    public static readonly OtherUnknown = 'another-missing-model'
    public static readonly Secret = 'hush'
    public static readonly LabelQuery = 'MATCH (w:Widget) RETURN w.label AS label ORDER BY label'
    public static readonly SecretQuery = 'MATCH (w:Widget) RETURN w.secret AS secret'
    private static readonly SolutionPrefix = 'cms-sol-'
    private static readonly PackagesPrefix = 'cms-pkgs-'
    private static readonly IdentityPrefix = 'cms-id-'
    private static readonly ModelFile = join('models', 'model.todl')
    private static readonly Namespace = 'acme'
    private static readonly Qualified = 'acme.Widget'
    private static readonly SecretField = 'secret'
    private static readonly Profile = 'secret-readers'
    private static readonly ProfileName = 'Secret readers'
    private static readonly ExpectedRejection = 'expected rejection'

    /** A: two sales rows + one root row. B: one sales row. C: root rows only. */
    public static ModelTodl(): string
    {
        const bu = PpSecurityHarness.OwningBuField
        const sales = PpSecurityHarness.SalesBu
        const root = PpSecurityHarness.RootBu
        const widget = PpSecurityHarness.Concept
        const ns = ModelScopedFixture.Namespace
        const row = (id: string, owner: string, label: string): string => `${widget} ${id} { ${bu} = "${owner}"; label = "${label}"; secret = "${ModelScopedFixture.Secret}"; } `
        return `namespace ${ns} { concept ${widget} { ${bu} : string?; label : string?; secret : string?; } `
            + `model ShopA : ${ns} { ${row('a1', sales, 'alpha')}${row('a2', root, 'beta')}${row('a3', sales, 'alpha2')} } `
            + `model ShopB : ${ns} { ${row('b1', sales, 'gamma')} } `
            + `model ShopC : ${ns} { ${row('c1', root, 'delta')} } }`
    }

    public static Context(principalId: string): AccessContext
    {
        return PpSecurityHarness.Context(principalId)
    }

    /** BusinessUnit-level Read on Widget for both principals (home BU sales); `secret` is secured, only Granted holds a profile reading it. */
    public static Model(): ISecurityModelConfig
    {
        const base = PpSecurityHarness.BuSecurityModel(ModelScopedFixture.Plain)
        const reader = base.roles![0].id
        return {
            ...base,
            ownershipRules: base.ownershipRules.map(r => ({ ...r, concept: ModelScopedFixture.Qualified })),
            roles: (base.roles ?? []).map(r => ({ ...r, privileges: r.privileges.map(p => ({ ...p, concept: ModelScopedFixture.Qualified })) })),
            membership: { claimsMapping: [], overrides: [
                { principalId: ModelScopedFixture.Plain, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
                { principalId: ModelScopedFixture.Granted, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
            ] },
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: ModelScopedFixture.Plain, roles: [reader] },
                { principalId: ModelScopedFixture.Granted, roles: [reader] },
            ] },
            fieldSecurity: {
                securedFields: [{ concept: ModelScopedFixture.Qualified, field: ModelScopedFixture.SecretField }],
                profiles: [{ id: ModelScopedFixture.Profile, name: ModelScopedFixture.ProfileName, grants: [{ concept: ModelScopedFixture.Qualified, field: ModelScopedFixture.SecretField, read: true }] }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [{ principalId: ModelScopedFixture.Granted, profiles: [ModelScopedFixture.Profile] }] },
            },
        }
    }

    public static async With(identityOn: boolean, body: (world: ModelScopedWorld) => Promise<void>): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), ModelScopedFixture.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), ModelScopedFixture.PackagesPrefix))
        const identityRoot = mkdtempSync(join(tmpdir(), ModelScopedFixture.IdentityPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, ModelScopedFixture.ModelFile), ModelScopedFixture.ModelTodl())
        PpSecurityHarness.SetKey()
        const server = identityOn
            ? new PragmaticServer({ packagesRoot: packages, identity: PpSecurityHarness.Identity(identityRoot) })
            : new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        await server.OpenSolution(solution)
        if (identityOn)
        {
            await PpSecurityHarness.Seed(server, ModelScopedFixture.Model())
        }
        const language = await server.LanguageService() as SolutionLanguageService
        await language.WhenIdle()
        const manager = await server.Manager()
        const member = [...manager.ActiveSolution!.Members].find(m => m.Storage !== undefined)!
        const view = await language.ModelView(member.Storage!)
        const ids = ModelShardExtractor.ModelsOf(toJSON(view!.model)).map(m => String(m))
        const world = new ModelScopedWorld(server, language, manager, await server.FieldReadMaskSource(), ids)
        try
        {
            await body(world)
        }
        finally
        {
            await world.Dispose()
            PpSecurityHarness.ClearKey()
            rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
            rmSync(identityRoot, { recursive: true, force: true })
        }
    }

    public static Params(modelId: string | undefined, cypher: string = ModelScopedFixture.LabelQuery, extra: Partial<CypherQueryParams> = {}): CypherQueryParams
    {
        return modelId === undefined ? { cypher, ...extra } : { cypher, modelId, ...extra }
    }

    public static Text(page: CypherQueryPageDto): string
    {
        return JSON.stringify(page.items)
    }

    public static async CodeOf(attempt: Promise<unknown>): Promise<{ code: number | undefined, message: string }>
    {
        try
        {
            await attempt
        }
        catch (error)
        {
            const e = error as { code?: number, message?: string }
            return { code: e.code, message: e.message ?? '' }
        }
        throw new Error(ModelScopedFixture.ExpectedRejection)
    }
}

test('the fixture yields three model shards', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        assert.equal(world.ModelIds.length, 3)
    })
})

test('a model-scoped query runs only against the named shard', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        const handler = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const [a, b] = world.ModelIds
        const inA = ModelScopedFixture.Text(await handler.RunCypherQuery(ModelScopedFixture.Params(a)))
        const inB = ModelScopedFixture.Text(await handler.RunCypherQuery(ModelScopedFixture.Params(b)))
        assert.ok(inA.includes('alpha') && inA.includes('alpha2'))
        assert.ok(!inA.includes('gamma'))
        assert.ok(inB.includes('gamma'))
        assert.ok(!inB.includes('alpha'))
    })
})

test('model-scoped respects the SAME row filter as tenant-wide', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        const handler = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const tenant = ModelScopedFixture.Text(await handler.RunCypherQuery(ModelScopedFixture.Params(undefined)))
        const scoped = ModelScopedFixture.Text(await handler.RunCypherQuery(ModelScopedFixture.Params(world.ModelIds[0])))
        assert.ok(!tenant.includes('beta'), 'tenant-wide hides the root-owned row')
        assert.ok(!scoped.includes('beta'), 'model-scoped hides the same row')
        assert.ok(scoped.includes('alpha'))
    })
})

test('a secured field is masked in model-scoped results', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        const plain = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const granted = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Granted))
        const id = world.ModelIds[0]
        const masked = ModelScopedFixture.Text(await plain.RunCypherQuery(ModelScopedFixture.Params(id, ModelScopedFixture.SecretQuery)))
        const open = ModelScopedFixture.Text(await granted.RunCypherQuery(ModelScopedFixture.Params(id, ModelScopedFixture.SecretQuery)))
        assert.ok(!masked.includes(ModelScopedFixture.Secret))
        assert.ok(open.includes(ModelScopedFixture.Secret))
    })
})

test('an UNKNOWN modelId is InvalidParams', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        const handler = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const error = await ModelScopedFixture.CodeOf(handler.RunCypherQuery(ModelScopedFixture.Params(ModelScopedFixture.Unknown)))
        assert.equal(error.code, ErrorCodes.InvalidParams)
    })
})

test('any non-member modelId is InvalidParams with an identical error', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        const handler = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const first = await ModelScopedFixture.CodeOf(handler.RunCypherQuery(ModelScopedFixture.Params(ModelScopedFixture.Unknown)))
        const second = await ModelScopedFixture.CodeOf(handler.RunCypherQuery(ModelScopedFixture.Params(ModelScopedFixture.OtherUnknown)))
        assert.equal(first.code, ErrorCodes.InvalidParams)
        assert.deepEqual(first, second)
        assert.ok(!first.message.includes(ModelScopedFixture.Unknown))
    })
})

test('a member shard where the principal sees no rows returns an empty page', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        const handler = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const page = await handler.RunCypherQuery(ModelScopedFixture.Params(world.ModelIds[2]))
        assert.deepEqual(page.items, [])
        assert.equal(page.nextCursor, undefined)
    })
})

test('a secured field is masked in a tenant-wide (no modelId) result', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        const plain = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const granted = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Granted))
        const masked = ModelScopedFixture.Text(await plain.RunCypherQuery(ModelScopedFixture.Params(undefined, ModelScopedFixture.SecretQuery)))
        const open = ModelScopedFixture.Text(await granted.RunCypherQuery(ModelScopedFixture.Params(undefined, ModelScopedFixture.SecretQuery)))
        assert.ok(!masked.includes(ModelScopedFixture.Secret))
        assert.ok(open.includes(ModelScopedFixture.Secret))
    })
})

test('a cursor minted for modelId A is stale for modelId B', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        const handler = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const first = await handler.RunCypherQuery(ModelScopedFixture.Params(world.ModelIds[0], ModelScopedFixture.LabelQuery, { pageSize: 1 }))
        assert.ok(first.nextCursor !== undefined)
        const second = await handler.RunCypherQuery(ModelScopedFixture.Params(world.ModelIds[0], ModelScopedFixture.LabelQuery, { pageSize: 1, cursor: first.nextCursor }))
        assert.ok(ModelScopedFixture.Text(second).includes('alpha2'))
        const stale = await ModelScopedFixture.CodeOf(handler.RunCypherQuery(ModelScopedFixture.Params(world.ModelIds[1], ModelScopedFixture.LabelQuery, { pageSize: 1, cursor: first.nextCursor })))
        assert.equal(stale.code, CursorStaleError.Code)
    })
})

test('a model-scoped cursor is stale across principals when identity-backed', async () =>
{
    await ModelScopedFixture.With(true, async world =>
    {
        const one = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const two = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Granted))
        const first = await one.RunCypherQuery(ModelScopedFixture.Params(world.ModelIds[0], ModelScopedFixture.LabelQuery, { pageSize: 1 }))
        const stale = await ModelScopedFixture.CodeOf(two.RunCypherQuery(ModelScopedFixture.Params(world.ModelIds[0], ModelScopedFixture.LabelQuery, { pageSize: 1, cursor: first.nextCursor })))
        assert.equal(stale.code, CursorStaleError.Code)
    })
})

test('no-identity / no-modelId path is byte-unchanged', async () =>
{
    await ModelScopedFixture.With(false, async world =>
    {
        const handler = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain))
        const page = await handler.RunCypherQuery(ModelScopedFixture.Params(undefined, ModelScopedFixture.LabelQuery, { pageSize: 1 }))
        const fingerprint = PageFingerprint.Of('cypher', ModelScopedFixture.LabelQuery, CypherParamConverter.Canonical(undefined), String(world.GraphRevision))
        const expected = PageRequest.Resolve({ pageSize: 1 }, fingerprint, new PagingLimits(), new CypherLimits().RowCap).NextCursor(true)
        assert.equal(page.nextCursor, expected)
    })
})

test('modelId on a Runtime-purpose connection is InvalidParams', async () =>
{
    await ModelScopedFixture.With(false, async world =>
    {
        const handler = world.Connect(ModelScopedFixture.Context(ModelScopedFixture.Plain), TenantPurpose.Runtime)
        const error = await ModelScopedFixture.CodeOf(handler.RunCypherQuery(ModelScopedFixture.Params(world.ModelIds[0])))
        assert.equal(error.code, ErrorCodes.InvalidParams)
    })
})
