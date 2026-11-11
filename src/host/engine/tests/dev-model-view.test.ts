import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AccessScope, GraphEngine, GraphReader, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { CursorStaleError, ErrorCodes, InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ModelMemberDto, ModelViewPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EdgeKind, Repository } from '@pragmatic-tech-ai/todl'
import type { Edge, SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, AccessLevel, Grant, OwnershipSourceKind, Principal, PrincipalKind, PrivilegeAction, ResourceAuthorizationPolicy, ResourceKind, ResourceRef, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import { PagingLimits } from '../../../config/paging-limits.js'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { PpSecurityHarness } from '../../cypher/tests/pp-security-harness.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'
import { DevModelView } from '../dev-model-view.js'
import type { IDevModelStructure, IDevModelView, IDevModelViewDiagnostics } from '../dev-model-view.js'
import type { IDevScope, IDevScopeSource } from '../dev-access-scope-source.js'
import type { IDevGraphEngine } from '../dev-graph-engine-host.js'

/**
 * Ported from host/tests/model-read-filter.test.ts, model-view-paging.test.ts and model-surface.test.ts: the dev
 * model/view now takes instance visibility and masking from the caller's engine scope. The unit ports keep their
 * in-memory structure (FixedStructure) and run the visibility on the dev engine over an equivalent SAVED solution
 * (same ids, same values, the depth / field security as tenant security model); the wire ports run
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
}

/** Records every model-view diagnostic. */
class RecordingDiagnostics implements IDevModelViewDiagnostics
{
    public readonly Messages: string[] = []

    public ModelViewDiagnostic(message: string): void
    {
        this.Messages.push(message)
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
class CountingScopeSource implements IDevScopeSource
{
    public readonly Dropped = new CountingDropped()

    public constructor(private readonly inner: () => Promise<IDevScopeSource>)
    {
    }

    public async ScopeFor(context: AccessContext): Promise<IDevScope>
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

/** A tenant security model granting Organization-level Read on one concept, with optional field security. */
class SecurityFx
{
    private static readonly RootBu = 'root'
    private static readonly RootName = 'Root'
    private static readonly RoleId = 'reader'
    private static readonly RoleName = 'Reader'
    private static readonly ProfileId = 'field-readers'
    private static readonly ProfileName = 'Field readers'
    private static readonly EuBu = 'eu'
    private static readonly UsBu = 'us'
    private static readonly RegionField = 'region'

    /** `readers` read `concept` org-wide; `secured` fields are secured and only `granted` principals may read them. */
    public static OrgRead(concept: string, readers: readonly string[], secured: readonly string[] = [], granted: readonly string[] = []): ISecurityModelConfig
    {
        const model: ISecurityModelConfig = {
            businessUnits: [{ id: SecurityFx.RootBu, name: SecurityFx.RootName }],
            teams: [],
            membership: { claimsMapping: [], overrides: readers.map(principalId => ({ principalId, homeBusinessUnit: SecurityFx.RootBu, teams: [] })) },
            ownershipRules: [],
            roles: [{ id: SecurityFx.RoleId, name: SecurityFx.RoleName, privileges: [{ action: PrivilegeAction.Read, concept, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: readers.map(principalId => ({ principalId, roles: [SecurityFx.RoleId] })) },
        }
        if (secured.length === 0) return model
        return {
            ...model,
            fieldSecurity: {
                securedFields: secured.map(field => ({ concept, field })),
                profiles: [{ id: SecurityFx.ProfileId, name: SecurityFx.ProfileName, grants: secured.map(field => ({ concept, field, read: true })) }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: granted.map(principalId => ({ principalId, profiles: [SecurityFx.ProfileId] })) },
            },
        }
    }

    /**
     * Access depth by region: business units `eu` and `us` under root, `concept` owned by the unit its `region` field
     * names, and `readers` (home unit eu) reading it at BusinessUnit level, so eu instances are visible and us ones hidden.
     */
    public static RegionRead(concept: string, readers: readonly string[]): ISecurityModelConfig
    {
        return {
            businessUnits: [
                { id: SecurityFx.RootBu, name: SecurityFx.RootName },
                { id: SecurityFx.EuBu, name: SecurityFx.EuBu, parent: SecurityFx.RootBu },
                { id: SecurityFx.UsBu, name: SecurityFx.UsBu, parent: SecurityFx.RootBu },
            ],
            teams: [],
            membership: { claimsMapping: [], overrides: readers.map(principalId => ({ principalId, homeBusinessUnit: SecurityFx.EuBu, teams: [] })) },
            ownershipRules: [{ concept, owningBusinessUnit: { kind: OwnershipSourceKind.FromField, value: SecurityFx.RegionField } }],
            roles: [{ id: SecurityFx.RoleId, name: SecurityFx.RoleName, privileges: [{ action: PrivilegeAction.Read, concept, level: AccessLevel.BusinessUnit }] }],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: readers.map(principalId => ({ principalId, roles: [SecurityFx.RoleId] })) },
        }
    }

    /** The harness model with its concept namespace-qualified (dev-graph concepts are acme.Widget). */
    public static Qualify(model: ISecurityModelConfig, concept: string): ISecurityModelConfig
    {
        return {
            ...model,
            ownershipRules: model.ownershipRules.map(r => ({ ...r, concept })),
            roles: (model.roles ?? []).map(r => ({ ...r, privileges: r.privileges.map(p => ({ ...p, concept })) })),
        }
    }
}

/** A started dev server over a copy of the sample solution whose model file holds the test's TODL. */
class DevWorld
{
    private static readonly SolutionPrefix = 'dmv-sol-'
    private static readonly PackagesPrefix = 'dmv-pkgs-'
    private static readonly IdentityPrefix = 'dmv-id-'
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

    /** Opens a solution holding `modelTodl` (none: no solution is opened), with identity and `security` seeded when given. */
    public static With(modelTodl: string | undefined, security: ISecurityModelConfig | undefined, body: (world: DevWorld) => Promise<void>): Promise<void>
    {
        return DevWorld.Run(modelTodl, security !== undefined, security, body)
    }

    /** Identity configured; `security` seeded when given (none: the tenant has no security model, so DenyAll). */
    public static WithIdentity(modelTodl: string, security: ISecurityModelConfig | undefined, body: (world: DevWorld) => Promise<void>): Promise<void>
    {
        return DevWorld.Run(modelTodl, true, security, body)
    }

    private static async Run(modelTodl: string | undefined, identity: boolean, security: ISecurityModelConfig | undefined, body: (world: DevWorld) => Promise<void>): Promise<void>
    {
        const solution = modelTodl === undefined ? undefined : mkdtempSync(join(tmpdir(), DevWorld.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), DevWorld.PackagesPrefix))
        const identityRoot = mkdtempSync(join(tmpdir(), DevWorld.IdentityPrefix))
        if (solution !== undefined)
        {
            cpSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
            writeFileSync(join(solution, DevWorld.ModelsDir, DevWorld.ModelFileName), modelTodl!)
        }
        PpSecurityHarness.SetKey()
        const server = !identity
            ? new PragmaticServer({ packagesRoot: packages })
            : new PragmaticServer({ packagesRoot: packages, identity: PpSecurityHarness.Identity(identityRoot) })
        let world: DevWorld | undefined
        try
        {
            await server.Start()
            if (solution !== undefined) await server.OpenSolution(solution)
            if (security !== undefined) await PpSecurityHarness.Seed(server, security)
            const language = await server.LanguageService() as SolutionLanguageService
            await language.WhenIdle()
            world = new DevWorld(server, language, await server.Manager(), solution)
            await body(world)
        }
        finally
        {
            await world?.Dispose()
            if (world === undefined) await server.Dispose()
            PpSecurityHarness.ClearKey()
            if (solution !== undefined) rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
            rmSync(identityRoot, { recursive: true, force: true })
        }
    }

    /** A client over a handler attached with the server's development arguments, as the hosts attach it. */
    public Connect(context: AccessContext = DevWorld.Owner()): PragmaticClient
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const development = ServerConnectionHandler.DevelopmentAttachArgs(this.Server)
        const handler = ServerConnectionHandler.Attach(serverSocket, this.Language, this.manager, context, () => Promise.reject(new Error(DevWorld.NoConnectors)), development.devCypher,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, development.devGraphService, undefined, development.devModelView)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.connections.push({ client, handler })
        return client
    }

    /** A DevModelView on this server's engine and scopes whose structure is `structure` (the unit ports). */
    public View(structure: IDevModelStructure, diagnostics?: IDevModelViewDiagnostics, scopes: () => Promise<IDevScopeSource> = () => this.Server.DevScopes()): DevModelView
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

    public static Page(view: IDevModelView, context: AccessContext, memberId: string, pageSize: number, cursor?: string): Promise<ModelViewPageDto>
    {
        return view.Page(context, memberId, { Params: { pageSize, cursor }, Limits: new PagingLimits() })
    }

    /** Pages the view from the first page to the end, returning every page. */
    public static async WalkView(view: IDevModelView, context: AccessContext, memberId: string, size: number): Promise<ModelViewPageDto[]>
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
    public static readonly Unknown = 'shop.doesNotExist'
    /** The provenance value (source of origin) the structure reports for each customer. */
    public static readonly EuProvenance = 'a.todl'
    public static readonly UsProvenance = 'b.todl'

    /** eu-only visibility for the reader, by access depth on the region field. */
    public static EuOnly(): ISecurityModelConfig
    {
        return SecurityFx.RegionRead(ModelFixture.Concept, [ViewFx.ReaderId])
    }

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
    public static async Ids(view: IDevModelView, memberId: string): Promise<string[]>
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

    /** eu-only visibility for the reader (u1), by access depth on the region field. */
    public static EuOnly(): ISecurityModelConfig
    {
        return SecurityFx.RegionRead(FilterFixture.Concept, [ViewFx.ReaderId])
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
    public static All(view: IDevModelView, world: DevWorld, context: AccessContext = DevWorld.Reader()): Promise<ModelViewPageDto>
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

    /** eu-only visibility for the connection's owner (p1), by access depth on the region field. */
    public static EuOnly(): ISecurityModelConfig
    {
        return SecurityFx.RegionRead(WireFx.ServiceConcept, [ViewFx.OwnerId])
    }
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
    public static readonly Widget = 'acme.Widget'
    public static readonly Big = 'acme.Kinds.Big'
    public static readonly Premium = 'acme.Premium'
    public static readonly Basic = 'acme.Basic'
    public static readonly W1 = 'acme.w1'
    public static readonly IconPath = 'resources/big.svg'
    public static readonly Region = 'region'
    public static readonly Eu = 'eu'
    /** A string TODL holds but the engine's value codec refuses. */
    public static readonly LoneSurrogate = String.fromCharCode(0xd800)
    public static readonly AdmitsFault = 'the engine reader faulted'
    public static readonly RegionMember = ClassFx.Widget + '.' + ClassFx.Region

    /** A class-bearing repository: Premium's region is `premium`, Basic's is eu, instance w1 is eu. */
    public static Repository(premium: string): Repository
    {
        const repo = new Repository()
        const b = repo.builder()
        b.definePrimitive('string')
        b.defineConcept(ClassFx.Widget)
        b.addField(ClassFx.Widget, ClassFx.Region, 'string')
        b.assertInstance(ClassFx.Widget, ClassFx.Premium, true)
        b.setField(ClassFx.Premium, ClassFx.Region, premium)
        b.assertInstance(ClassFx.Widget, ClassFx.Basic, true)
        b.setField(ClassFx.Basic, ClassFx.Region, ClassFx.Eu)
        b.assertInstance(ClassFx.Widget, ClassFx.W1)
        b.setField(ClassFx.W1, ClassFx.Region, ClassFx.Eu)
        b.commit()
        return repo
    }

    public static readonly Todl = 'namespace acme { concept Widget { region : string?; } '
        + `taxonomy Kinds : represents Widget { term Big { annotate icon { path = "${ClassFx.IconPath}"; } } } `
        + 'class Widget Premium { region = "eu"; } class Widget Basic { region = "us"; } '
        + 'model Shop : acme { Widget w1 { region = "eu"; } } }'
}

/** The dev engine host with every reader's `Admits` throwing a plain Error (an engine fault, not SchemaViolation). */
class AdmitsFaultHost
{
    public static Over(host: IDevGraphEngine): IDevGraphEngine
    {
        return new Proxy(host, { get: (target, name) => (name === 'Engine' ? () => AdmitsFaultHost.Engine(target) : AdmitsFaultHost.Bound(target, name)) })
    }

    private static async Engine(host: IDevGraphEngine): Promise<GraphEngine>
    {
        const engine = await host.Engine()
        return new Proxy(engine, { get: (target, name) => (name === 'BeginRead' ? (scope: AccessScope) => AdmitsFaultHost.Reader(target, scope) : AdmitsFaultHost.Bound(target, name)) })
    }

    private static async Reader(engine: GraphEngine, scope: AccessScope): Promise<GraphReader>
    {
        const reader = await engine.BeginRead(scope)
        return new Proxy(reader, { get: (target, name) => (name === 'Admits' ? () => { throw new Error(ClassFx.AdmitsFault) } : AdmitsFaultHost.Bound(target, name)) })
    }

    private static Bound(target: object, name: string | symbol): unknown
    {
        const value: unknown = Reflect.get(target, name, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    }
}

/** The new depth case: w1 owned by `sales`, w2 by `root`; p1 reads Widget at BusinessUnit level from `sales`. */
class DepthFx
{
    public static readonly Widget = 'acme.Widget'
    public static readonly W1 = 'acme.w1'
    public static readonly W2 = 'acme.w2'
    public static readonly Todl = `namespace acme { concept Widget { ${PpSecurityHarness.OwningBuField} : string?; } model Shop : acme { `
        + `Widget w1 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.SalesBu}"; label = "alpha"; } `
        + `Widget w2 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.RootBu}"; label = "beta"; } } }`
    public static readonly SavedTodl = `namespace acme { concept Widget { ${PpSecurityHarness.OwningBuField} : string?; } model Shop : acme { `
        + `Widget w1 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.SalesBu}"; label = "alpha"; } `
        + `Widget w2 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.RootBu}"; label = "beta"; } `
        + `Widget w3 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.SalesBu}"; label = "gamma"; } } }`
    public static readonly W3 = 'acme.w3'
    /** Unsaved: w1 (saved as a Widget the reader's depth admits) re-typed to a new concept Other. */
    public static readonly RetypedTodl = `namespace acme { concept Widget { ${PpSecurityHarness.OwningBuField} : string?; } concept Other { ${PpSecurityHarness.OwningBuField} : string?; } model Shop : acme { `
        + `Other w1 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.SalesBu}"; label = "alpha"; } `
        + `Widget w2 { ${PpSecurityHarness.OwningBuField} = "${PpSecurityHarness.RootBu}"; label = "beta"; } } }`

    public static Bu(): ISecurityModelConfig
    {
        return SecurityFx.Qualify(PpSecurityHarness.BuSecurityModel(ViewFx.OwnerId), DepthFx.Widget)
    }
}

// ── ported from host/tests/model-read-filter.test.ts ───────────────────────────────────────────────

test('an unrestricted scope keeps every instance', async () =>
{
    await DevWorld.With(ModelFixture.Todl, undefined, async world =>
    {
        const ids = await ModelFixture.Ids(world.View(new FixedStructure(ModelFixture.Build())), world.MemberId)
        assert.ok(ids.includes(ModelFixture.Eu))
        assert.ok(ids.includes(ModelFixture.Us))
    })
})

test('a hidden instance id does not leak through provenanceOf', async () =>
{
    await DevWorld.With(ModelFixture.Todl, ModelFixture.EuOnly(), async world =>
    {
        const provenance = new Map([[ModelFixture.Eu, ModelFixture.EuProvenance], [ModelFixture.Us, ModelFixture.UsProvenance]])
        const projection = await DevWorld.Page(world.View(new FixedStructure(ModelFixture.Build(), provenance)), DevWorld.Reader(), world.MemberId, ViewFx.All)
        assert.equal(projection.provenanceOf[ModelFixture.Eu], ModelFixture.EuProvenance)
        assert.equal(ModelFixture.Us in projection.provenanceOf, false)
    })
})

test('Hidden is false for an id the model cannot resolve', async () =>
{
    await DevWorld.With(ModelFixture.Todl, undefined, async world =>
    {
        assert.equal(await world.View(new FixedStructure(ModelFixture.Build())).Hidden(DevWorld.Reader(), ModelFixture.Unknown), false)
    })
})

test('a structural definition node survives filtering', async () =>
{
    await DevWorld.With(ModelFixture.Todl, undefined, async world =>
    {
        const ids = await ModelFixture.Ids(world.View(new FixedStructure(ModelFixture.Build())), world.MemberId)
        assert.ok(ids.includes(ModelFixture.Concept))
    })
})

// ── ported from host/tests/model-view-paging.test.ts ───────────────────────────────────────────────

test('member carries localId/namespace/tier/isClass/attrs/edges', async () =>
{
    await DevWorld.With(FilterFixture.Todl, undefined, async world =>
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
    await DevWorld.With(WireFx.ModelTodl, undefined, async world =>
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

test('hidden nodes are excluded before paging', async () =>
{
    await DevWorld.With(FilterFixture.Todl, FilterFixture.EuOnly(), async world =>
    {
        const repo = FilterFixture.Build()
        const n = repo.allNodes().length
        const visible = n - FilterFixture.HiddenCount
        const view = world.View(new FixedStructure(repo))
        for (const size of [1, 2, 3, visible, visible + 1])
        {
            const pages = await DevWorld.WalkView(view, DevWorld.Reader(), world.MemberId, size)
            const items = pages.flatMap(p => p.items.map(m => m.id))
            assert.equal(items.length, visible, FilterFixture.SizeLabel(size))
            assert.equal(new Set(items).size, visible, FilterFixture.SizeLabel(size))
            assert.equal(pages.length, Math.ceil(visible / size), FilterFixture.SizeLabel(size))
            assert.ok(pages.slice(0, -1).every(p => p.nextCursor !== undefined), FilterFixture.SizeLabel(size))
            assert.equal(pages[pages.length - 1]!.nextCursor, undefined, FilterFixture.SizeLabel(size))
            assert.ok(pages.every(p => p.items.length > 0), FilterFixture.SizeLabel(size))
            for (const hidden of [FilterFixture.Us1, FilterFixture.Us2, FilterFixture.Us3])
            {
                assert.ok(!items.includes(hidden))
            }
        }
    })
})

test('a field-masked attr is absent', async () =>
{
    // DenyOneFieldMask(Concept, Secret) -> field security: `secret` is secured and the reader holds no profile for it
    await DevWorld.With(FilterFixture.Todl, SecurityFx.OrgRead(FilterFixture.Concept, [ViewFx.ReaderId], [FilterFixture.Secret]), async world =>
    {
        const member = FilterFixture.Member(await FilterFixture.All(world.View(new FixedStructure(FilterFixture.Build())), world), FilterFixture.Eu1)
        assert.deepEqual(member.attrs, { [FilterFixture.Region]: FilterFixture.EuValue })
    })
    // DenyOneFieldMaskSource(Service, label) -> `label` secured; p1 holds no profile for it, p2 does (the open connection)
    await DevWorld.With(WireFx.ModelTodl, SecurityFx.OrgRead(WireFx.ServiceConcept, [ViewFx.OwnerId, ViewFx.OtherId], [WireFx.Label], [ViewFx.OtherId]), async world =>
    {
        const page = await world.Connect(DevWorld.Owner(ViewFx.OwnerId)).ModelView(world.MemberId)
        const services = page.items.filter(m => m.kind === WireFx.ServiceConcept)
        assert.equal(services.length, 5)
        assert.ok(services.every(m => !(WireFx.Label in m.attrs)))
        const open = await world.Connect(DevWorld.Owner(ViewFx.OtherId)).ModelView(world.MemberId)
        assert.ok(open.items.filter(m => m.kind === WireFx.ServiceConcept).every(m => WireFx.Label in m.attrs))
    })
})

test('an edge to a hidden node is dropped', async () =>
{
    await DevWorld.With(FilterFixture.Todl, FilterFixture.EuOnly(), async world =>
    {
        const member = FilterFixture.Member(await FilterFixture.All(world.View(new FixedStructure(FilterFixture.Build())), world), FilterFixture.Eu1)
        assert.deepEqual(member.edges, [
            { kind: FilterFixture.RelationshipKind, via: FilterFixture.Peer, to: FilterFixture.Eu2 },
            { kind: FilterFixture.RelationshipKind, via: FilterFixture.Manager, to: FilterFixture.Eu2 },
        ])
    })
})

test('an edge whose via field is masked is dropped', async () =>
{
    // DenyOneFieldMask(Concept, Manager) -> field security on the `manager` relationship member
    await DevWorld.With(FilterFixture.Todl, SecurityFx.OrgRead(FilterFixture.Concept, [ViewFx.ReaderId], [FilterFixture.Manager]), async world =>
    {
        const member = FilterFixture.Member(await FilterFixture.All(world.View(new FixedStructure(FilterFixture.Build())), world), FilterFixture.Eu1)
        assert.deepEqual(member.edges, [
            { kind: FilterFixture.RelationshipKind, via: FilterFixture.Peer, to: FilterFixture.Eu2 },
            { kind: FilterFixture.RelationshipKind, via: FilterFixture.Peer, to: FilterFixture.Us1 },
        ])
    })
})

test('provenanceOf holds only page members', async () =>
{
    await DevWorld.With(FilterFixture.Todl, FilterFixture.EuOnly(), async world =>
    {
        const repo = FilterFixture.Build()
        const provenance = new Map(repo.allNodes().map(node => [node.id, `${node.id}.todl`] as [string, string]))
        const pages = await DevWorld.WalkView(world.View(new FixedStructure(repo, provenance)), DevWorld.Reader(), world.MemberId, 2)
        for (const page of pages)
        {
            assert.deepEqual(Object.keys(page.provenanceOf).sort(), page.items.map(m => m.id).filter(id => provenance.has(id)).sort())
        }
        // not vacuous: the hidden customers have provenance, yet no page carries it
        assert.ok(pages.every(page => !(FilterFixture.Us1 in page.provenanceOf)))
    })
    await DevWorld.With(WireFx.RegionModelTodl, WireFx.EuOnly(), async world =>
    {
        const client = world.Connect()
        for (const page of await DevWorld.Walk(client, world.MemberId, 2))
        {
            const ids = new Set(page.items.map(m => m.id))
            assert.ok(Object.keys(page.provenanceOf).every(id => ids.has(id)))
        }
    })
})

test('a via that resolves to a hidden node is dropped', async () =>
{
    await DevWorld.With(FilterFixture.Todl, FilterFixture.EuOnly(), async world =>
    {
        const repo = FilterFixture.Build()
        repo.addEdge({ kind: EdgeKind.Relationship, via: FilterFixture.Us2, from: FilterFixture.Eu1, to: FilterFixture.Eu2 })
        assert.ok(repo.outEdges(FilterFixture.Eu1).some(e => e.via === FilterFixture.Us2))
        const member = FilterFixture.Member(await FilterFixture.All(world.View(new FixedStructure(repo)), world), FilterFixture.Eu1)
        assert.ok(member.edges.length > 0)
        assert.ok(member.edges.every(e => e.via !== FilterFixture.Us2))
    })
})

test('under a depth restriction the wire nextCursor is absent exactly on the last page', async () =>
{
    await DevWorld.With(WireFx.RegionModelTodl, WireFx.EuOnly(), async world =>
    {
        const client = world.Connect()
        const unpaged = await client.ModelView(world.MemberId)
        const ids = unpaged.items.map(m => m.id)
        for (const hidden of WireFx.HiddenServices)
        {
            assert.ok(!ids.includes(hidden))
        }
        for (const shown of WireFx.VisibleServices)
        {
            assert.ok(ids.includes(shown))
        }
        for (const size of [1, 2, ids.length])
        {
            const pages = await DevWorld.Walk(client, world.MemberId, size)
            assert.deepEqual(pages.flatMap(p => p.items.map(m => m.id)), ids, FilterFixture.SizeLabel(size))
            assert.equal(pages.length, Math.ceil(ids.length / size), FilterFixture.SizeLabel(size))
            assert.ok(pages.slice(0, -1).every(p => p.nextCursor !== undefined && p.items.length === size), FilterFixture.SizeLabel(size))
            assert.equal(pages[pages.length - 1]!.nextCursor, undefined, FilterFixture.SizeLabel(size))
        }
    })
})

test('a graph edit between pages makes the cursor stale', async () =>
{
    await DevWorld.With(WireFx.ModelTodl, undefined, async world =>
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
    await DevWorld.With(WireFx.ModelTodl, undefined, async world =>
    {
        const client = world.Connect()
        await assert.rejects(() => client.ModelView(world.MemberId, { pageSize: 0 }), DevWorld.IsInvalidParams)
        await assert.rejects(() => client.ModelView(world.MemberId, { pageSize: 1.5 }), DevWorld.IsInvalidParams)
    })
})

test('an edge to an unresolvable node is dropped', async () =>
{
    await DevWorld.With(FilterFixture.Todl, undefined, async world =>
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

test('a via that resolves to a visible node is kept and masked by its localId', async () =>
{
    // RecordingFieldMask -> the engine's hidden members: the field named by the via node's localId (`eu2`) is secured;
    // u1 holds a profile reading it, p2 does not. Masking by the localId keeps the edge for u1 and drops it for p2;
    // masking by the full id `shop.eu2` (no member of that name exists to hide) would keep it for p2.
    const security = SecurityFx.OrgRead(FilterFixture.Concept, [ViewFx.ReaderId, ViewFx.OtherId], [FilterFixture.Eu2Local], [ViewFx.ReaderId])
    await DevWorld.With(FilterFixture.Todl, security, async world =>
    {
        const repo = FilterFixture.Build()
        repo.addEdge({ kind: EdgeKind.Relationship, via: FilterFixture.Eu2, from: FilterFixture.Eu1, to: FilterFixture.Eu2 })
        const view = world.View(new FixedStructure(repo))
        const member = FilterFixture.Member(await FilterFixture.All(view, world), FilterFixture.Eu1)
        assert.ok(member.edges.some(e => e.via === FilterFixture.Eu2 && e.to === FilterFixture.Eu2))
        const masked = FilterFixture.Member(await FilterFixture.All(view, world, DevWorld.Reader(ViewFx.OtherId)), FilterFixture.Eu1)
        assert.ok(masked.edges.every(e => e.via !== FilterFixture.Eu2))
        assert.ok(masked.edges.length > 0)
        // not vacuous: eu2 itself is visible to p2, and p2 keeps eu1's peer edge to it
        const otherPage = await FilterFixture.All(view, world, DevWorld.Reader(ViewFx.OtherId))
        assert.ok(otherPage.items.some(m => m.id === FilterFixture.Eu2))
        assert.ok(masked.edges.some(e => e.to === FilterFixture.Eu2 && e.via === FilterFixture.Peer))
    })
})

// ── ported from host/tests/model-surface.test.ts ───────────────────────────────────────────────────

test('ModelView over the wire projects the member model to JSON including the fixture concept', async () =>
{
    await DevWorld.With(SurfaceFx.SampleTodl, undefined, async world =>
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
    await DevWorld.With(SurfaceFx.SampleTodl, undefined, async world =>
    {
        await assert.rejects(world.Connect().ModelView(SurfaceFx.UnknownMember))
    })
})

test('ModelView before any OpenSolution rejects', async () =>
{
    await DevWorld.With(undefined, undefined, async world =>
    {
        await assert.rejects(world.Connect().ModelView(SurfaceFx.AnyMember))
    })
})

test('Resources over the wire returns a JSON array for a node', async () =>
{
    await DevWorld.With(SurfaceFx.SampleTodl, undefined, async world =>
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

test('depth hides an instance from model/view', async () =>
{
    await DevWorld.With(DepthFx.Todl, DepthFx.Bu(), async world =>
    {
        const ids = (await world.Connect().ModelView(world.MemberId)).items.map(m => m.id)
        assert.ok(ids.includes(DepthFx.W1))
        assert.ok(!ids.includes(DepthFx.W2))
        // the concept itself is schema: depth never hides it
        assert.ok(ids.includes(DepthFx.Widget))
        const view = world.Server.DevModelView()
        assert.equal(await view.Hidden(DevWorld.Owner(), DepthFx.W2), true)
        assert.equal(await view.Hidden(DevWorld.Owner(), DepthFx.W1), false)
        // a principal outside the security model sees no instance (fail-closed), and p1's cursor is stale for it
        const other = world.Connect(DevWorld.Owner(ViewFx.OtherId))
        const otherIds = (await other.ModelView(world.MemberId)).items.map(m => m.id)
        assert.ok(!otherIds.includes(DepthFx.W1) && !otherIds.includes(DepthFx.W2))
        const first = await world.Connect().ModelView(world.MemberId, { pageSize: 1 })
        assert.ok(first.nextCursor !== undefined)
        await assert.rejects(() => other.ModelView(world.MemberId, { cursor: first.nextCursor, pageSize: 1 }), DevWorld.IsStale)
    })
})

test('an annotated term is admitted with its resources under an org read, and DenyAll hides terms and classes', async () =>
{
    await DevWorld.WithIdentity(ClassFx.Todl, SecurityFx.OrgRead(ClassFx.Widget, [ViewFx.OwnerId]), async world =>
    {
        const client = world.Connect()
        const ids = (await client.ModelView(world.MemberId)).items.map(m => m.id)
        for (const id of [ClassFx.Big, ClassFx.Premium, ClassFx.Basic, ClassFx.W1]) assert.ok(ids.includes(id), id)
        assert.deepEqual((await client.Resources(ClassFx.Big)).map(r => r.path), [ClassFx.IconPath])
    })
    // identity with no security model: the tenant is DenyAll, so the Widget-typed term and classes are not admitted
    await DevWorld.WithIdentity(ClassFx.Todl, undefined, async world =>
    {
        const client = world.Connect()
        const ids = (await client.ModelView(world.MemberId)).items.map(m => m.id)
        for (const id of [ClassFx.Big, ClassFx.Premium, ClassFx.Basic, ClassFx.W1]) assert.ok(!ids.includes(id), id)
        assert.ok(ids.includes(ClassFx.Widget))
        assert.deepEqual(await client.Resources(ClassFx.Big), [])
        assert.equal(await world.Server.DevModelView().Hidden(DevWorld.Owner(), ClassFx.Big), true)
    })
})

test('a class node whose values the engine refuses is hidden, the page succeeds and a diagnostic is reported', async () =>
{
    // an organisation read restricts the scope (Default Deny), so class nodes are judged by the engine's Admits
    await DevWorld.WithIdentity(ClassFx.Todl, SecurityFx.OrgRead(ClassFx.Widget, [ViewFx.ReaderId]), async world =>
    {
        const repo = ClassFx.Repository(ClassFx.LoneSurrogate)
        assert.equal(repo.resolve(ClassFx.Premium)?.isClass, true)
        const diagnostics = new RecordingDiagnostics()
        const page = await DevWorld.Page(world.View(new FixedStructure(repo), diagnostics), DevWorld.Reader(), world.MemberId, ViewFx.All)
        const ids = page.items.map(m => m.id)
        assert.ok(!ids.includes(ClassFx.Premium))
        assert.ok(ids.includes(ClassFx.Basic))
        assert.ok(ids.includes(ClassFx.W1))
        assert.equal(diagnostics.Messages.length, 1)
        assert.ok(diagnostics.Messages[0]!.includes(ClassFx.Premium))
        // pinned: the diagnostic names the node and Concept.member only, never the refused attribute value
        assert.ok(diagnostics.Messages[0]!.includes(ClassFx.RegionMember), diagnostics.Messages[0])
        assert.ok(!diagnostics.Messages[0]!.includes(ClassFx.LoneSurrogate), 'the attribute value never reaches the diagnostic')
    })
})

test('an Admits error other than SchemaViolation is a fault: EngineModelGate rethrows it and reports nothing', async () =>
{
    await DevWorld.WithIdentity(ClassFx.Todl, SecurityFx.OrgRead(ClassFx.Widget, [ViewFx.ReaderId]), async world =>
    {
        const diagnostics = new RecordingDiagnostics()
        const host = AdmitsFaultHost.Over(world.Server.DevEngine())
        const view = new DevModelView(host, () => world.Server.DevScopes(), async () => world.Server.Manager().then(m => m.ActiveSolution), async () => new FixedStructure(ClassFx.Repository(ClassFx.Eu)), diagnostics)
        try
        {
            await assert.rejects(DevWorld.Page(view, DevWorld.Reader(), world.MemberId, ViewFx.All), new RegExp(ClassFx.AdmitsFault))
            assert.deepEqual(diagnostics.Messages, [])
        }
        finally
        {
            view.dispose()
        }
    })
})

test('switching to a rebuilt scope source drops the subscription to the previous one', async () =>
{
    await DevWorld.With(ClassFx.Todl, undefined, async world =>
    {
        const first = new CountingScopeSource(() => world.Server.DevScopes())
        const second = new CountingScopeSource(() => world.Server.DevScopes())
        let current: IDevScopeSource = first
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

test('a role downgrade hides an instance on the next model/view and stales an old cursor', async () =>
{
    await DevWorld.WithIdentity(DepthFx.Todl, SecurityFx.Qualify(PpSecurityHarness.OrgSecurityModel(ViewFx.OwnerId), DepthFx.Widget), async world =>
    {
        const client = world.Connect()
        assert.ok((await client.ModelView(world.MemberId)).items.some(m => m.id === DepthFx.W2))
        const first = await client.ModelView(world.MemberId, { pageSize: 1 })
        assert.ok(first.nextCursor !== undefined)
        await PpSecurityHarness.Seed(world.Server, DepthFx.Bu())
        const reload = await world.Server.SecurityModelReload()
        reload.Invalidate(PpSecurityHarness.TenantId)
        const ids = (await client.ModelView(world.MemberId)).items.map(m => m.id)
        assert.ok(!ids.includes(DepthFx.W2))
        assert.ok(ids.includes(DepthFx.W1))
        await assert.rejects(() => client.ModelView(world.MemberId, { cursor: first.nextCursor, pageSize: 1 }), DevWorld.IsStale)
    })
})

test('an instance only in an unsaved buffer is hidden under a restricted scope, visible under an unrestricted one', async () =>
{
    // no identity: the scope restricts no read, so the unsaved instance shows as before the engine
    await DevWorld.With(WireFx.ModelTodl, undefined, async world =>
    {
        const client = world.Connect()
        world.Language.DidChange(world.ModelUri, WireFx.EditedModelTodl)
        await world.Language.WhenIdle()
        assert.ok((await client.ModelView(world.MemberId)).items.some(m => m.id === WireFx.S6))
    })
    // depth restricts the scope: the saved snapshot has no w3, so it stays hidden even though depth would admit it
    await DevWorld.With(DepthFx.Todl, DepthFx.Bu(), async world =>
    {
        const client = world.Connect()
        world.Language.DidChange(world.ModelUri, DepthFx.SavedTodl)
        await world.Language.WhenIdle()
        const ids = (await client.ModelView(world.MemberId)).items.map(m => m.id)
        assert.ok(!ids.includes(DepthFx.W3))
        assert.equal(await world.Server.DevModelView().Hidden(DevWorld.Owner(), DepthFx.W3), true)
        assert.ok(ids.includes(DepthFx.W1))
    })
})

test('an instance whose unsaved buffer changes its concept is hidden under a restricted scope', async () =>
{
    await DevWorld.With(DepthFx.Todl, DepthFx.Bu(), async world =>
    {
        const client = world.Connect()
        assert.ok((await client.ModelView(world.MemberId)).items.some(m => m.id === DepthFx.W1))
        world.Language.DidChange(world.ModelUri, DepthFx.RetypedTodl)
        await world.Language.WhenIdle()
        const ids = (await client.ModelView(world.MemberId)).items.map(m => m.id)
        assert.ok(!ids.includes(DepthFx.W1))
        assert.ok(ids.includes(DepthFx.Widget))
    })
})

test('a saved edit is seen once the engine upgrades, and a cursor minted before it is stale', async () =>
{
    await DevWorld.With(DepthFx.Todl, DepthFx.Bu(), async world =>
    {
        const client = world.Connect()
        const before = await client.ModelView(world.MemberId, { pageSize: 1 })
        assert.ok(before.nextCursor !== undefined)
        assert.ok(!(await client.ModelView(world.MemberId)).items.some(m => m.id === DepthFx.W3))
        await world.Save(DepthFx.SavedTodl)
        const ids = (await client.ModelView(world.MemberId)).items.map(m => m.id)
        assert.ok(ids.includes(DepthFx.W3))
        assert.ok(!ids.includes(DepthFx.W2))
        await assert.rejects(() => client.ModelView(world.MemberId, { cursor: before.nextCursor, pageSize: 1 }), DevWorld.IsStale)
    })
})

test('a development handler without the dev model view reports it unavailable', async () =>
{
    await DevWorld.With(SurfaceFx.SampleTodl, undefined, async world =>
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, world.Language, await world.Server.Manager(), DevWorld.Owner(), () => Promise.reject(new Error(SurfaceFx.UnknownNode)), undefined)
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
