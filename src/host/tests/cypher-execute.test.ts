import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, mkdirSync, mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherExecuteParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import { toJSON, ModelShardExtractor } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { AccessContext, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import type { IFieldReadMaskSource } from '../cypher/read-filter-source.js'
import { PpSecurityHarness } from '../cypher/tests/pp-security-harness.js'

class ExecWorld
{
    public readonly ModelIds: readonly string[]
    private readonly handlers: ServerConnectionHandler[] = []
    private readonly clients: PragmaticClient[] = []

    public constructor(
        private readonly server: PragmaticServer,
        private readonly language: SolutionLanguageService,
        private readonly manager: SolutionManagerService,
        private readonly fieldMasks: IFieldReadMaskSource,
        modelIds: readonly string[],
        public readonly ModelFile: string)
    {
        this.ModelIds = modelIds
    }

    public get Shop(): string
    {
        return this.ModelIds.find(i => i.includes(ExecFixture.ShopName))!
    }

    public get GraphRevision(): number
    {
        return this.language.GraphRevision
    }

    public Source(): string
    {
        const dir = dirname(this.ModelFile)
        return readdirSync(dir).filter(f => f.endsWith('.todl')).sort().map(f => f + ':' + readFileSync(join(dir, f), 'utf8')).join(' | ')
    }

    public Connect(context: AccessContext, purpose: TenantPurpose = TenantPurpose.Development): ServerConnectionHandler
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(
            serverSocket, this.language, this.manager, context, () => Promise.reject(new Error(ExecFixture.NoConnectors)), ctx => this.server.Graph(ctx),
            undefined, undefined, undefined, undefined, undefined, undefined, purpose, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            this.fieldMasks, ctx => this.server.ConnectorReadAuthorizationFor(ctx), undefined, (ctx, id) => this.server.ModelGraph(ctx, id),
            (ctx, id, request) => this.server.ExecuteCypher(ctx, id, request))
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

class ExecFixture
{
    public static readonly NoConnectors = 'no connectors'
    public static readonly Plain = 'p1'
    public static readonly ShopName = 'acmeModel'
    public static readonly Secret = 'hush'
    public static readonly Create = "CREATE (:Widget {label: 'zeta'})"
    public static readonly Find = "MATCH (w:Widget) WHERE w.label = 'zeta' RETURN w.label AS label"
    private static readonly SolutionPrefix = 'cex-sol-'
    private static readonly PackagesPrefix = 'cex-pkgs-'
    private static readonly IdentityPrefix = 'cex-id-'
    private static readonly ModelFile = join('models', 'model.todl')
    private static readonly SchemaFile = 'schema.todl'
    private static readonly BaseDir = 'base'
    private static readonly ModelsDir = 'models'
    private static readonly ProjectFile = 'project.plexus'
    private static readonly SolutionFile = 'Sample.pksln'
    private static readonly BaseId = 'base-mm'
    private static readonly PackageVersion = '0.1.0'
    private static readonly Qualified = 'acme.Widget'
    private static readonly SecretField = 'secret'
    private static readonly ExpectedRejection = 'expected rejection'

    public static BaseProject(): string
    {
        return JSON.stringify({ type: 'meta-model', name: 'Base', id: ExecFixture.BaseId, packageVersion: ExecFixture.PackageVersion })
    }

    public static ModelProject(): string
    {
        return JSON.stringify({ type: 'meta-model', name: 'Sample Model', id: 'sample-model', packageVersion: ExecFixture.PackageVersion, metaModels: [{ id: ExecFixture.BaseId, version: ExecFixture.PackageVersion }] })
    }

    public static SolutionManifest(): string
    {
        return JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: ExecFixture.BaseDir, type: 'meta-model' }, { path: ExecFixture.ModelsDir, type: 'meta-model' }], settings: {}, bags: {} })
    }

    public static SchemaTodl(): string
    {
        const bu = PpSecurityHarness.OwningBuField
        return `namespace acme { concept ${PpSecurityHarness.Concept} { ${bu} : string?; label : string?; secret : string?; } model BaseM : acme { ${PpSecurityHarness.Concept} b1 { label = "basey"; } } }`
    }

    public static ModelTodl(): string
    {
        const bu = PpSecurityHarness.OwningBuField
        const sales = PpSecurityHarness.SalesBu
        const widget = PpSecurityHarness.Concept
        return `namespace acme { model acmeModel : acme { ${widget} a1 { ${bu} = "${sales}"; label = "alpha"; secret = "${ExecFixture.Secret}"; } } }`
    }

    public static Context(principalId: string): AccessContext
    {
        return PpSecurityHarness.Context(principalId)
    }

    /** Read-only role plus a secured field the principal cannot read: reads are visible, writes are denied. */
    public static Model(): ISecurityModelConfig
    {
        const base = PpSecurityHarness.BuSecurityModel(ExecFixture.Plain)
        const reader = base.roles![0].id
        return {
            ...base,
            ownershipRules: base.ownershipRules.map(r => ({ ...r, concept: ExecFixture.Qualified })),
            roles: (base.roles ?? []).map(r => ({ ...r, privileges: r.privileges.map(p => ({ ...p, concept: ExecFixture.Qualified })) })),
            membership: { claimsMapping: [], overrides: [{ principalId: ExecFixture.Plain, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] }] },
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [{ principalId: ExecFixture.Plain, roles: [reader] }] },
            fieldSecurity: { securedFields: [{ concept: ExecFixture.Qualified, field: ExecFixture.SecretField }], profiles: [], profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [] } },
        }
    }

    public static CoLocatedTodl(): string
    {
        const bu = PpSecurityHarness.OwningBuField
        const widget = PpSecurityHarness.Concept
        return `namespace acme { concept ${widget} { ${bu} : string?; label : string?; secret : string?; } `
            + `model acmeModel : acme { ${widget} a1 { label = "alpha"; } } }`
    }

    private static WriteBase(solution: string): void
    {
        mkdirSync(join(solution, ExecFixture.BaseDir))
        writeFileSync(join(solution, ExecFixture.BaseDir, ExecFixture.SchemaFile), ExecFixture.SchemaTodl())
        writeFileSync(join(solution, ExecFixture.BaseDir, ExecFixture.ProjectFile), ExecFixture.BaseProject())
        writeFileSync(join(solution, ExecFixture.ModelsDir, ExecFixture.ProjectFile), ExecFixture.ModelProject())
        writeFileSync(join(solution, ExecFixture.SolutionFile), ExecFixture.SolutionManifest())
    }

    public static async With(identityOn: boolean, body: (world: ExecWorld) => Promise<void>, coLocated: boolean = false): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), ExecFixture.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), ExecFixture.PackagesPrefix))
        const identityRoot = mkdtempSync(join(tmpdir(), ExecFixture.IdentityPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        const modelFile = join(solution, ExecFixture.ModelFile)
        writeFileSync(modelFile, coLocated ? ExecFixture.CoLocatedTodl() : ExecFixture.ModelTodl())
        if (!coLocated)
        {
            ExecFixture.WriteBase(solution)
        }
        PpSecurityHarness.SetKey()
        const server = identityOn
            ? new PragmaticServer({ packagesRoot: packages, identity: PpSecurityHarness.Identity(identityRoot) })
            : new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        await server.OpenSolution(solution)
        if (identityOn)
        {
            await PpSecurityHarness.Seed(server, ExecFixture.Model())
        }
        const language = await server.LanguageService() as SolutionLanguageService
        await language.WhenIdle()
        const manager = await server.Manager()
        const member = [...manager.ActiveSolution!.Members].find(m => m.Storage !== undefined)!
        const view = await language.ModelView(member.Storage!)
        const ids = ModelShardExtractor.ModelsOf(toJSON(view!.model)).map(m => String(m))
        const world = new ExecWorld(server, language, manager, await server.FieldReadMaskSource(), ids, modelFile)
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

    public static async CodeOf(attempt: Promise<unknown>): Promise<number | undefined>
    {
        try
        {
            await attempt
        }
        catch (error)
        {
            return (error as { code?: number }).code
        }
        throw new Error(ExecFixture.ExpectedRejection)
    }

    public static P(modelId: string | undefined, cypher: string, extra: Partial<CypherExecuteParams> = {}): CypherExecuteParams
    {
        return modelId === undefined ? { cypher, ...extra } : { cypher, modelId, ...extra }
    }
}

test('a runtime tenant rejects cypher/execute with InvalidRequest', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain), TenantPurpose.Runtime)
        assert.equal(await ExecFixture.CodeOf(handler.RunCypherExecute(ExecFixture.P(world.Shop, ExecFixture.Create))), ErrorCodes.InvalidRequest)
    })
})

test('omitted or unknown modelId => InvalidParams (write must name its target member)', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        assert.equal(await ExecFixture.CodeOf(handler.RunCypherExecute(ExecFixture.P(undefined, ExecFixture.Create))), ErrorCodes.InvalidParams)
        assert.equal(await ExecFixture.CodeOf(handler.RunCypherExecute(ExecFixture.P('no-such-model', ExecFixture.Create))), ErrorCodes.InvalidParams)
    })
})

test('CREATE persists to the member .todl, bumps revision, and a follow-up cypher/query sees the new node', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        const before = world.GraphRevision
        const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, ExecFixture.Create))
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.equal(result.counts.nodesCreated, 1)
        assert.ok(result.revision > before)
        assert.ok(world.Source().includes('zeta'))
        const page = await handler.RunCypherQuery({ cypher: ExecFixture.Find })
        assert.deepEqual(page.items, [['zeta']])
    })
})

test('a denied op => status Denied, nothing persisted (source text unchanged)', async () =>
{
    await ExecFixture.With(true, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        const source = world.Source()
        const revision = world.GraphRevision
        const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, ExecFixture.Create))
        assert.equal(result.status, AppWriteStatus.Denied)
        assert.equal(world.Source(), source)
        assert.equal(world.GraphRevision, revision)
        assert.ok(!JSON.stringify(result).includes(ExecFixture.Secret))
    })
})

test('expectedRevision mismatch => status Conflict, nothing applied', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        const source = world.Source()
        const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, ExecFixture.Create, { expectedRevision: world.GraphRevision + 100 }))
        assert.equal(result.status, AppWriteStatus.Conflict)
        assert.equal(world.Source(), source)
    })
})

test('a no-op MERGE (only matched) => Applied, counts all zero, revision unchanged', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        const source = world.Source()
        const revision = world.GraphRevision
        const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, "MERGE (:Widget {label: 'alpha'})"))
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.deepEqual(result.counts, { nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0 })
        assert.equal(result.revision, revision)
        assert.equal(world.Source(), source)
    })
})

test('RETURN rows come back as masked CypherNodeCellDto cells', async () =>
{
    await ExecFixture.With(true, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, 'MATCH (w:Widget) RETURN w'))
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.equal(result.rows.length, 1)
        const cell = result.rows[0]![0] as { id: string, fields: Record<string, unknown> }
        assert.equal(typeof cell.id, 'string')
        assert.ok(cell.fields['label'] !== undefined)
        assert.ok(!JSON.stringify(result).includes(ExecFixture.Secret))
    })
})

test('a syntax error => InvalidParams (transport); a not-writable base node => in-band Invalid', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        assert.equal(await ExecFixture.CodeOf(handler.RunCypherExecute(ExecFixture.P(world.Shop, 'CREAT (('))), ErrorCodes.InvalidParams)
        const source = world.Source()
        const revision = world.GraphRevision
        const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, "MATCH (w:Widget) WHERE w.label = 'basey' SET w.label = 'changed'"))
        assert.equal(result.status, AppWriteStatus.Invalid)
        assert.equal(world.Source(), source)
        assert.equal(world.GraphRevision, revision)
    })
})

test('concurrent executes serialize (per-tenant mutex) - both land with distinct revisions', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        const id = world.Shop
        const [one, two] = await Promise.all([
            handler.RunCypherExecute(ExecFixture.P(id, "CREATE (:Widget {label: 'one'})")),
            handler.RunCypherExecute(ExecFixture.P(id, "CREATE (:Widget {label: 'two'})")),
        ])
        assert.equal(one.status, AppWriteStatus.Applied)
        assert.equal(two.status, AppWriteStatus.Applied)
        assert.notEqual(one.revision, two.revision)
        const source = world.Source()
        assert.ok(source.includes('one') && source.includes('two'))
    })
})

test('a canonical model id stays stable across writes: second execute and a model-scoped query still resolve it', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        const id = world.Shop
        const first = await handler.RunCypherExecute(ExecFixture.P(id, "CREATE (:Widget {label: 'one'})"))
        assert.equal(first.status, AppWriteStatus.Applied)
        const second = await handler.RunCypherExecute(ExecFixture.P(id, "CREATE (:Widget {label: 'two'})"))
        assert.equal(second.status, AppWriteStatus.Applied)
        const page = await handler.RunCypherQuery({ cypher: 'MATCH (w:Widget) RETURN w.label AS label ORDER BY label', modelId: id })
        assert.ok(JSON.stringify(page.items).includes('one') && JSON.stringify(page.items).includes('two'))
    })
})

test('a schema co-located with instances is refused in-band (Invalid), nothing persisted and the concept survives', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        const source = world.Source()
        const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, ExecFixture.Create))
        assert.equal(result.status, AppWriteStatus.Invalid)
        assert.ok((result.reason ?? '').includes('co-located'))
        assert.equal(world.Source(), source)
        assert.ok(world.Source().includes('concept Widget'))
    }, true)
})

test('a model owned by the FIRST instance-bearing member resolves too (not only the second)', async () =>
{
    await ExecFixture.With(false, async world =>
    {
        const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
        const baseModel = world.ModelIds.find(i => i.includes('BaseM'))!
        // BaseM lives in the first member (schema co-located with its instances): resolution succeeds, the schema guard refuses in-band
        const result = await handler.RunCypherExecute(ExecFixture.P(baseModel, ExecFixture.Create))
        assert.equal(result.status, AppWriteStatus.Invalid)
        assert.ok((result.reason ?? '').includes('co-located'))
    })
})
