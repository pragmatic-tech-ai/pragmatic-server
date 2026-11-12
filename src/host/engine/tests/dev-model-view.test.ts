import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { CursorStaleError, ErrorCodes, InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ModelMemberDto, ModelViewPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EdgeKind, Repository } from '@pragmatic-tech-ai/todl'
import type { Edge, SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Grant, Principal, PrincipalKind, ResourceAuthorizationPolicy, ResourceKind, ResourceRef, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import { PagingLimits } from '../../../config/paging-limits.js'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { PpSecurityHarness } from '../../cypher/tests/pp-security-harness.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'
import { DevModelView } from '../dev-model-view.js'
import type { IDevModelResource, IDevModelStructure, IDevModelViewDiagnostics } from '../dev-model-view.js'
import type { IGraphModelView } from '../graph-model-view.js'
import type { IGraphScope, IGraphScopeSource } from '../access-scope-source.js'

/**
 * Ported from host/tests/model-read-filter.test.ts, model-view-paging.test.ts and model-surface.test.ts: the dev
 * model/view now takes instance visibility and masking from the caller's engine scope. The unit ports keep their
 * in-memory structure (FixedStructure) and run the visibility on the dev engine over an equivalent SAVED solution
 * (same ids, same values; the dev scope is unrestricted, PR13); the wire ports run
 * the real language service through a handler attached with the development arguments.
 */

/** The language-service slice served from one in-memory repository (the unit ports' structure, as the originals built it). */
class FixedStructure implements IDevModelStructure
{
    public readonly GraphRevision = 1

    public constructor(private readonly model: Repository, private readonly provenance: ReadonlyMap<string, string> = new Map())
    {
    }

    public async ModelView(): Promise<{ model: Repository; provenanceOf: ReadonlyMap<string, string> }>
    {
        return { model: this.model, provenanceOf: this.provenance }
    }

    public async Resources(): Promise<readonly IDevModelResource[]>
    {
        return []
    }
}

/** A Dropped signal that counts its live subscriptions. */
class CountingDropped implements ISignal<void>
{
    public Active = 0
    private readonly signal = new Signal<void>()

    public Subscribe(handler: (value: void) => void): ISubscription
    {
        const inner = this.signal.subscribe(handler)
        this.Active += 1
        let disposed = false
        return { dispose: () =>
        {
            if (disposed) return
            disposed = true
            this.Active -= 1
            inner.dispose()
        } }
    }
}

/** A scope source that delegates to the server's and counts the subscriptions to its Dropped. */
class CountingScopeSource implements IGraphScopeSource
{
    public readonly Dropped = new CountingDropped()

    public constructor(private readonly inner: () => Promise<IGraphScopeSource>)
    {
    }

    public async ScopeFor(context: AccessContext): Promise<IGraphScope>
    {
        return (await this.inner()).ScopeFor(context)
    }
}

/** A repository whose outEdges for one node also yields an edge to a target the model cannot resolve. */
class DanglingEdgeRepository extends Repository
{
    constructor(private readonly from: string, private readonly via: string, private readonly to: string)
    {
        super()
    }

    public override outEdges(id: string): Edge[]
    {
        const edges = super.outEdges(id)
        return id === this.from ? [...edges, { kind: EdgeKind.Relationship, via: this.via, from: this.from, to: this.to }] : edges
    }
}

/** A started dev server over a copy of the sample solution whose model file holds the test's TODL. */
class DevWorld
{
    private static readonly SolutionPrefix = 'dmv-sol-'
    private static readonly PackagesPrefix = 'dmv-pkgs-'
    private static readonly ModelsDir = 'models'
    private static readonly ModelFileName = 'model.todl'
    private static readonly NoConnectors = 'no connectors'
    private static readonly UpgradeWaitMs = 10000
    private static readonly PollMs = 25
    private static readonly NoUpgradeMessage = 'the dev engine never upgraded to the saved edit'

    private readonly connections: { client: PragmaticClient, handler: ServerConnectionHandler }[] = []
    private readonly views: DevModelView[] = []

    private constructor(public readonly Server: PragmaticServer, public readonly Language: SolutionLanguageService, private readonly manager: SolutionManagerService, private readonly solution: string | undefined)
    {
    }

    public get MemberId(): string
    {
        return [...this.manager.ActiveSolution!.Members][0]!.Ref.path
    }

    public get ModelUri(): string
    {
        const member = [...this.manager.ActiveSolution!.Members][0]!
        return `${member.Storage!.Root}/${DevWorld.ModelFileName}`
    }

    /** Opens a solution holding `modelTodl` (none: no solution is opened); the dev scope is unrestricted (PR13). */
    public static With(modelTodl: string | undefined, body: (world: DevWorld) => Promise<void>): Promise<void>
    {
        return DevWorld.Run(modelTodl, body)
    }

    private static async Run(modelTodl: string | undefined, body: (world: DevWorld) => Promise<void>): Promise<void>
    {
        const solution = modelTodl === undefined ? undefined : mkdtempSync(join(tmpdir(), DevWorld.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), DevWorld.PackagesPrefix))
        if (solution !== undefined)
        {
            cpSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
            writeFileSync(join(solution, DevWorld.ModelsDir, DevWorld.ModelFileName), modelTodl!)
        }
        const server = new PragmaticServer({ packagesRoot: packages })
        let world: DevWorld | undefined
        try
        {
            await server.Start()
            if (solution !== undefined) await server.OpenSolution(solution)
            const language = await server.LanguageService() as SolutionLanguageService
            await language.WhenIdle()
            world = new DevWorld(server, language, await server.Manager(), solution)
            await body(world)
        }
        finally
        {
            await world?.Dispose()
            if (world === undefined) await server.Dispose()
            if (solution !== undefined) rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
        }
    }

    /** A client over a handler attached with the server's development arguments, as the hosts attach it. */
    public Connect(context: AccessContext = DevWorld.Owner()): PragmaticClient
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const development = ServerConnectionHandler.DevelopmentAttachArgs(this.Server)
        const handler = ServerConnectionHandler.Attach(serverSocket, this.Language, this.manager, context, undefined, development.cypherQuery,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, development.devGraphService, undefined, development.modelView)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.connections.push({ client, handler })
        return client
    }

    /** A DevModelView on this server's engine and scopes whose structure is `structure` (the unit ports). */
    public View(structure: IDevModelStructure, diagnostics?: IDevModelViewDiagnostics, scopes: () => Promise<IGraphScopeSource> = () => this.Server.DevScopes()): DevModelView
    {
        const view = new DevModelView(this.Server.DevEngine(), scopes, async () => this.manager.ActiveSolution, async () => structure, diagnostics)
        this.views.push(view)
        return view
    }

    /** Saves `text` as the model file (the engine runs from saved sources) and waits for the engine to upgrade to it. */
    public async Save(text: string): Promise<void>
    {
        const engine = await this.Server.DevEngine().Engine()
        const version = engine.SchemaVersion
        writeFileSync(this.ModelUri, text)
        this.Language.DidChange(this.ModelUri, text)
        await this.Language.WhenIdle()
        for (let waited = 0; waited < DevWorld.UpgradeWaitMs; waited += DevWorld.PollMs)
        {
            if (engine.SchemaVersion !== version) return
            await delay(DevWorld.PollMs)
        }
        assert.fail(DevWorld.NoUpgradeMessage)
    }

    public static Owner(principalId: string = ViewFx.OwnerId): AccessContext
    {
        const tenant = new Tenant(PpSecurityHarness.TenantId, TenantKind.SelfHosted, ViewFx.TenantName)
        const principal = new Principal(principalId, PpSecurityHarness.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(principalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, PpSecurityHarness.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** A reader with no grants (the unit ports' principal; the view itself checks no grant). */
    public static Reader(principalId: string = ViewFx.ReaderId): AccessContext
    {
        const tenant = new Tenant(PpSecurityHarness.TenantId, TenantKind.SelfHosted, ViewFx.TenantName)
        const principal = new Principal(principalId, PpSecurityHarness.TenantId, PrincipalKind.User, new Map(), [])
        return new AccessContext(principal, tenant, [], new ResourceAuthorizationPolicy())
    }

    public static Page(view: IGraphModelView, context: AccessContext, memberId: string, pageSize: number, cursor?: string): Promise<ModelViewPageDto>
    {
        return view.Page(context, memberId, { Params: { pageSize, cursor }, Limits: new PagingLimits() })
    }

    /** Pages the view from the first page to the end, returning every page. */
    public static async WalkView(view: IGraphModelView, context: AccessContext, memberId: string, size: number): Promise<ModelViewPageDto[]>
    {
        const pages: ModelViewPageDto[] = []
        let cursor: string | undefined
        do
        {
            const page = await DevWorld.Page(view, context, memberId, size, cursor)
            pages.push(page)
            cursor = page.nextCursor
        }
        while (cursor !== undefined)
        return pages
    }

    public static async Walk(client: PragmaticClient, memberId: string, pageSize: number): Promise<ModelViewPageDto[]>
    {
        const pages: ModelViewPageDto[] = []
        let cursor: string | undefined
        do
        {
            const page = await client.ModelView(memberId, { cursor, pageSize })
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

    public static IsInvalidParams(error: { code?: number }): boolean
    {
        return error.code === ErrorCodes.InvalidParams
    }

    private async Dispose(): Promise<void>
    {
        for (const connection of this.connections)
        {
            await connection.client.DisposeAsync()
            connection.handler.Dispose()
        }
        for (const view of this.views) view.dispose()
        await this.Language.WhenIdle()
        if (this.solution !== undefined) await this.manager.CloseSolution()
        await this.Server.Dispose()
    }
}

/** Shared constants of the ported fixtures. */
class ViewFx
{
    public static readonly OwnerId = 'p1'
    public static readonly OtherId = 'p2'
    public static readonly ReaderId = 'u1'
    public static readonly TenantName = 'Tenant One'
    public static readonly All = 1000
}

/** Ported from model-read-filter.test.ts: two customers (eu, us). */
class ModelFixture
{
    public static readonly Concept = 'shop.Customer'
    public static readonly Region = 'region'
    /** The originals used `shop.Customer:cust-eu`; a TODL instance id cannot hold a colon, so the engine id is `shop.custEu`. */
    public static readonly Eu = 'shop.custEu'
    public static readonly Us = 'shop.custUs'
    /** The provenance value (source of origin) the structure reports for each customer. */
    public static readonly EuProvenance = 'a.todl'
    public static readonly UsProvenance = 'b.todl'

    public static readonly Todl = 'namespace shop { concept Customer { region : string?; } model M : shop { Customer custEu { region = "eu"; } Customer custUs { region = "us"; } } }'

    public static Build(): Repository
    {
        const repo = new Repository()
        const b = repo.builder()
        b.definePrimitive('string')
        b.defineConcept(ModelFixture.Concept)
        b.addField(ModelFixture.Concept, ModelFixture.Region, 'string')
        b.assertInstance(ModelFixture.Concept, ModelFixture.Eu)
        b.setField(ModelFixture.Eu, ModelFixture.Region, 'eu')
        b.assertInstance(ModelFixture.Concept, ModelFixture.Us)
        b.setField(ModelFixture.Us, ModelFixture.Region, 'us')
        b.commit()
        return repo
    }

    /** The ids on one all-members page of `view` for `memberId`. */
    public static async Ids(view: IGraphModelView, memberId: string): Promise<string[]>
    {
        return (await DevWorld.Page(view, DevWorld.Reader(), memberId, ViewFx.All)).items.map(member => member.id)
    }
}

/** Ported from model-view-paging.test.ts: five customers (two eu, three us) with peer/manager edges. */
class FilterFixture
{
    public static readonly Namespace = 'shop'
    public static readonly Concept = 'shop.Customer'
    public static readonly Region = 'region'
    public static readonly Secret = 'secret'
    public static readonly Peer = 'peer'
    public static readonly Manager = 'manager'
    public static readonly Eu1 = 'shop.eu1'
    public static readonly Eu2 = 'shop.eu2'
    public static readonly Us1 = 'shop.us1'
    public static readonly Us2 = 'shop.us2'
    public static readonly Us3 = 'shop.us3'
    public static readonly Eu1Local = 'eu1'
    public static readonly EuValue = 'eu'
    public static readonly UsValue = 'us'
    public static readonly SecretValue = 's3cr3t'
    /** us1, us2 and us3: hidden from the reader under {@link FilterFixture.EuOnly}. */
    public static readonly HiddenCount = 3
    public static readonly RelationshipKind = 'Relationship'
    public static readonly InstanceTier = 'Instance'
    public static readonly OntologyTier = 'Ontology'
    public static readonly Ghost = 'shop.ghost'
    public static readonly Eu2Local = 'eu2'
    private static readonly StringType = 'string'
    private static readonly MissingMemberPrefix = 'member must be on the page: '
    private static readonly SizePrefix = 'size '

    /**
     * The saved TODL the engine runs for {@link FilterFixture.Build}: the same instances, values and edges. The engine
     * schema also declares a field named `eu2` (the via-localId port secures it).
     */
    public static readonly Todl = 'namespace shop { concept Customer { region : string?; secret : string?; eu2 : string?; relationship peer -> Customer[]; relationship manager -> Customer?; } '
        + 'model M : shop { Customer eu1 { region = "eu"; secret = "s3cr3t"; peer = [eu2, us1]; manager = eu2; } Customer eu2 { region = "eu"; } '
        + 'Customer us1 { region = "us"; } Customer us2 { region = "us"; } Customer us3 { region = "us"; } } }'

    public static Build(repo: Repository = new Repository()): Repository
    {
        const b = repo.builder()
        b.setNamespace(FilterFixture.Namespace)
        b.definePrimitive(FilterFixture.StringType)
        b.defineConcept(FilterFixture.Concept)
        b.addField(FilterFixture.Concept, FilterFixture.Region, FilterFixture.StringType)
        b.addField(FilterFixture.Concept, FilterFixture.Secret, FilterFixture.StringType)
        FilterFixture.Customer(b, FilterFixture.Eu1, FilterFixture.EuValue)
        b.setField(FilterFixture.Eu1, FilterFixture.Secret, FilterFixture.SecretValue)
        FilterFixture.Customer(b, FilterFixture.Eu2, FilterFixture.EuValue)
        FilterFixture.Customer(b, FilterFixture.Us1, FilterFixture.UsValue)
        FilterFixture.Customer(b, FilterFixture.Us2, FilterFixture.UsValue)
        FilterFixture.Customer(b, FilterFixture.Us3, FilterFixture.UsValue)
        b.addRelationship(FilterFixture.Eu1, FilterFixture.Peer, FilterFixture.Eu2)
        b.addRelationship(FilterFixture.Eu1, FilterFixture.Peer, FilterFixture.Us1)
        b.addRelationship(FilterFixture.Eu1, FilterFixture.Manager, FilterFixture.Eu2)
        b.commit()
        return repo
    }

    public static SizeLabel(size: number): string
    {
        return FilterFixture.SizePrefix + size
    }

    public static Member(page: ModelViewPageDto, id: string): ModelMemberDto
    {
        const member = page.items.find(m => m.id === id)
        assert.ok(member !== undefined, FilterFixture.MissingMemberPrefix + id)
        return member
    }

    /** One all-members page of `view` for the reader `context`. */
    public static All(view: IGraphModelView, world: DevWorld, context: AccessContext = DevWorld.Reader()): Promise<ModelViewPageDto>
    {
        return DevWorld.Page(view, context, world.MemberId, 100)
    }

    private static Customer(b: ReturnType<Repository['builder']>, id: string, region: string): void
    {
        b.assertInstance(FilterFixture.Concept, id, false, id.slice(FilterFixture.Namespace.length + 1))
        b.setField(id, FilterFixture.Region, region)
    }
}

/** Ported from model-view-paging.test.ts (WireWorld): one model with five Services. */
class WireFx
{
    public static readonly ServiceConcept = 'acme.Service'
    public static readonly Label = 'label'
    public static readonly ModelTodl = 'namespace acme { concept Service { } model Shop : acme { Service s1 { label = "e"; } Service s2 { label = "c"; } Service s3 { label = "a"; } Service s4 { label = "d"; } Service s5 { label = "b"; } } }'
    public static readonly RevisionMustMove = 'the edit must move the graph revision'
    public static readonly EditedModelTodl = 'namespace acme { concept Service { } model Shop : acme { Service s1 { label = "e"; } Service s2 { label = "c"; } Service s3 { label = "a"; } Service s4 { label = "d"; } Service s5 { label = "b"; } Service s6 { label = "f"; } } }'
    public static readonly S6 = 'acme.s6'
    /** The five Services with a region: s2, s3, s5 in eu (visible under {@link WireFx.EuOnly}), s1, s4 in us. */
    public static readonly RegionModelTodl = 'namespace acme { concept Service { region : string?; } model Shop : acme { Service s1 { label = "e"; region = "us"; } Service s2 { label = "c"; region = "eu"; } Service s3 { label = "a"; region = "eu"; } Service s4 { label = "d"; region = "us"; } Service s5 { label = "b"; region = "eu"; } } }'
    public static readonly HiddenServices = ['acme.s1', 'acme.s4']
    public static readonly VisibleServices = ['acme.s2', 'acme.s3', 'acme.s5']

}

/** Ported from model-surface.test.ts. */
class SurfaceFx
{
    public static readonly SampleTodl = 'namespace acme { concept Widget { } }'
    public static readonly WidgetId = 'acme.Widget'
    public static readonly UnknownMember = 'no/such/member'
    public static readonly OntologyTier = 'Ontology'
    public static readonly AnyMember = 'anything'
    public static readonly UnknownNode = 'no.such.node'
}

/** Typed class nodes: taxonomy term Big (annotated with an icon), classes Premium (eu) and Basic (us), all typed acme.Widget. */
class ClassFx
{
    public static readonly IconPath = 'resources/big.svg'
    public static readonly Todl = 'namespace acme { concept Widget { region : string?; } '
        + `taxonomy Kinds : represents Widget { term Big { annotate icon { path = "${ClassFx.IconPath}"; } } } `
        + 'class Widget Premium { region = "eu"; } class Widget Basic { region = "us"; } '
        + 'model Shop : acme { Widget w1 { region = "eu"; } } }'
}

/** A saved solution whose save adds w3 (the engine upgrades on save). */
class DepthFx
{
    public static readonly Todl = `namespace acme { concept Widget { ${PpSecurityHarness.OwningBuField} : string?; } model Shop : acme { `
        + `Widget w1 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.SalesBu}"; label = "alpha"; } `
        + `Widget w2 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.RootBu}"; label = "beta"; } } }`
    public static readonly SavedTodl = `namespace acme { concept Widget { ${PpSecurityHarness.OwningBuField} : string?; } model Shop : acme { `
        + `Widget w1 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.SalesBu}"; label = "alpha"; } `
        + `Widget w2 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.RootBu}"; label = "beta"; } `
        + `Widget w3 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.SalesBu}"; label = "gamma"; } } }`
    public static readonly W3 = 'acme.w3'

}

// ── ported from host/tests/model-read-filter.test.ts ───────────────────────────────────────────────

test('an unrestricted scope keeps every instance', async () =>
{
    await DevWorld.With(ModelFixture.Todl, async world =>
    {
        const ids = await ModelFixture.Ids(world.View(new FixedStructure(ModelFixture.Build())), world.MemberId)
        assert.ok(ids.includes(ModelFixture.Eu))
        assert.ok(ids.includes(ModelFixture.Us))
    })
})

test('a structural definition node survives filtering', async () =>
{
    await DevWorld.With(ModelFixture.Todl, async world =>
    {
        const ids = await ModelFixture.Ids(world.View(new FixedStructure(ModelFixture.Build())), world.MemberId)
        assert.ok(ids.includes(ModelFixture.Concept))
    })
})

// ── ported from host/tests/model-view-paging.test.ts ───────────────────────────────────────────────

test('member carries localId/namespace/tier/isClass/attrs/edges', async () =>
{
    await DevWorld.With(FilterFixture.Todl, async world =>
    {
        const page = await FilterFixture.All(world.View(new FixedStructure(FilterFixture.Build())), world)
        const member = FilterFixture.Member(page, FilterFixture.Eu1)
        assert.equal(member.kind, FilterFixture.Concept)
        assert.equal(member.localId, FilterFixture.Eu1Local)
        assert.equal(member.namespace, FilterFixture.Namespace)
        assert.equal(member.tier, FilterFixture.InstanceTier)
        assert.equal(member.isClass, false)
        assert.deepEqual(member.attrs, { [FilterFixture.Region]: FilterFixture.EuValue, [FilterFixture.Secret]: FilterFixture.SecretValue })
        assert.deepEqual(member.edges, [
            { kind: FilterFixture.RelationshipKind, via: FilterFixture.Peer, to: FilterFixture.Eu2 },
            { kind: FilterFixture.RelationshipKind, via: FilterFixture.Peer, to: FilterFixture.Us1 },
            { kind: FilterFixture.RelationshipKind, via: FilterFixture.Manager, to: FilterFixture.Eu2 },
        ])
        const structural = FilterFixture.Member(page, FilterFixture.Concept)
        assert.equal(structural.tier, FilterFixture.OntologyTier)
    })
})

test('walks every visible member once in id order', async () =>
{
    await DevWorld.With(WireFx.ModelTodl, async world =>
    {
        const client = world.Connect()
        const unpaged = await client.ModelView(world.MemberId)
        assert.equal(unpaged.nextCursor, undefined)
        const pages = await DevWorld.Walk(client, world.MemberId, 2)
        const walked = pages.flatMap(p => p.items.map(m => m.id))
        const expected = unpaged.items.map(m => m.id)
        assert.deepEqual(walked, expected)
        assert.equal(new Set(walked).size, walked.length)
        assert.deepEqual(walked, [...walked].sort((a, b) => a < b ? -1 : a > b ? 1 : 0))
        assert.equal(pages.length, Math.ceil(expected.length / 2))
        assert.ok(pages.slice(0, -1).every(p => p.nextCursor !== undefined && p.items.length === 2))
        assert.equal(pages[pages.length - 1]!.nextCursor, undefined)
    })
})

test('a graph edit between pages makes the cursor stale', async () =>
{
    await DevWorld.With(WireFx.ModelTodl, async world =>
    {
        const client = world.Connect()
        const first = await client.ModelView(world.MemberId, { pageSize: 2 })
        assert.ok(first.nextCursor !== undefined)
        const before = world.Language.GraphRevision
        client.DidChange(world.ModelUri, WireFx.EditedModelTodl)
        // the notification is fire-and-forget: a round-trip request flushes it ahead of WhenIdle
        await client.ModelView(world.MemberId, { pageSize: 1 })
        await world.Language.WhenIdle()
        assert.ok(world.Language.GraphRevision > before, WireFx.RevisionMustMove)
        await assert.rejects(() => client.ModelView(world.MemberId, { cursor: first.nextCursor, pageSize: 2 }), DevWorld.IsStale)
    })
})

test('a non-positive pageSize is rejected', async () =>
{
    await DevWorld.With(WireFx.ModelTodl, async world =>
    {
        const client = world.Connect()
        await assert.rejects(() => client.ModelView(world.MemberId, { pageSize: 0 }), DevWorld.IsInvalidParams)
        await assert.rejects(() => client.ModelView(world.MemberId, { pageSize: 1.5 }), DevWorld.IsInvalidParams)
    })
})

test('an edge to an unresolvable node is dropped', async () =>
{
    await DevWorld.With(FilterFixture.Todl, async world =>
    {
        // the graph store rejects a dangling edge on insert, so a repository surfaces one from outEdges instead
        const repo = FilterFixture.Build(new DanglingEdgeRepository(FilterFixture.Eu1, FilterFixture.Peer, FilterFixture.Ghost))
        assert.equal(repo.resolve(FilterFixture.Ghost), undefined)
        assert.ok(repo.outEdges(FilterFixture.Eu1).some(e => e.to === FilterFixture.Ghost))
        const member = FilterFixture.Member(await FilterFixture.All(world.View(new FixedStructure(repo)), world), FilterFixture.Eu1)
        assert.ok(member.edges.length > 0)
        assert.ok(member.edges.every(e => e.to !== FilterFixture.Ghost))
    })
})

// ── ported from host/tests/model-surface.test.ts ───────────────────────────────────────────────────

test('ModelView over the wire projects the member model to JSON including the fixture concept', async () =>
{
    await DevWorld.With(SurfaceFx.SampleTodl, async world =>
    {
        const projection = await world.Connect().ModelView(world.MemberId)
        const ids = projection.items.map(m => m.id)
        assert.ok(ids.includes(SurfaceFx.WidgetId))
        assert.equal(projection.nextCursor, undefined)
        const widget = projection.items.find(m => m.id === SurfaceFx.WidgetId)!
        assert.equal(widget.tier, SurfaceFx.OntologyTier)
        assert.equal(typeof widget.attrs, 'object')
        assert.ok(Array.isArray(widget.edges))
        // the projection must be plain JSON - survives a round-trip unchanged
        assert.deepEqual(JSON.parse(JSON.stringify(projection)), projection)
    })
})

test('ModelView for an unknown member id rejects', async () =>
{
    await DevWorld.With(SurfaceFx.SampleTodl, async world =>
    {
        await assert.rejects(world.Connect().ModelView(SurfaceFx.UnknownMember))
    })
})

test('ModelView before any OpenSolution rejects', async () =>
{
    await DevWorld.With(undefined, async world =>
    {
        await assert.rejects(world.Connect().ModelView(SurfaceFx.AnyMember))
    })
})

test('Resources over the wire returns a JSON array for a node', async () =>
{
    await DevWorld.With(SurfaceFx.SampleTodl, async world =>
    {
        const client = world.Connect()
        const resources = await client.Resources(SurfaceFx.WidgetId)
        assert.ok(Array.isArray(resources))
        assert.deepEqual(JSON.parse(JSON.stringify(resources)), resources)
        const unknown = await client.Resources(SurfaceFx.UnknownNode)
        assert.deepEqual(unknown, [])
    })
})

// ── new: visibility from the engine scope ──────────────────────────────────────────────────────────

test('switching to a rebuilt scope source drops the subscription to the previous one', async () =>
{
    await DevWorld.With(ClassFx.Todl, async world =>
    {
        const first = new CountingScopeSource(() => world.Server.DevScopes())
        const second = new CountingScopeSource(() => world.Server.DevScopes())
        let current: IGraphScopeSource = first
        const view = world.View(new FixedStructure(ModelFixture.Build()), undefined, async () => current)
        await DevWorld.Page(view, DevWorld.Reader(), world.MemberId, ViewFx.All)
        await DevWorld.Page(view, DevWorld.Reader(), world.MemberId, ViewFx.All)
        assert.equal(first.Dropped.Active, 1)
        current = second
        await DevWorld.Page(view, DevWorld.Reader(), world.MemberId, ViewFx.All)
        assert.equal(first.Dropped.Active, 0)
        assert.equal(second.Dropped.Active, 1)
        view.dispose()
        assert.equal(second.Dropped.Active, 0)
    })
})

test('an instance only in an unsaved buffer is visible under the unrestricted dev scope', async () =>
{
    // the dev scope restricts no read (PR13), so the unsaved instance shows as before the engine
    await DevWorld.With(WireFx.ModelTodl, async world =>
    {
        const client = world.Connect()
        world.Language.DidChange(world.ModelUri, WireFx.EditedModelTodl)
        await world.Language.WhenIdle()
        assert.ok((await client.ModelView(world.MemberId)).items.some(m => m.id === WireFx.S6))
    })

})

test('a saved edit is seen once the engine upgrades, and a cursor minted before it is stale', async () =>
{
    await DevWorld.With(DepthFx.Todl, async world =>
    {
        const client = world.Connect()
        const before = await client.ModelView(world.MemberId, { pageSize: 1 })
        assert.ok(before.nextCursor !== undefined)
        assert.ok(!(await client.ModelView(world.MemberId)).items.some(m => m.id === DepthFx.W3))
        await world.Save(DepthFx.SavedTodl)
        const ids = (await client.ModelView(world.MemberId)).items.map(m => m.id)
        assert.ok(ids.includes(DepthFx.W3))
        await assert.rejects(() => client.ModelView(world.MemberId, { cursor: before.nextCursor, pageSize: 1 }), DevWorld.IsStale)
    })
})

test('a handler without a model view reports it unavailable', async () =>
{
    await DevWorld.With(SurfaceFx.SampleTodl, async world =>
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, world.Language, await world.Server.Manager(), DevWorld.Owner(), undefined, undefined)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            await assert.rejects(() => client.ModelView(world.MemberId), DevWorld.IsInvalidParams)
            await assert.rejects(() => client.Resources(SurfaceFx.WidgetId), DevWorld.IsInvalidParams)
        }
        finally
        {
            await client.DisposeAsync()
            handler.Dispose()
        }
    })
})
