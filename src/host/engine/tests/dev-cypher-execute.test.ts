import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, mkdirSync, mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ConflictError } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, GraphTransaction } from '@pragmatic-tech-ai/graph'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes, AppWriteStatus, CypherCells } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherExecuteParams, CypherExecuteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import { AccessLevel, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, IFieldSecurityConfig, IPrivilegeConfig, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { CypherLimits } from '../../../config/cypher-limits.js'
import { PagingLimits } from '../../../config/paging-limits.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'
import type { IFieldReadMaskSource } from '../../cypher/read-filter-source.js'
import { PpSecurityHarness } from '../../cypher/tests/pp-security-harness.js'
import { WriteLockBusyError } from '../../cypher/write-lock.js'
import type { IWriteLease, IWriteLock } from '../../cypher/write-lock.js'
import { DevAccessScopeSource } from '../dev-access-scope-source.js'
import { DevCypherExecute } from '../dev-cypher-execute.js'
import { DevGraphEngineHost } from '../dev-graph-engine-host.js'
import type { IDevEngineDiagnostics, IDevGraphEngine } from '../dev-graph-engine-host.js'
import type { DevSnapshot } from '../dev-snapshot-source.js'
import type { IDevWriteDiagnostics } from '../server-model-workspace.js'
import { DevScopeFx } from './dev-scope-fixture.js'
import { FakeLanguageService, FakeSolution, MemoryStorage } from './engine-host-fixture.js'

// ── ported from host/tests/cypher-execute.test.ts (the legacy writer -> the dev engine) ──────────────

class ExecWorld
{
    public readonly ModelIds: readonly string[]
    private readonly handlers: ServerConnectionHandler[] = []
    private readonly clients: PragmaticClient[] = []

    public constructor(
        public readonly Server: PragmaticServer,
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
        return this.TodlFiles().map(f => f + ':' + readFileSync(join(dir, f), 'utf8')).join(' | ')
    }

    /** The `.todl` files in the model member's folder, sorted. */
    public TodlFiles(): string[]
    {
        return readdirSync(dirname(this.ModelFile)).filter(f => f.endsWith('.todl')).sort()
    }

    public async SchemaVersion(): Promise<string>
    {
        return (await this.Server.DevEngine().Engine()).SchemaVersion
    }

    /** A dev cypher/query on the engine, as the handler runs it (default limits). */
    public async Query(context: AccessContext, source: string, modelId?: string): Promise<unknown[][]>
    {
        const limits = new CypherLimits()
        const page = await this.Server.DevCypher().Run(context, {
            Source: source,
            Parameters: new Map(),
            CanonicalParameters: '',
            ...(modelId === undefined ? {} : { ModelId: modelId }),
            Page: { Params: {}, Limits: new PagingLimits(), RowCap: limits.RowCap },
            TimeoutMs: limits.TimeoutMs,
            MaxVarLength: limits.MaxVarLength,
        })
        return page.items
    }

    public Connect(context: AccessContext, purpose: TenantPurpose = TenantPurpose.Development): ServerConnectionHandler
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(
            serverSocket, this.language, this.manager, context, () => Promise.reject(new Error(ExecFixture.NoConnectors)), this.Server.DevCypher(),
            undefined, undefined, undefined, undefined, undefined, undefined, purpose, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            this.fieldMasks, ctx => this.Server.ConnectorReadAuthorizationFor(ctx), undefined,
            (ctx, id, request) => this.Server.ExecuteCypher(ctx, id, request))
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
        await this.Server.Dispose()
    }
}

class ExecFixture
{
    public static readonly NoConnectors = 'no connectors'
    public static readonly Plain = 'p1'
    public static readonly ShopName = 'acmeModel'
    public static readonly Secret = 'hush'
    public static readonly SolutionName = 'Sample'
    public static readonly Create = "CREATE (:Widget {label: 'zeta'})"
    public static readonly Find = "MATCH (w:Widget) WHERE w.label = 'zeta' RETURN w.label AS label"
    public static readonly ModelFileName = 'model.todl'
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
        return JSON.stringify({ kind: 'todl-solution', version: 1, name: ExecFixture.SolutionName, members: [{ path: ExecFixture.BaseDir, type: 'meta-model' }, { path: ExecFixture.ModelsDir, type: 'meta-model' }], settings: {}, bags: {} })
    }

    /** The base member: the schema, a taxonomy whose terms the solution package owns, and the model BaseM. */
    public static SchemaTodl(): string
    {
        const bu = PpSecurityHarness.OwningBuField
        return `namespace acme { concept ${PpSecurityHarness.Concept} { ${bu} : string?; secret : string?; } taxonomy Kinds : represents ${PpSecurityHarness.Concept} { term Big { } } model BaseM : acme { ${PpSecurityHarness.Concept} b1 { label = "basey"; } } }`
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

    public static CoLocatedConcept(): string
    {
        return `concept ${PpSecurityHarness.Concept} { ${PpSecurityHarness.OwningBuField} : string?; secret : string?; }`
    }

    public static CoLocatedTodl(): string
    {
        return `namespace acme { ${ExecFixture.CoLocatedConcept()} model acmeModel : acme { ${PpSecurityHarness.Concept} a1 { label = "alpha"; } } }`
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
        cpSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
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
        // the model ids cypher/execute accepts are the engine's (cypher/models), not the language-service views
        const ids = await server.DevCypher().Models()
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

describe('dev cypher/execute over the connection (ported from host/tests/cypher-execute.test.ts)', () =>
{
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
            // the model list is cypher/models' (DevSnapshot.Models): the solution package is no model
            assert.equal(await ExecFixture.CodeOf(handler.RunCypherExecute(ExecFixture.P(ExecFixture.SolutionName, ExecFixture.Create))), ErrorCodes.InvalidParams)
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
            assert.equal(result.reason, 'graph revision has advanced')
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
            const cell = CypherCells.AsNode(result.rows[0]![0])!
            assert.equal(typeof cell.id, 'string')
            assert.ok(cell.fields['label'] !== undefined)
            assert.ok(!JSON.stringify(result).includes(ExecFixture.Secret))
        })
    })

    test('a syntax error => InvalidParams (transport); a not-writable node => in-band Invalid', async () =>
    {
        await ExecFixture.With(false, async world =>
        {
            const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
            assert.equal(await ExecFixture.CodeOf(handler.RunCypherExecute(ExecFixture.P(world.Shop, 'CREAT (('))), ErrorCodes.InvalidParams)
            const source = world.Source()
            const revision = world.GraphRevision
            // on the engine a base member's model instance is its own model's, written through its own draft; the
            // node no member may write is one the solution package owns (a taxonomy term)
            const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, "MATCH (t:Term) SET t.description = 'changed'"))
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

    test('a write to a member whose schema is co-located with its instances applies and keeps the schema verbatim', async () =>
    {
        await ExecFixture.With(false, async world =>
        {
            const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
            const schema = ExecFixture.CoLocatedConcept()
            assert.ok(world.Source().includes(schema))
            const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, ExecFixture.Create))
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.ok(world.Source().includes(schema), world.Source())
            const page = await handler.RunCypherQuery({ cypher: ExecFixture.Find, modelId: world.Shop })
            assert.ok(JSON.stringify(page.items).includes('zeta'))
        }, true)
    })

    test('a model owned by the FIRST instance-bearing member resolves too (not only the second)', async () =>
    {
        await ExecFixture.With(false, async world =>
        {
            const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
            const baseModel = world.ModelIds.find(i => i.includes('BaseM'))!
            // BaseM lives in the first member (schema co-located with its instances): it resolves and the write applies
            const result = await handler.RunCypherExecute(ExecFixture.P(baseModel, ExecFixture.Create))
            assert.equal(result.status, AppWriteStatus.Applied)
        })
    })

    // ── engine-path behaviour ──────────────────────────────────────────────────────────────────────

    test('create is visible to a follow-up query', async () =>
    {
        await ExecFixture.With(false, async world =>
        {
            const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
            const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, ExecFixture.Create))
            assert.equal(result.status, AppWriteStatus.Applied)
            const context = ExecFixture.Context(ExecFixture.Plain)
            assert.deepEqual(await world.Query(context, ExecFixture.Find), [['zeta']])
            assert.deepEqual(await world.Query(context, ExecFixture.Find, world.Shop), [['zeta']], 'the created node is in the model it was placed in')
        })
    })

    test('a CREATE into a model whose instances live in an existing file lands in that file, and the engine upgrades', async () =>
    {
        await ExecFixture.With(false, async world =>
        {
            const handler = world.Connect(ExecFixture.Context(ExecFixture.Plain))
            const files = world.TodlFiles()
            assert.deepEqual(files, [ExecFixture.ModelFileName])
            const version = await world.SchemaVersion()
            const result = await handler.RunCypherExecute(ExecFixture.P(world.Shop, ExecFixture.Create))
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.deepEqual(world.TodlFiles(), files, 'no second file of the model is written')
            assert.ok(readFileSync(world.ModelFile, 'utf8').includes('zeta'))
            assert.notEqual(await world.SchemaVersion(), version, 'the saved write compiles and the engine upgraded to it before the result')
            assert.equal(result.revision, world.GraphRevision)
            assert.deepEqual(await world.Query(ExecFixture.Context(ExecFixture.Plain), ExecFixture.Find, world.Shop), [['zeta']])
        })
    })
})

// ── the engine write path over memory members (lease, persist, stale, conflict, scope) ──────────────

/** The real language service raises GraphChanged on every edit it loads; the fake is told to, and can fail a refresh. */
class ExecLanguageService extends FakeLanguageService
{
    public RefreshFailure: Error | undefined

    public override DidChange(uri: string, text: string): void
    {
        if (this.RefreshFailure !== undefined) throw this.RefreshFailure
        super.DidChange(uri, text)
        this.RaiseGraphChanged()
    }

    public override DidDelete(uri: string): void
    {
        super.DidDelete(uri)
        this.RaiseGraphChanged()
    }
}

/** A memory member whose N-th write (counted from the last reset) fails. */
class FailingStorage extends MemoryStorage
{
    public static readonly DiskFull = 'disk full'
    public FailOnWriteNumber = 0
    private writes = 0

    public override async WriteText(path: string, content: string): Promise<void>
    {
        this.writes += 1
        if (this.FailOnWriteNumber === this.writes) throw new Error(FailingStorage.DiskFull)
        await super.WriteText(path, content)
    }
}

class SilentEngineDiagnostics implements IDevEngineDiagnostics
{
    public readonly Failures: unknown[] = []

    public UpgradeFailed(error: unknown): void
    {
        this.Failures.push(error)
    }

    public ChangedHandlerFailed(error: unknown): void
    {
        this.Failures.push(error)
    }
}

class RecordingWriteDiagnostics implements IDevWriteDiagnostics
{
    public readonly Refreshes: unknown[] = []

    public RefreshFailed(error: unknown): void
    {
        this.Refreshes.push(error)
    }
}

/** A lock whose lease is granted (or refused) and reports itself held (or lost) as the test dictates. */
class ScriptedLock implements IWriteLock
{
    public Acquired = 0
    public Released = 0

    public constructor(private readonly busy: boolean, private readonly held: boolean)
    {
    }

    public async Acquire(): Promise<IWriteLease>
    {
        if (this.busy) throw new WriteLockBusyError()
        this.Acquired++
        return { Held: async () => this.held, Release: async () => { this.Released++ } }
    }
}

/** The host's engine with its first `conflicts` transaction commits failing as a commit racing an upgrade does. */
class ConflictingHost implements IDevGraphEngine
{
    private static readonly RacedMessage = 'an upgrade was applied while the transaction ran'
    public Commits = 0
    private proxy: GraphEngine | undefined

    public constructor(private readonly inner: DevGraphEngineHost, private conflicts: number)
    {
    }

    public get Changed(): IDevGraphEngine['Changed']
    {
        return this.inner.Changed
    }

    public async Engine(): Promise<GraphEngine>
    {
        const engine = await this.inner.Engine()
        this.proxy ??= new Proxy(engine, { get: (target, name) => (name === 'Begin' ? (scope: unknown) => this.Begin(target, scope) : ConflictingHost.Bound(target, name)) })
        return this.proxy
    }

    public Repository(): ReturnType<IDevGraphEngine['Repository']>
    {
        return this.inner.Repository()
    }

    public Description(): ReturnType<IDevGraphEngine['Description']>
    {
        return this.inner.Description()
    }

    public Snapshot(): Promise<DevSnapshot>
    {
        return this.inner.Snapshot()
    }

    public WhenUpgraded(): Promise<void>
    {
        return this.inner.WhenUpgraded()
    }

    private async Begin(engine: GraphEngine, scope: unknown): Promise<GraphTransaction>
    {
        const transaction = await engine.Begin(scope as Parameters<GraphEngine['Begin']>[0])
        return new Proxy(transaction, { get: (target, name) => (name === 'Commit' ? () => this.Commit(target) : ConflictingHost.Bound(target, name)) })
    }

    private async Commit(transaction: GraphTransaction): Promise<bigint>
    {
        this.Commits += 1
        if (this.conflicts > 0)
        {
            this.conflicts -= 1
            transaction.dispose()
            throw new ConflictError(ConflictingHost.RacedMessage)
        }
        return transaction.Commit()
    }

    private static Bound(target: object, name: string | symbol): unknown
    {
        const value: unknown = Reflect.get(target, name, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    }
}

/**
 * Solution `sol`: member `mem/s` holds the acme schema (no model; its schema reaches `mem/a` as a live sibling base),
 * member `mem/a` holds model acme.Shop in `model.todl`: w1 (p1's, sales, secret "hush", peer -> w2) and w2 (root).
 */
class ExecFx
{
    public static readonly SolutionName = 'sol'
    public static readonly Model = 'acme.Shop'
    public static readonly ModelFile = 'model.todl'
    public static readonly OtherFile = 'other.todl'
    public static readonly ExtraFile = 'extra.todl'
    public static readonly SharedFile = 'two.todl'
    public static readonly Secret = 'hush'
    public static readonly Schema = 'namespace acme {\n  concept Widget { owner : string?; owningBu : string?; secret : string?; code : string?; relationship peer -> Widget?; relationship buddy -> Widget?; }\n}\n'
    public static readonly Shop = 'namespace acme {\n  model Shop : acme {\n    Widget w1 { owner = "p1"; owningBu = "sales"; label = "mine"; secret = "hush"; peer = w2; }\n    Widget w2 { owningBu = "root"; label = "theirs"; }\n  }\n}\n'
    public static readonly OtherModel = 'namespace acme {\n  model Other : acme {\n    Widget o1 { owningBu = "sales"; label = "other"; }\n  }\n}\n'
    public static readonly Shared = 'namespace acme {\n  model Shop : acme {\n    Widget w1 { owningBu = "sales"; label = "mine"; }\n  }\n  model Other : acme {\n    Widget o1 { owningBu = "sales"; label = "other"; }\n  }\n}\n'
    public static readonly Create = "CREATE (:Widget {label: 'fresh'})"
    public static readonly SetBoth = "MATCH (a:Widget {label: 'mine'}), (b:Widget {label: 'other'}) SET a.code = 'A', b.code = 'B'"
    public static readonly SourcesChanged = 'model sources changed during the write'
    public static readonly ZeroCounts = { nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0 }
    private static readonly TimeoutMs = 5000
    private static readonly MaxVarLength = 8

    public readonly SchemaMember = new MemoryStorage('mem/s', { 'schema.todl': ExecFx.Schema })
    public readonly A: FailingStorage
    public readonly Lang = new ExecLanguageService()
    public readonly EngineDiagnostics = new SilentEngineDiagnostics()
    public readonly WriteDiagnostics = new RecordingWriteDiagnostics()
    public readonly Host: DevGraphEngineHost
    public Execute!: DevCypherExecute
    private scopes: DevAccessScopeSource | undefined

    private constructor(files: Readonly<Record<string, string>>)
    {
        this.A = new FailingStorage('mem/a', files)
        this.Lang.ConsumeSibling(this.A, this.SchemaMember)
        const solution = new FakeSolution(ExecFx.SolutionName, [{ Storage: this.SchemaMember }, { Storage: this.A }])
        this.Host = new DevGraphEngineHost(() => Promise.resolve(solution), () => Promise.resolve(this.Lang), undefined, this.EngineDiagnostics, this.WriteDiagnostics)
    }

    /** Opens the fixture: no identity when `model` is absent, else the DevScopeFx tenant holding `model`. */
    public static async Open(options: { model?: ISecurityModelConfig; lock?: IWriteLock; files?: Readonly<Record<string, string>>; host?: (host: DevGraphEngineHost) => IDevGraphEngine } = {}): Promise<ExecFx>
    {
        const fx = new ExecFx(options.files ?? { [ExecFx.ModelFile]: ExecFx.Shop })
        const auth = options.model === undefined ? undefined : (await DevScopeFx.Authorization(options.model)).Auth
        fx.scopes = new DevAccessScopeSource(fx.Host, auth, options.model !== undefined, () => Promise.resolve(ExecFx.SolutionName), { ScopeDiagnostics: () => undefined })
        const scopes = fx.scopes
        const host = options.host?.(fx.Host) ?? fx.Host
        fx.Execute = new DevCypherExecute(host, () => Promise.resolve(scopes), () => Promise.resolve(fx.Lang.GraphRevision), options.lock)
        return fx
    }

    /** Runs `body` on a fresh fixture and disposes it. */
    public static async With(options: Parameters<typeof ExecFx.Open>[0], body: (fx: ExecFx) => Promise<void>): Promise<void>
    {
        const fx = await ExecFx.Open(options)
        try
        {
            await body(fx)
        }
        finally
        {
            fx.scopes?.dispose()
            await fx.Host.dispose()
        }
    }

    public static Security(privileges: readonly [PrivilegeAction, AccessLevel][], fields?: IFieldSecurityConfig): ISecurityModelConfig
    {
        const granted: IPrivilegeConfig[] = privileges.map(([action, level]) => DevScopeFx.Privilege(action, level))
        return DevScopeFx.Model(granted, fields)
    }

    public Run(cypher: string, modelId: string = ExecFx.Model, expectedRevision?: number): Promise<CypherExecuteResultDto>
    {
        return this.Execute.Run(DevScopeFx.Context(DevScopeFx.P1), modelId, {
            cypher,
            parameters: new Map(),
            timeoutMs: ExecFx.TimeoutMs,
            maxVarLength: ExecFx.MaxVarLength,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
        })
    }

    /** Every file of member a, sorted, as `uri:text`. */
    public Source(): string
    {
        return [...this.A.Files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([uri, text]) => uri + ':' + text).join(' | ')
    }

    public File(uri: string = ExecFx.ModelFile): string
    {
        return this.A.Files.get(uri) ?? ''
    }
}

describe('DevCypherExecute lease (ported from host/cypher/tests/dev-cypher-executor.test.ts)', () =>
{
    test('a write holds the tenant lease across the whole write and releases it', async () =>
    {
        const lock = new ScriptedLock(false, true)
        await ExecFx.With({ lock }, async fx =>
        {
            const result = await fx.Run(ExecFx.Create)
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.deepEqual([lock.Acquired, lock.Released], [1, 1])
            assert.ok([...fx.A.Files.values()].some(text => text.includes('fresh')), JSON.stringify([...fx.A.Files]))
        })
    })

    test('a lease held elsewhere is an in-band Conflict and nothing persists', async () =>
    {
        await ExecFx.With({ lock: new ScriptedLock(true, true) }, async fx =>
        {
            const source = fx.Source()
            const result = await fx.Run(ExecFx.Create)
            assert.equal(result.status, AppWriteStatus.Conflict)
            assert.equal(result.reason, 'another write to this tenant is in progress')
            assert.equal(fx.Source(), source)
        })
    })

    test('a lease lost before the persist (fencing) is a Conflict, nothing persists, and the lease is released', async () =>
    {
        const lock = new ScriptedLock(false, false)
        await ExecFx.With({ lock }, async fx =>
        {
            const source = fx.Source()
            const result = await fx.Run(ExecFx.Create)
            assert.equal(result.status, AppWriteStatus.Conflict)
            assert.equal(result.reason, 'the tenant write lease was lost before the write could persist')
            assert.equal(fx.Source(), source)
            assert.equal(lock.Released, 1)
        })
    })

    test('a Persist failure surfaces as in-band Failed with the fixed reason and no partial result', async () =>
    {
        await ExecFx.With({}, async fx =>
        {
            const source = fx.Source()
            const revision = fx.Lang.GraphRevision
            fx.A.FailOnWriteNumber = 1
            const result = await fx.Run(ExecFx.Create)
            assert.equal(result.status, AppWriteStatus.Failed)
            assert.equal(result.reason, 'the model could not be persisted; no changes were kept')
            assert.ok(!JSON.stringify(result).includes(FailingStorage.DiskFull))
            // ported from dev-model-writer.test.ts: no raw error text or file paths reach the caller
            assert.ok(!JSON.stringify(result).includes('.todl'))
            assert.deepEqual(result.counts, ExecFx.ZeroCounts)
            assert.equal(result.revision, revision)
            assert.deepEqual(result.rows, [])
            assert.equal(fx.Source(), source)
        })
    })
})

describe('DevCypherExecute persist (ported from host/model/tests/dev-model-writer.test.ts, server-observable cases)', () =>
{
    test('a committed write persists the model file and returns a bumped revision', async () =>
    {
        await ExecFx.With({}, async fx =>
        {
            const before = fx.Lang.GraphRevision
            const result = await fx.Run(ExecFx.Create)
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.equal(result.counts.nodesCreated, 1)
            assert.ok(result.revision > before)
            assert.ok(fx.Lang.Changes.length > 0)
            assert.match(fx.File(), /label = "fresh"/)
            assert.match(fx.File(), /model Shop : acme/)
        })
    })

    test('a failing second file write restores every file and surfaces Failed', async () =>
    {
        await ExecFx.With({ files: { [ExecFx.ModelFile]: ExecFx.Shop, [ExecFx.OtherFile]: ExecFx.OtherModel } }, async fx =>
        {
            const source = fx.Source()
            fx.A.FailOnWriteNumber = 2
            const result = await fx.Run(ExecFx.SetBoth)
            assert.equal(result.status, AppWriteStatus.Failed)
            assert.equal(fx.Source(), source)
            // the first file was written and restored, each landing told to the language service (Task 3)
            assert.equal(fx.Lang.Changes.length, 2)
        })
    })

    test('a member whose own sources hold schema beside instances writes without touching the schema', async () =>
    {
        const schema = 'namespace acme { concept Order { total : string?; } }'
        await ExecFx.With({ files: { [ExecFx.ModelFile]: ExecFx.Shop, [ExecFx.ExtraFile]: schema } }, async fx =>
        {
            const result = await fx.Run("CREATE (:Order {total: '9'})")
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.equal(fx.File(ExecFx.ExtraFile), schema)
            assert.ok([...fx.A.Files.values()].some(t => t.includes('total = "9"')))
        })
    })

    test('a refresh failure after a successful write still persists and returns the last-known revision', async () =>
    {
        await ExecFx.With({}, async fx =>
        {
            fx.Lang.RefreshFailure = new Error('refresh exploded at /secret/path')
            const before = fx.Lang.GraphRevision
            const result = await fx.Run(ExecFx.Create)
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.equal(result.revision, before)
            assert.equal(fx.WriteDiagnostics.Refreshes.length, 1)
            assert.match(fx.File(), /label = "fresh"/)
        })
    })

    test('a co-located file with schema and two model blocks keeps both blocks and its schema on write-back', async () =>
    {
        const twoModels = 'namespace acme { concept Order { total : string?; } model A : acme { Order o1 { total = "1"; } } model B : acme { Order o2 { total = "2"; } } }'
        await ExecFx.With({ files: { [ExecFx.ModelFile]: ExecFx.Shop, [ExecFx.ExtraFile]: twoModels } }, async fx =>
        {
            const result = await fx.Run("CREATE (:Order {total: '3'})", 'acme.A')
            assert.equal(result.status, AppWriteStatus.Applied)
            const extra = fx.File(ExecFx.ExtraFile)
            assert.match(extra, /concept Order/)
            assert.match(extra, /model A : acme \{[^}]*o1/)
            assert.match(extra, /model B : acme \{[^}]*o2/)
            assert.match(extra, /total = "3"/)
        })
    })
})

describe('DevCypherExecute outcomes', () =>
{
    test('an unknown model, or the solution package, is InvalidParams', async () =>
    {
        await ExecFx.With({}, async fx =>
        {
            assert.equal(await ExecFixture.CodeOf(fx.Run(ExecFx.Create, 'acme.Nope')), ErrorCodes.InvalidParams)
            assert.equal(await ExecFixture.CodeOf(fx.Run(ExecFx.Create, ExecFx.SolutionName)), ErrorCodes.InvalidParams)
        })
    })

    test('expectedRevision mismatch is Conflict "graph revision has advanced"; a matching one applies', async () =>
    {
        await ExecFx.With({}, async fx =>
        {
            const source = fx.Source()
            const stale = await fx.Run(ExecFx.Create, ExecFx.Model, fx.Lang.GraphRevision + 1)
            assert.equal(stale.status, AppWriteStatus.Conflict)
            assert.equal(stale.reason, 'graph revision has advanced')
            assert.equal(fx.Source(), source)
            const current = await fx.Run(ExecFx.Create, ExecFx.Model, fx.Lang.GraphRevision)
            assert.equal(current.status, AppWriteStatus.Applied)
        })
    })

    test('stale sources give Conflict', async () =>
    {
        // two models in one file, both written by one commit: the second draft finds the file changed under it
        await ExecFx.With({ files: { [ExecFx.SharedFile]: ExecFx.Shared } }, async fx =>
        {
            const source = fx.Source()
            const result = await fx.Run(ExecFx.SetBoth)
            assert.equal(result.status, AppWriteStatus.Conflict)
            assert.equal(result.reason, ExecFx.SourcesChanged)
            assert.deepEqual(result.counts, ExecFx.ZeroCounts)
            assert.equal(fx.Source(), source)
        })
    })

    test('an engine ConflictError (a commit racing an upgrade) is retried once and then applies', async () =>
    {
        let conflicting: ConflictingHost | undefined
        await ExecFx.With({ host: host => (conflicting = new ConflictingHost(host, 1)) }, async fx =>
        {
            const result = await fx.Run(ExecFx.Create)
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.equal(conflicting!.Commits, 2)
            assert.equal(fx.File().split('fresh').length - 1, 1, 'the node lands once')
        })
    })

    test('an engine ConflictError on the retry too is Conflict', async () =>
    {
        let conflicting: ConflictingHost | undefined
        await ExecFx.With({ host: host => (conflicting = new ConflictingHost(host, 2)) }, async fx =>
        {
            const source = fx.Source()
            const result = await fx.Run(ExecFx.Create)
            assert.equal(result.status, AppWriteStatus.Conflict)
            assert.equal(result.reason, ExecFx.SourcesChanged)
            assert.equal(conflicting!.Commits, 2)
            assert.equal(fx.Source(), source)
        })
    })

    test('a syntax error is InvalidParams; an invalid write is in-band Invalid', async () =>
    {
        await ExecFx.With({}, async fx =>
        {
            assert.equal(await ExecFixture.CodeOf(fx.Run('CREAT ((')), ErrorCodes.InvalidParams)
            const source = fx.Source()
            const result = await fx.Run("CREATE (:Widget {nope: 'x'})")
            assert.equal(result.status, AppWriteStatus.Invalid)
            assert.equal(result.reason, 'the write is not valid against the model')
            assert.equal(fx.Source(), source)
        })
    })

    test('RETURN rows of a write come back as node cells', async () =>
    {
        await ExecFx.With({}, async fx =>
        {
            const result = await fx.Run("MATCH (w:Widget {label: 'mine'}) SET w.code = 'C' RETURN w")
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.equal(result.counts.propertiesSet, 1)
            const cell = CypherCells.AsNode(result.rows[0]![0])!
            assert.equal(cell.fields['code']!.value, 'C')
        })
    })
})

describe('DevCypherExecute scope (ported from host/cypher/tests/authorizing-cypher-writer.test.ts as scope cases)', () =>
{
    const Read = [PrivilegeAction.Read, AccessLevel.Organization] as [PrivilegeAction, AccessLevel]

    test('a denied Create is Denied and nothing is written', async () =>
    {
        await ExecFx.With({ model: ExecFx.Security([Read]) }, async fx =>
        {
            const source = fx.Source()
            const result = await fx.Run(ExecFx.Create)
            assert.equal(result.status, AppWriteStatus.Denied)
            assert.deepEqual(result.counts, ExecFx.ZeroCounts)
            assert.equal(fx.Source(), source)
        })
    })

    test('read-only field write is Denied, source unchanged', async () =>
    {
        const all: [PrivilegeAction, AccessLevel][] = [Read, [PrivilegeAction.Create, AccessLevel.Organization], [PrivilegeAction.Update, AccessLevel.Organization]]
        await ExecFx.With({ model: ExecFx.Security(all, DevScopeFx.Fields([DevScopeFx.Secret], [{ field: DevScopeFx.Secret, read: true }])) }, async fx =>
        {
            const source = fx.Source()
            for (const write of ["CREATE (:Widget {label: 'fresh', secret: 'x'})", "MATCH (w:Widget {label: 'mine'}) SET w.secret = 'x'", "MATCH (w:Widget {label: 'mine'}) REMOVE w.secret"])
            {
                const result = await fx.Run(write)
                assert.equal(result.status, AppWriteStatus.Denied, write)
                assert.equal(fx.Source(), source, write)
            }
            assert.equal((await fx.Run("MATCH (w:Widget {label: 'mine'}) SET w.code = 'x'")).status, AppWriteStatus.Applied, 'an unsecured member stays writable')
        })
    })

    test('write to an instance outside the scope is Denied', async () =>
    {
        // w2 (root) is readable at Organization level but updatable only at BusinessUnit level (p1 reaches sales, north)
        const update: [PrivilegeAction, AccessLevel][] = [Read, [PrivilegeAction.Update, AccessLevel.BusinessUnit]]
        await ExecFx.With({ model: ExecFx.Security(update) }, async fx =>
        {
            const source = fx.Source()
            const result = await fx.Run("MATCH (w:Widget {label: 'theirs'}) SET w.code = 'x'")
            assert.equal(result.status, AppWriteStatus.Denied)
            assert.equal(fx.Source(), source)
            assert.equal((await fx.Run("MATCH (w:Widget {label: 'mine'}) SET w.code = 'x'")).status, AppWriteStatus.Applied, 'an instance inside the scope is writable')
        })
    })

    test('a SET on a read-hidden node writes nothing and leaks no value (writes see only visible nodes)', async () =>
    {
        const bu: [PrivilegeAction, AccessLevel][] = [[PrivilegeAction.Read, AccessLevel.BusinessUnit], [PrivilegeAction.Update, AccessLevel.Organization]]
        await ExecFx.With({ model: ExecFx.Security(bu) }, async fx =>
        {
            const source = fx.Source()
            const result = await fx.Run("MATCH (w:Widget {label: 'theirs'}) SET w.secret = 'TOPSECRET'")
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.deepEqual(result.counts, ExecFx.ZeroCounts)
            assert.ok(!JSON.stringify(result).includes('TOPSECRET'))
            assert.equal(fx.Source(), source)
        })
    })

    test('a relationship to a hidden target is not made; to a visible target it is', async () =>
    {
        const bu: [PrivilegeAction, AccessLevel][] = [[PrivilegeAction.Read, AccessLevel.BusinessUnit], [PrivilegeAction.Create, AccessLevel.BusinessUnit], [PrivilegeAction.Update, AccessLevel.BusinessUnit]]
        await ExecFx.With({ model: ExecFx.Security(bu) }, async fx =>
        {
            const source = fx.Source()
            const hidden = await fx.Run("MATCH (a:Widget {label: 'mine'}), (b:Widget {label: 'theirs'}) CREATE (a)-[:buddy]->(b)")
            assert.deepEqual(hidden.counts, ExecFx.ZeroCounts)
            assert.equal(fx.Source(), source)
            const visible = await fx.Run("MATCH (a:Widget {label: 'mine'}) CREATE (a)-[:buddy]->(:Widget {label: 'fresh'})")
            assert.equal(visible.status, AppWriteStatus.Applied)
            assert.equal(visible.counts.relationshipsCreated, 1)
        })
    })

    test('a SET on a node CREATEd earlier in the query is judged against the create', async () =>
    {
        // no Update privilege at all: the created node's own write is part of its create
        const create: [PrivilegeAction, AccessLevel][] = [Read, [PrivilegeAction.Create, AccessLevel.BusinessUnit]]
        await ExecFx.With({ model: ExecFx.Security(create) }, async fx =>
        {
            const result = await fx.Run("CREATE (w:Widget {label: 'fresh'}) SET w.code = 'X'")
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.match(fx.File(), /code = "X"/)
        })
    })

    // Legacy: Denied (the created node's SET was an Update the field gate refused). The engine judges every write to a
    // node created in the same batch as part of its create (Create rules on end-of-batch values, ReadOnly.Create),
    // so a member read-only on update only is writable there. Reported as a behaviour change (task-7-report.md).
    test('a SET of a member read-only on update only, on a node CREATEd earlier in the query, is part of the create', async () =>
    {
        const all: [PrivilegeAction, AccessLevel][] = [Read, [PrivilegeAction.Create, AccessLevel.Organization], [PrivilegeAction.Update, AccessLevel.Organization]]
        const fields = DevScopeFx.Fields([DevScopeFx.Secret], [{ field: DevScopeFx.Secret, read: true, create: true }])
        await ExecFx.With({ model: ExecFx.Security(all, fields) }, async fx =>
        {
            const source = fx.Source()
            assert.equal((await fx.Run("CREATE (:Widget {label: 'fresh', secret: 'x'})")).status, AppWriteStatus.Applied, 'create-writable on create')
            const after = fx.Source()
            assert.notEqual(after, source)
            const result = await fx.Run("CREATE (w:Widget {label: 'later'}) SET w.secret = 'x'")
            assert.equal(result.status, AppWriteStatus.Applied)
            assert.match(fx.File(), /label = "later"/)
            const update = await fx.Run("MATCH (w:Widget {label: 'later'}) SET w.secret = 'y'")
            assert.equal(update.status, AppWriteStatus.Denied, 'an update of an existing node is refused')
            assert.doesNotMatch(fx.File(), /secret = "y"/)
        })
    })

    test('a relationship whose source the scope may not update is Denied', async () =>
    {
        await ExecFx.With({ model: ExecFx.Security([Read]) }, async fx =>
        {
            const source = fx.Source()
            const result = await fx.Run("MATCH (a:Widget {label: 'mine'}), (b:Widget {label: 'theirs'}) CREATE (a)-[:buddy]->(b)")
            assert.equal(result.status, AppWriteStatus.Denied)
            assert.equal(fx.Source(), source)
        })
    })

    test('a delete the scope does not allow is Denied', async () =>
    {
        const update: [PrivilegeAction, AccessLevel][] = [Read, [PrivilegeAction.Update, AccessLevel.Organization]]
        await ExecFx.With({ model: ExecFx.Security(update) }, async fx =>
        {
            const source = fx.Source()
            const result = await fx.Run("MATCH (w:Widget {label: 'mine'}) DETACH DELETE w")
            assert.equal(result.status, AppWriteStatus.Denied)
            assert.equal(fx.Source(), source)
        })
    })

    test('create stamps owner defaults', async () =>
    {
        // Create at BusinessUnit level holds only through the stamped owning unit (p1's home unit, sales)
        const create: [PrivilegeAction, AccessLevel][] = [Read, [PrivilegeAction.Create, AccessLevel.BusinessUnit]]
        await ExecFx.With({ model: ExecFx.Security(create) }, async fx =>
        {
            const result = await fx.Run("CREATE (w:Widget {label: 'fresh'}) RETURN w")
            assert.equal(result.status, AppWriteStatus.Applied)
            const cell = CypherCells.AsNode(result.rows[0]![0])!
            assert.equal(cell.fields[DevScopeFx.OwningBu]!.value, DevScopeFx.Sales)
            assert.equal(cell.fields[DevScopeFx.Owner]!.value, DevScopeFx.P1)
            assert.match(fx.File(), /owningBu = "sales"/)
            assert.match(fx.File(), /owner = "p1"/)
        })
    })

    test('no identity: every write is open (create, set, remove, delete)', async () =>
    {
        await ExecFx.With({}, async fx =>
        {
            assert.equal((await fx.Run(ExecFx.Create)).status, AppWriteStatus.Applied)
            assert.equal((await fx.Run("MATCH (w:Widget {label: 'theirs'}) SET w.code = 'x'")).status, AppWriteStatus.Applied)
            assert.equal((await fx.Run("MATCH (w:Widget {label: 'mine'}) REMOVE w.secret")).status, AppWriteStatus.Applied)
            assert.equal((await fx.Run("MATCH (w:Widget {label: 'fresh'}) DETACH DELETE w")).status, AppWriteStatus.Applied)
            assert.doesNotMatch(fx.File(), /fresh/)
            assert.doesNotMatch(fx.File(), new RegExp(ExecFx.Secret))
            assert.match(fx.File(), /code = "x"/)
        })
    })

    test('a read-only reference member is blocked for edge CREATE and DELETE, matching SET', async () =>
    {
        const all: [PrivilegeAction, AccessLevel][] = [Read, [PrivilegeAction.Create, AccessLevel.Organization], [PrivilegeAction.Update, AccessLevel.Organization]]
        await ExecFx.With({ model: ExecFx.Security(all, DevScopeFx.Fields(['peer'], [{ field: 'peer', read: true }])) }, async fx =>
        {
            const source = fx.Source()
            for (const write of [
                "MATCH (a:Widget {label: 'theirs'}), (b:Widget {label: 'mine'}) SET a.peer = b",
                "MATCH (a:Widget {label: 'theirs'}), (b:Widget {label: 'mine'}) CREATE (a)-[:peer]->(b)",
                // the engine deletes an edge through its member (a relationship variable is no write target)
                "MATCH (a:Widget {label: 'mine'}) REMOVE a.peer",
            ])
            {
                assert.equal((await fx.Run(write)).status, AppWriteStatus.Denied, write)
                assert.equal(fx.Source(), source, write)
            }
            const other = await fx.Run("MATCH (a:Widget {label: 'mine'}), (b:Widget {label: 'theirs'}) CREATE (a)-[:buddy]->(b)")
            assert.equal(other.status, AppWriteStatus.Applied, 'another member stays linkable')
        })
    })
})
