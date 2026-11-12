import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AccessScope, ConnectorContext, Cypher, GraphEngine, StorageKind } from '@pragmatic-tech-ai/graph'
import type { ISchemaDescription, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { TodlFileConnector, TodlNodePlacement } from '@pragmatic-tech-ai/todl/engine'
import { Disposable } from '@pragmatic-tech-ai/todl-runtime'
import { CursorStaleError, CypherCells, ErrorCodes, PageCursorCodec, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherCellDto, CypherParamValue, CypherQueryPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Grant, Principal, PrincipalKind, ResourceAuthorizationPolicy, ResourceKind, ResourceRef, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import { CypherLimits } from '../../../config/cypher-limits.js'
import { PagingLimits } from '../../../config/paging-limits.js'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { PpSecurityHarness } from '../../cypher/tests/pp-security-harness.js'
import { CypherParamConverter } from '../../cypher/cypher-param-converter.js'
import { EngineCypherQuery } from '../engine-cypher-query.js'
import type { IDevCypherRequest } from '../engine-cypher-query.js'
import type { IGraphScope } from '../access-scope-source.js'
import { DevSnapshotSource } from '../dev-snapshot-source.js'
import type { IEngineSnapshot, IGraphEngineHost } from '../graph-engine-host.js'
import { ServerModelWorkspace } from '../server-model-workspace.js'
import { EngineHostFx, HeldFence } from './engine-host-fixture.js'

/** What one dev query asks beyond its text. */
interface IQueryOptions
{
    readonly modelId?: string
    readonly parameters?: { [name: string]: CypherParamValue }
    readonly pageSize?: number
    readonly cursor?: string
}

/** A started dev server over a copy of the sample solution whose model file holds the test's TODL. */
class DevCypherWorld
{
    public constructor(public readonly Server: PragmaticServer, private readonly solution: string | undefined)
    {
    }

    /** One cypher/query on the dev engine, as the connection handler sends it (default limits). */
    public Run(context: AccessContext, source: string, options: IQueryOptions = {}): Promise<CypherQueryPageDto>
    {
        const limits = new CypherLimits()
        const request: IDevCypherRequest = {
            Source: source,
            Parameters: CypherParamConverter.ToMap(options.parameters),
            CanonicalParameters: CypherParamConverter.Canonical(options.parameters),
            ...(options.modelId === undefined ? {} : { ModelId: options.modelId }),
            Page: { Params: { pageSize: options.pageSize, cursor: options.cursor }, Limits: new PagingLimits(), RowCap: limits.RowCap },
            TimeoutMs: limits.TimeoutMs,
            MaxVarLength: limits.MaxVarLength,
        }
        return this.Server.DevCypher().Run(context, request)
    }

    /** The first column of every row, sorted (a non-string cell reads as ''). */
    public async Column(context: AccessContext, source: string, options: IQueryOptions = {}): Promise<string[]>
    {
        const page = await this.Run(context, source, options)
        return page.items.map(row => (typeof row[0] === 'string' ? row[0] : '')).sort()
    }

    /** Walks every page of `source` at `pageSize`, returning each page's rows (first cells). */
    public async Walk(context: AccessContext, source: string, pageSize: number): Promise<unknown[][]>
    {
        const pages: unknown[][] = []
        let cursor: string | undefined
        do
        {
            const page = await this.Run(context, source, { pageSize, ...(cursor === undefined ? {} : { cursor }) })
            pages.push(page.items.map(row => row[0]))
            cursor = page.nextCursor
        }
        while (cursor !== undefined)
        return pages
    }

    public async Count(context: AccessContext, source: string, options: IQueryOptions = {}): Promise<number>
    {
        const page = await this.Run(context, source, options)
        return page.items[0]![0] as number
    }

    /** Saves `text` as the model file (the engine runs from saved sources) and tells the language service of the edit. */
    public async Save(text: string): Promise<void>
    {
        const manager = await this.Server.Manager()
        const member = [...manager.ActiveSolution!.Members].find(m => m.Storage !== undefined)!
        const uri = `${member.Storage!.Root}/${DevCypherFx.ModelFileName}`
        writeFileSync(uri, text)
        const language = await this.Server.LanguageService() as SolutionLanguageService
        language.DidChange(uri, text)
        await language.WhenIdle()
    }

    public async SchemaVersion(): Promise<string>
    {
        return (await this.Server.DevEngine().Engine()).SchemaVersion
    }

    /** Waits (bounded) until the dev engine has upgraded away from `version`. */
    public async Upgraded(version: string): Promise<void>
    {
        for (let waited = 0; waited < DevCypherFx.UpgradeWaitMs; waited += DevCypherFx.PollMs)
        {
            if (await this.SchemaVersion() !== version) return
            await delay(DevCypherFx.PollMs)
        }
        assert.fail(DevCypherFx.NoUpgradeMessage)
    }

    public async Dispose(): Promise<void>
    {
        if (this.solution !== undefined)
        {
            await (await this.Server.LanguageService() as SolutionLanguageService).WhenIdle()
            await (await this.Server.Manager()).CloseSolution()
        }
        await this.Server.Dispose()
    }
}

class DevCypherFx
{
    public static readonly ModelFileName = 'model.todl'
    public static readonly ModelsDir = 'models'
    public static readonly UpgradeWaitMs = 10000
    public static readonly PollMs = 25
    public static readonly NoUpgradeMessage = 'the dev engine never upgraded to the saved edit'
    public static readonly Namespace = 'acme'
    public static readonly Widget = 'acme.Widget'
    public static readonly ModelA = 'acme.ShopA'
    public static readonly ModelB = 'acme.ShopB'
    public static readonly Plain = 'p1'
    public static readonly ViewerId = 'u1'
    public static readonly TenantName = 'Tenant One'
    public static readonly Secret = 'hush'
    public static readonly UnknownModel = 'acme.Nope'
    /** The sample solution's name: its package owns what lies outside every model. */
    public static readonly SolutionName = 'Sample'
    public static readonly Alpha = 'alpha'
    public static readonly Kinds = 'kinds'
    public static readonly Term = 'todl.Term'
    public static readonly EmptyModel = 'acme.Empty'
    public static readonly ModelC = 'acme.ShopC'
    public static readonly AlphaNode = "MATCH (w:Widget {label: 'alpha'}) RETURN w"
    public static readonly Overflow = 'RETURN 9223372036854775807 + 1 AS v'
    public static readonly CountAll = 'MATCH (x) RETURN count(x) AS c'
    public static readonly NodeAll = 'MATCH (n) RETURN n'
    public static readonly WidgetLabels = 'MATCH (w:Widget) RETURN w.label AS l'
    public static readonly OrderedLabels = 'MATCH (w:Widget) RETURN w.label AS l ORDER BY l'
    public static readonly PeerTargets = 'MATCH (a)-[:peer]->(b) RETURN b.label AS l'
    public static readonly SecretColumn = 'MATCH (w:Widget) RETURN w.secret AS s'
    public static readonly SecretWhere = "MATCH (w:Widget) WHERE w.secret = 'hush' RETURN w.label AS l"
    public static readonly WidgetNodes = 'MATCH (w:Widget) RETURN w'
    /** Ordered by an expression that is no returned column (the engine refuses ORDER BY over an unreturned `w.rank`). */
    public static readonly RankOrdered = 'MATCH (w:Widget) RETURN w.label AS l, w.rank AS r ORDER BY r + 0'
    public static readonly ManyCount = 25
    public static readonly PageSize = 10
    public static readonly KeySeparator = '\u0000'
    private static readonly SolutionPrefix = 'dcq-sol-'
    private static readonly PackagesPrefix = 'dcq-pkgs-'

    /** Opens a solution holding `modelTodl` (none: no solution is opened), with identity and `model` seeded when given. */
    /** A dev server over a solution holding `modelTodl` (none: no solution open); the dev scope is unrestricted (PR13). */
    public static async With(modelTodl: string | undefined, body: (world: DevCypherWorld) => Promise<void>): Promise<void>
    {
        const solution = modelTodl === undefined ? undefined : mkdtempSync(join(tmpdir(), DevCypherFx.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), DevCypherFx.PackagesPrefix))
        if (solution !== undefined)
        {
            cpSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
            writeFileSync(join(solution, DevCypherFx.ModelsDir, DevCypherFx.ModelFileName), modelTodl!)
        }
        const server = new PragmaticServer({ packagesRoot: packages })
        const world = new DevCypherWorld(server, solution)
        try
        {
            await server.Start()
            if (solution !== undefined) await server.OpenSolution(solution)
            if (solution !== undefined) await (await server.LanguageService() as SolutionLanguageService).WhenIdle()
            await body(world)
        }
        finally
        {
            await world.Dispose()
            if (solution !== undefined) rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
        }
    }

    /** The tenant owner (no identity subsystem: depth does not apply). */
    public static Permissive(): AccessContext
    {
        return DevCypherFx.ContextOf(DevCypherFx.Plain, Role.Owner)
    }

    public static Viewer(): AccessContext
    {
        return DevCypherFx.ContextOf(DevCypherFx.ViewerId, Role.Viewer)
    }

    private static ContextOf(principalId: string, role: Role): AccessContext
    {
        const tenant = new Tenant(PpSecurityHarness.TenantId, TenantKind.SelfHosted, DevCypherFx.TenantName)
        const principal = new Principal(principalId, PpSecurityHarness.TenantId, PrincipalKind.User, new Map(), [])
        return new AccessContext(principal, tenant, [new Grant(principalId, role, new ResourceRef(ResourceKind.Tenant, PpSecurityHarness.TenantId, []))], new ResourceAuthorizationPolicy())
    }

    /** Two models: ShopA (a1 sales "alpha", a2 root "beta", a1 peer -> b1) and ShopB (b1 sales "gamma"). */
    public static TwoModels(): string
    {
        const bu = PpSecurityHarness.OwningBuField
        const sales = PpSecurityHarness.SalesBu
        const root = PpSecurityHarness.RootBu
        return `namespace acme { concept Widget { ${bu} : string?; secret : string?; relationship peer -> Widget?; } `
            + `model ShopA : acme { Widget a1 { ${bu} = "${sales}"; label = "alpha"; secret = "${DevCypherFx.Secret}"; peer = b1; } Widget a2 { ${bu} = "${root}"; label = "beta"; } } `
            + `model ShopB : acme { Widget b1 { ${bu} = "${sales}"; label = "gamma"; } } }`
    }

    public static readonly TwoWidgets = 'namespace acme { concept Widget { } model Shop : acme { Widget w1 {} Widget w2 {} } }'
    /** ShopA (alpha classified Big and Small through a many-valued taxonomy field), ShopB, and the empty model ShopC. */
    public static readonly Taxonomy = 'namespace acme { concept Widget { kinds : Kinds[]; } taxonomy Kinds : represents Widget { term Big { } term Small { } } '
        + 'model ShopA : acme { Widget a1 { label = "alpha"; kinds = [Big, Small]; } } model ShopB : acme { Widget b1 { label = "gamma"; } } model ShopC : acme { } }'
    public static readonly Three = 'namespace acme { concept Widget { } model Shop : acme { Widget w1 { label = "a"; } Widget w2 { label = "b"; } Widget w3 { label = "c"; } } }'
    /** 25 widgets labelled l01..l25 whose rank runs the other way (l01 has rank 25), so rank order is label order reversed. */
    public static Many(): string
    {
        const widgets = Array.from({ length: DevCypherFx.ManyCount }, (_, at) => `Widget w${at + 1} { label = "${DevCypherFx.Label(at + 1)}"; rank = ${DevCypherFx.ManyCount - at}; }`)
        return `namespace acme { concept Widget { rank : integer?; } model Shop : acme { ${widgets.join(' ')} } }`
    }

    public static Label(at: number): string
    {
        return `l${String(at).padStart(2, '0')}`
    }

    public static readonly ThreeEdited = 'namespace acme { concept Widget { } model Shop : acme { Widget w0 { label = "0"; } Widget w1 { label = "a"; } Widget w2 { label = "b"; } Widget w3 { label = "c"; } } }'

    public static Nodes(page: CypherQueryPageDto): NonNullable<ReturnType<typeof CypherCells.AsNode>>[]
    {
        return page.items.map(row => CypherCells.AsNode(row[0] as CypherCellDto)!)
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
        return undefined
    }
}

/** Ported from host/cypher/tests/server-graph-depth.test.ts (server.Graph -> the dev engine). */
class DepthPortFx
{
    public static readonly SalesLabelA = 'alpha'
    public static readonly RootLabel = 'beta'
    public static readonly SalesLabelB = 'gamma'

    public static Model(): string
    {
        const concept = PpSecurityHarness.Concept
        const field = PpSecurityHarness.OwningBuField
        const instances = `${concept} w1 { ${field} = "${PpSecurityHarness.SalesBu}"; label = "${DepthPortFx.SalesLabelA}"; } `
            + `${concept} w2 { ${field} = "${PpSecurityHarness.RootBu}"; label = "${DepthPortFx.RootLabel}"; } `
            + `${concept} w3 { ${field} = "${PpSecurityHarness.SalesBu}"; label = "${DepthPortFx.SalesLabelB}"; }`
        return `namespace ${DevCypherFx.Namespace} { concept ${concept} { ${field} : string?; } model Shop : ${DevCypherFx.Namespace} { ${instances} } }`
    }

    public static get All(): string[]
    {
        return [DepthPortFx.SalesLabelA, DepthPortFx.SalesLabelB, DepthPortFx.RootLabel].sort()
    }


}

/** A subscribe-only signal that never fires: the fixed-schema host never upgrades. */
class SilentSignal implements ISignal<void>
{
    public Subscribe(): ISubscription
    {
        return new Disposable(() => undefined)
    }
}

/** EngineHostFx's saved snapshot on a memory engine no language service upgrades, so commits leave the schema version. */
class FixedSchemaWorld implements IGraphEngineHost
{
    public static readonly OrderedNames = 'MATCH (n:shop.Customer) RETURN n.name AS name ORDER BY name'
    public static readonly CreateAa = "CREATE (n:shop.Customer {name: 'Aa'})"
    private static readonly ScopeDigest = 'system'
    public readonly Changed: ISignal<void> = new SilentSignal()
    private readonly query: EngineCypherQuery

    private constructor(private readonly engine: GraphEngine, private readonly snapshot: IEngineSnapshot)
    {
        const scope: IGraphScope = { Scope: AccessScope.System, Digest: FixedSchemaWorld.ScopeDigest, Connector: ConnectorContext.Anonymous, Placement: () => FixedSchemaWorld.Placement() }
        this.query = new EngineCypherQuery(this, async () => ({ ScopeFor: async () => scope, Dropped: new SilentSignal() }))
    }

    public static async With(body: (world: FixedSchemaWorld) => Promise<void>): Promise<void>
    {
        const fx = new EngineHostFx()
        const snapshot = await new DevSnapshotSource(fx.Source, fx.Lang).Current()
        const workspace = new ServerModelWorkspace(fx.Source, fx.Lang, undefined, undefined, HeldFence.Slot())
        const engine = await GraphEngine.Open({ Description: snapshot.Description, Storage: { Kind: StorageKind.Memory }, Connectors: [new TodlFileConnector(workspace)] })
        try
        {
            await body(new FixedSchemaWorld(engine, snapshot))
        }
        finally
        {
            await engine.dispose()
        }
    }

    public async Engine(): Promise<GraphEngine>
    {
        return this.engine
    }

    public async Snapshot(): Promise<IEngineSnapshot>
    {
        return this.snapshot
    }

    public ResetConnectors(): void
    {
    }

    public async Description(): Promise<ISchemaDescription>
    {
        return this.snapshot.Description
    }

    public Run(source: string, pageSize: number, cursor?: string): Promise<CypherQueryPageDto>
    {
        const limits = new CypherLimits()
        return this.query.Run(DevCypherFx.Permissive(), {
            Source: source,
            Parameters: new Map(),
            CanonicalParameters: CypherParamConverter.Canonical(undefined),
            Page: { Params: { pageSize, cursor }, Limits: new PagingLimits(), RowCap: limits.RowCap },
            TimeoutMs: limits.TimeoutMs,
            MaxVarLength: limits.MaxVarLength,
        })
    }

    /** Runs a write on the engine (placed in shop.M) and returns its commit. */
    public async Commit(source: string): Promise<bigint>
    {
        const result = await new Cypher.CypherEngine(this.engine).Execute(AccessScope.System, source, { Placement: FixedSchemaWorld.Placement() })
        return result.Commit!
    }

    private static Placement(): Cypher.INodePlacement
    {
        return new TodlNodePlacement(EngineHostFx.ModelM, EngineHostFx.Namespace)
    }
}

// ── ported from host/cypher/tests/server-graph.test.ts ─────────────────────────────────────────────

test('the dev graph with no solution open is an empty graph, not an error', async () =>
{
    await DevCypherFx.With(undefined, async world =>
    {
        assert.equal(await world.Count(DevCypherFx.Permissive(), DevCypherFx.CountAll), 0)
    })
})

test('the dev graph composes the open solution into a queryable graph', async () =>
{
    await DevCypherFx.With(DevCypherFx.TwoWidgets, async world =>
    {
        assert.equal(await world.Count(DevCypherFx.Permissive(), DevCypherFx.CountAll), 2)
    })
})

// ── ported from host/cypher/tests/server-graph-depth.test.ts ───────────────────────────────────────

test('state 3: an identity-less dev server returns every widget (depth inactive)', async () =>
{
    await DevCypherFx.With(DepthPortFx.Model(), async world =>
    {
        assert.deepEqual(await world.Column(PpSecurityHarness.Context(DevCypherFx.Plain), DevCypherFx.WidgetLabels), DepthPortFx.All)
    })
})

// ── engine-path behaviour ──────────────────────────────────────────────────────────────────────────

test('modelId scopes to that model\'s instances', async () =>
{
    await DevCypherFx.With(DevCypherFx.TwoModels(), async world =>
    {
        const context = DevCypherFx.Permissive()
        assert.deepEqual(await world.Server.DevCypher().Models(), [DevCypherFx.ModelA, DevCypherFx.ModelB])
        assert.deepEqual(await world.Column(context, DevCypherFx.WidgetLabels), ['alpha', 'beta', 'gamma'])
        assert.deepEqual(await world.Column(context, DevCypherFx.WidgetLabels, { modelId: DevCypherFx.ModelA }), ['alpha', 'beta'])
        assert.deepEqual(await world.Column(context, DevCypherFx.WidgetLabels, { modelId: DevCypherFx.ModelB }), ['gamma'])
        // the model filter applies to every node, not only the queried label: nothing outside the model is counted or reached
        assert.equal(await world.Count(context, DevCypherFx.CountAll, { modelId: DevCypherFx.ModelA }), 2)
        assert.deepEqual(await world.Column(context, DevCypherFx.PeerTargets), ['gamma'])
        assert.deepEqual(await world.Column(context, DevCypherFx.PeerTargets, { modelId: DevCypherFx.ModelA }), [])
        assert.equal(await DevCypherFx.CodeOf(world.Run(context, DevCypherFx.WidgetLabels, { modelId: DevCypherFx.UnknownModel })), ErrorCodes.InvalidParams)
        assert.equal(await DevCypherFx.CodeOf(world.Run(context, DevCypherFx.WidgetLabels, { modelId: DevCypherFx.SolutionName })), ErrorCodes.InvalidParams, 'the solution package is no model')
    })
})

test('upgrade between pages stales the cursor', async () =>
{
    await DevCypherFx.With(DevCypherFx.Three, async world =>
    {
        const context = DevCypherFx.Permissive()
        const first = await world.Run(context, DevCypherFx.OrderedLabels, { pageSize: 1 })
        assert.deepEqual(first.items, [['a']])
        assert.ok(first.nextCursor !== undefined)
        const still = await world.Run(context, DevCypherFx.OrderedLabels, { pageSize: 1, cursor: first.nextCursor })
        assert.deepEqual(still.items, [['b']], 'an unchanged engine continues the walk')
        const version = await world.SchemaVersion()
        await world.Save(DevCypherFx.ThreeEdited)
        await world.Upgraded(version)
        assert.equal(await DevCypherFx.CodeOf(world.Run(context, DevCypherFx.OrderedLabels, { pageSize: 1, cursor: first.nextCursor })), CursorStaleError.Code)
        assert.deepEqual((await world.Run(context, DevCypherFx.OrderedLabels, { pageSize: 1 })).items, [['0']], 'a fresh walk reads the upgraded graph')
    })
})

test('pages concatenate to the full result', async () =>
{
    await DevCypherFx.With(DevCypherFx.Many(), async world =>
    {
        const context = DevCypherFx.Permissive()
        const pages = await world.Walk(context, DevCypherFx.OrderedLabels, DevCypherFx.PageSize)
        assert.deepEqual(pages.map(page => page.length), [10, 10, 5])
        assert.deepEqual(pages.flat(), (await world.Run(context, DevCypherFx.OrderedLabels)).items.map(row => row[0]))
    })
})

test('order by a non-returned expression pages by offset', async () =>
{
    await DevCypherFx.With(DevCypherFx.Many(), async world =>
    {
        const context = DevCypherFx.Permissive()
        const first = await world.Run(context, DevCypherFx.RankOrdered, { pageSize: DevCypherFx.PageSize })
        const wire = PageCursorCodec.Decode(first.nextCursor!)!
        assert.equal(wire.offset, DevCypherFx.PageSize, 'the engine gave no keyset cursor: page 2 runs with Skip 10 (Q10)')
        assert.ok(!wire.fingerprint.includes(DevCypherFx.KeySeparator), 'an offset cursor carries no Cypher cursor')
        const pages = await world.Walk(context, DevCypherFx.RankOrdered, DevCypherFx.PageSize)
        const reversed = Array.from({ length: DevCypherFx.ManyCount }, (_, at) => DevCypherFx.Label(DevCypherFx.ManyCount - at))
        assert.deepEqual(pages.flat(), reversed)
    })
})

test('a query with writes is refused by EngineCypherQuery itself and commits nothing', async () =>
{
    await FixedSchemaWorld.With(async world =>
    {
        await assert.rejects(() => world.Run(FixedSchemaWorld.CreateAa, 10), (error: unknown) =>
            error instanceof ResponseError && error.code === ErrorCodes.InvalidParams && error.message === EngineCypherQuery.ReadEndpointWriteMessage)
        assert.deepEqual((await world.Run(FixedSchemaWorld.OrderedNames, 10)).items, [['Ada'], ['Bo']], 'the create never ran')
    })
})

test('commit between pages neither repeats nor skips', async () =>
{
    // a host whose schema stays put across commits (as the runtime environment engine): on dev every write saves the
    // sources and upgrades the engine, which stales a cursor by design
    await FixedSchemaWorld.With(async world =>
    {
        const first = await world.Run(FixedSchemaWorld.OrderedNames, 1)
        assert.deepEqual(first.items, [['Ada']])
        // a create that sorts before the cursor commits between the pages
        assert.ok(await world.Commit(FixedSchemaWorld.CreateAa) > 0n)
        assert.deepEqual((await world.Run(FixedSchemaWorld.OrderedNames, 10)).items, [['Aa'], ['Ada'], ['Bo']], 'the commit is visible')
        const second = await world.Run(FixedSchemaWorld.OrderedNames, 1, first.nextCursor)
        assert.deepEqual(second.items, [['Bo']], 'page 2 starts exactly after page 1\'s last row')
        assert.equal(second.nextCursor, undefined)
    })
})

test('no solution open returns no rows', async () =>
{
    await DevCypherFx.With(undefined, async world =>
    {
        const page = await world.Run(DevCypherFx.Permissive(), DevCypherFx.NodeAll)
        assert.deepEqual(page.items, [])
        assert.equal(page.truncated, false)
        assert.equal(page.nextCursor, undefined)
        assert.deepEqual(await world.Server.DevCypher().Models(), [])
        assert.equal(await DevCypherFx.CodeOf(world.Run(DevCypherFx.Permissive(), DevCypherFx.NodeAll, { modelId: DevCypherFx.ModelA })), ErrorCodes.InvalidParams)
    })
})

test('an empty model is listed and a query scoped to it returns an empty page', async () =>
{
    await DevCypherFx.With(DevCypherFx.Taxonomy, async world =>
    {
        assert.deepEqual(await world.Server.DevCypher().Models(), [DevCypherFx.ModelA, DevCypherFx.ModelB, DevCypherFx.ModelC])
        const page = await world.Run(DevCypherFx.Permissive(), DevCypherFx.WidgetLabels, { modelId: DevCypherFx.ModelC })
        assert.deepEqual(page.items, [])
        assert.equal(page.nextCursor, undefined)
    })
})

test('model-scoped node cells keep many-valued taxonomy refs', async () =>
{
    await DevCypherFx.With(DevCypherFx.Taxonomy, async world =>
    {
        const context = DevCypherFx.Permissive()
        const wide = DevCypherFx.Nodes(await world.Run(context, DevCypherFx.AlphaNode))[0]!
        const scoped = DevCypherFx.Nodes(await world.Run(context, DevCypherFx.AlphaNode, { modelId: DevCypherFx.ModelA }))[0]!
        assert.equal(wide.refs[DevCypherFx.Kinds]?.length, 2)
        assert.deepEqual(scoped.refs, wide.refs)
    })
})

test('tenant-wide MATCH (n) also returns the taxonomy terms as todl.Term nodes (ruling T6-c)', async () =>
{
    await DevCypherFx.With(DevCypherFx.Taxonomy, async world =>
    {
        const context = DevCypherFx.Permissive()
        const terms = DevCypherFx.Nodes(await world.Run(context, DevCypherFx.NodeAll)).filter(node => node.concept === DevCypherFx.Term)
        assert.equal(terms.length, 2)
        const scoped = DevCypherFx.Nodes(await world.Run(context, DevCypherFx.NodeAll, { modelId: DevCypherFx.ModelA })).filter(node => node.concept === DevCypherFx.Term)
        assert.equal(scoped.length, 2, 'a model scope leaves the terms to the caller scope (ruling T6-b)')
    })
})

test('a tenant-wide cursor is stale for another principal', async () =>
{
    await DevCypherFx.With(DevCypherFx.Three, async world =>
    {
        const first = await world.Run(DevCypherFx.Permissive(), DevCypherFx.OrderedLabels, { pageSize: 1 })
        assert.ok(first.nextCursor !== undefined)
        assert.equal(await DevCypherFx.CodeOf(world.Run(DevCypherFx.Viewer(), DevCypherFx.OrderedLabels, { pageSize: 1, cursor: first.nextCursor })), CursorStaleError.Code)
    })
})

test('an integer overflow is InvalidParams', async () =>
{
    await DevCypherFx.With(DevCypherFx.Three, async world =>
    {
        assert.equal(await DevCypherFx.CodeOf(world.Run(DevCypherFx.Permissive(), DevCypherFx.Overflow)), ErrorCodes.InvalidParams)
    })
})
