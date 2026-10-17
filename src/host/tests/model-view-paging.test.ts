import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, CursorStaleError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ModelViewPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { Repository, EdgeKind } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService, Edge } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { ModelReadFilter } from '../model-read-filter.js'
import type { ModelMemberPage } from '../model-read-filter.js'
import { AllowAllFieldReadMask } from '../cypher/field-masked-graph-query.js'
import type { IFieldReadMask } from '../cypher/field-masked-graph-query.js'
import type { IFieldReadMaskSource } from '../cypher/read-filter-source.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'

/** Denies exactly one (concept, field) pair; every other field is readable. */
class DenyOneFieldMask implements IFieldReadMask
{
    constructor(private readonly concept: string, private readonly field: string) {}

    public CanRead(concept: string, field: string): boolean
    {
        return !(concept === this.concept && field === this.field)
    }
}

/** Allows every field and records each (concept, field) pair it is asked about. */
class RecordingFieldMask implements IFieldReadMask
{
    private static readonly Separator = '/'

    public readonly Asked: string[] = []

    public static Key(concept: string, field: string): string
    {
        return concept + RecordingFieldMask.Separator + field
    }

    public CanRead(concept: string, field: string): boolean
    {
        this.Asked.push(RecordingFieldMask.Key(concept, field))
        return true
    }
}

class DenyOneFieldMaskSource implements IFieldReadMaskSource
{
    constructor(private readonly mask: IFieldReadMask) {}

    public async FieldReadMaskFor(): Promise<IFieldReadMask>
    {
        return this.mask
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

/** An in-memory repository: five customers (two eu, three us) under an eu-only read policy, with peer/manager edges. */
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
    public static readonly HiddenCount = 3
    public static readonly RelationshipKind = 'Relationship'
    public static readonly InstanceTier = 'Instance'
    public static readonly OntologyTier = 'Ontology'
    public static readonly Ghost = 'shop.ghost'
    public static readonly Eu2Local = 'eu2'
    public static readonly TenantId = 't1'
    public static readonly TenantName = 'Tenant One'
    public static readonly ReaderId = 'u1'
    private static readonly StringType = 'string'
    private static readonly PolicySuffix = '@policy'
    private static readonly AllowEffect = 'allow'
    private static readonly ReadAction = 'read'
    private static readonly MissingMemberPrefix = 'member must be on the page: '
    private static readonly SizePrefix = 'size '

    public static Context(): AccessContext
    {
        const tenant = new Tenant(FilterFixture.TenantId, TenantKind.SelfHosted, FilterFixture.TenantName)
        const principal = new Principal(FilterFixture.ReaderId, FilterFixture.TenantId, PrincipalKind.User, new Map(), [])
        return new AccessContext(principal, tenant, [], new ResourceAuthorizationPolicy())
    }

    public static Build(withPolicy: boolean, repo: Repository = new Repository()): Repository
    {
        const b = repo.builder()
        b.setNamespace(FilterFixture.Namespace)
        b.definePrimitive(FilterFixture.StringType)
        b.defineConcept(FilterFixture.Concept)
        b.addField(FilterFixture.Concept, FilterFixture.Region, FilterFixture.StringType)
        b.addField(FilterFixture.Concept, FilterFixture.Secret, FilterFixture.StringType)
        if (withPolicy)
        {
            const predicate = { kind: 2, op: 0, left: { kind: 0, root: 1, member: FilterFixture.Region }, right: { kind: 1, value: FilterFixture.EuValue } }
            b.definePolicy(FilterFixture.Concept + FilterFixture.PolicySuffix, FilterFixture.Concept, JSON.stringify([{ effect: FilterFixture.AllowEffect, action: FilterFixture.ReadAction, predicate }]))
        }
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

    public static Member(page: ModelMemberPage, id: string): ModelMemberPage['Items'][number]
    {
        const member = page.Items.find(m => m.id === id)
        assert.ok(member !== undefined, FilterFixture.MissingMemberPrefix + id)
        return member
    }

    public static SizeLabel(size: number): string
    {
        return FilterFixture.SizePrefix + size
    }

    /** Pages the filter from offset 0 to the end, returning every page. */
    public static Walk(filter: ModelReadFilter, provenance: ReadonlyMap<string, string>, size: number): ModelMemberPage[]
    {
        const pages: ModelMemberPage[] = []
        let offset = 0
        let page: ModelMemberPage
        do
        {
            page = filter.Page(provenance, offset, size)
            pages.push(page)
            offset += size
        }
        while (page.HasMore)
        return pages
    }

    private static Customer(b: ReturnType<Repository['builder']>, id: string, region: string): void
    {
        b.assertInstance(FilterFixture.Concept, id, false, id.slice(FilterFixture.Namespace.length + 1))
        b.setField(id, FilterFixture.Region, region)
    }
}

/** One open sample solution with five Services, plus attached client connections. */
class WireWorld
{
    private static readonly SolutionPrefix = 'mv-sol-'
    private static readonly PackagesPrefix = 'mv-pkgs-'
    private static readonly ModelFile = join('models', 'model.todl')
    private static readonly ModelFileName = 'model.todl'
    private static readonly NoConnectors = 'no connectors'
    private static readonly NoGraph = 'no graph'
    public static readonly ServiceConcept = 'acme.Service'
    public static readonly Label = 'label'
    public static readonly ModelTodl = 'namespace acme { concept Service { label : string?; } model Shop : acme { Service s1 { label = "e"; } Service s2 { label = "c"; } Service s3 { label = "a"; } Service s4 { label = "d"; } Service s5 { label = "b"; } } }'
    public static readonly PolicyModelTodl = 'namespace acme { concept Service { label : string?; } policy Service { allow read when entity.label == "a"; allow read when entity.label == "b"; allow read when entity.label == "c"; } model Shop : acme { Service s1 { label = "e"; } Service s2 { label = "c"; } Service s3 { label = "a"; } Service s4 { label = "d"; } Service s5 { label = "b"; } } }'
    public static readonly HiddenServices = ['acme.s1', 'acme.s4']
    public static readonly VisibleServices = ['acme.s2', 'acme.s3', 'acme.s5']
    public static readonly RevisionMustMove = 'the edit must move the graph revision'
    private static readonly OwnerId = 'p1'
    private static readonly TenantId = 't1'
    private static readonly TenantName = 'Tenant One'
    public static readonly EditedModelTodl = 'namespace acme { concept Service { label : string?; } model Shop : acme { Service s1 { label = "e"; } Service s2 { label = "c"; } Service s3 { label = "a"; } Service s4 { label = "d"; } Service s5 { label = "b"; } Service s6 { label = "f"; } } }'

    public readonly Language: SolutionLanguageService
    private readonly server: PragmaticServer
    private readonly manager: SolutionManagerService
    private readonly connections: { client: PragmaticClient, handler: ServerConnectionHandler }[] = []

    private constructor(server: PragmaticServer, language: SolutionLanguageService, manager: SolutionManagerService)
    {
        this.server = server
        this.Language = language
        this.manager = manager
    }

    public get MemberId(): string
    {
        return [...this.manager.ActiveSolution!.Members][0]!.Ref.path
    }

    public get ModelUri(): string
    {
        const member = [...this.manager.ActiveSolution!.Members][0]!
        return `${member.Storage!.Root}/${WireWorld.ModelFileName}`
    }

    public static Permissive(): AccessContext
    {
        const tenant = new Tenant(WireWorld.TenantId, TenantKind.SelfHosted, WireWorld.TenantName)
        const principal = new Principal(WireWorld.OwnerId, WireWorld.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(WireWorld.OwnerId, Role.Owner, new ResourceRef(ResourceKind.Tenant, WireWorld.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public Connect(fieldMasks?: IFieldReadMaskSource): PragmaticClient
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, this.Language, this.manager, WireWorld.Permissive(), () => Promise.reject(new Error(WireWorld.NoConnectors)), () => Promise.reject(new Error(WireWorld.NoGraph)), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, fieldMasks)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.connections.push({ client, handler })
        return client
    }

    public static async With(body: (world: WireWorld) => Promise<void>, modelTodl: string = WireWorld.ModelTodl): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), WireWorld.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), WireWorld.PackagesPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, WireWorld.ModelFile), modelTodl)
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        await server.OpenSolution(solution)
        const language = await server.LanguageService() as SolutionLanguageService
        const manager = await server.Manager()
        await language.WhenIdle()
        const world = new WireWorld(server, language, manager)
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
        await this.Language.WhenIdle()
        await this.manager.CloseSolution()
        await this.server.Dispose()
    }
}

test('member carries localId/namespace/tier/isClass/attrs/edges', () =>
{
    const filter = new ModelReadFilter(FilterFixture.Build(false), FilterFixture.Context(), AllowAllFieldReadMask.Instance)
    const page = filter.Page(new Map(), 0, 100)
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

test('walks every visible member once in id order', async () =>
{
    await WireWorld.With(async world =>
    {
        const client = world.Connect()
        const unpaged = await client.ModelView(world.MemberId)
        assert.equal(unpaged.nextCursor, undefined)
        const pages = await WireWorld.Walk(client, world.MemberId, 2)
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

test('hidden nodes are excluded before paging', () =>
{
    const repo = FilterFixture.Build(true)
    const n = repo.allNodes().length
    const visible = n - FilterFixture.HiddenCount
    const filter = new ModelReadFilter(repo, FilterFixture.Context(), AllowAllFieldReadMask.Instance)
    for (const size of [1, 2, 3, visible, visible + 1])
    {
        const pages = FilterFixture.Walk(filter, new Map(), size)
        const items = pages.flatMap(p => p.Items.map(m => m.id))
        assert.equal(items.length, visible, FilterFixture.SizeLabel(size))
        assert.equal(new Set(items).size, visible, FilterFixture.SizeLabel(size))
        assert.equal(pages.length, Math.ceil(visible / size), FilterFixture.SizeLabel(size))
        assert.ok(pages.slice(0, -1).every(p => p.HasMore), FilterFixture.SizeLabel(size))
        assert.equal(pages[pages.length - 1]!.HasMore, false, FilterFixture.SizeLabel(size))
        assert.ok(pages.every(p => p.Items.length > 0), FilterFixture.SizeLabel(size))
        for (const hidden of [FilterFixture.Us1, FilterFixture.Us2, FilterFixture.Us3])
        {
            assert.ok(!items.includes(hidden))
        }
    }
})

test('a field-masked attr is absent', async () =>
{
    const filter = new ModelReadFilter(FilterFixture.Build(false), FilterFixture.Context(), new DenyOneFieldMask(FilterFixture.Concept, FilterFixture.Secret))
    const member = FilterFixture.Member(filter.Page(new Map(), 0, 100), FilterFixture.Eu1)
    assert.deepEqual(member.attrs, { [FilterFixture.Region]: FilterFixture.EuValue })
    await WireWorld.With(async world =>
    {
        const client = world.Connect(new DenyOneFieldMaskSource(new DenyOneFieldMask(WireWorld.ServiceConcept, WireWorld.Label)))
        const page = await client.ModelView(world.MemberId)
        const services = page.items.filter(m => m.kind === WireWorld.ServiceConcept)
        assert.equal(services.length, 5)
        assert.ok(services.every(m => !(WireWorld.Label in m.attrs)))
        const open = await world.Connect().ModelView(world.MemberId)
        assert.ok(open.items.filter(m => m.kind === WireWorld.ServiceConcept).every(m => WireWorld.Label in m.attrs))
    })
})

test('an edge to a hidden node is dropped', () =>
{
    const filter = new ModelReadFilter(FilterFixture.Build(true), FilterFixture.Context(), AllowAllFieldReadMask.Instance)
    const member = FilterFixture.Member(filter.Page(new Map(), 0, 100), FilterFixture.Eu1)
    assert.deepEqual(member.edges, [
        { kind: FilterFixture.RelationshipKind, via: FilterFixture.Peer, to: FilterFixture.Eu2 },
        { kind: FilterFixture.RelationshipKind, via: FilterFixture.Manager, to: FilterFixture.Eu2 },
    ])
})

test('an edge whose via field is masked is dropped', () =>
{
    const filter = new ModelReadFilter(FilterFixture.Build(false), FilterFixture.Context(), new DenyOneFieldMask(FilterFixture.Concept, FilterFixture.Manager))
    const member = FilterFixture.Member(filter.Page(new Map(), 0, 100), FilterFixture.Eu1)
    assert.deepEqual(member.edges, [
        { kind: FilterFixture.RelationshipKind, via: FilterFixture.Peer, to: FilterFixture.Eu2 },
        { kind: FilterFixture.RelationshipKind, via: FilterFixture.Peer, to: FilterFixture.Us1 },
    ])
})

test('provenanceOf holds only page members', async () =>
{
    const repo = FilterFixture.Build(true)
    const provenance = new Map(repo.allNodes().map(node => [node.id, `${node.id}.todl`] as [string, string]))
    const filter = new ModelReadFilter(repo, FilterFixture.Context(), AllowAllFieldReadMask.Instance)
    for (const page of FilterFixture.Walk(filter, provenance, 2))
    {
        assert.deepEqual(Object.keys(page.ProvenanceOf).sort(), page.Items.map(m => m.id).filter(id => provenance.has(id)).sort())
    }
    await WireWorld.With(async world =>
    {
        const client = world.Connect()
        for (const page of await WireWorld.Walk(client, world.MemberId, 2))
        {
            const ids = new Set(page.items.map(m => m.id))
            assert.ok(Object.keys(page.provenanceOf).every(id => ids.has(id)))
        }
    })
})

test('a graph edit between pages makes the cursor stale', async () =>
{
    await WireWorld.With(async world =>
    {
        const client = world.Connect()
        const first = await client.ModelView(world.MemberId, { pageSize: 2 })
        assert.ok(first.nextCursor !== undefined)
        const before = world.Language.GraphRevision
        client.DidChange(world.ModelUri, WireWorld.EditedModelTodl)
        // the notification is fire-and-forget: a round-trip request flushes it ahead of WhenIdle
        await client.ModelView(world.MemberId, { pageSize: 1 })
        await world.Language.WhenIdle()
        assert.ok(world.Language.GraphRevision > before, WireWorld.RevisionMustMove)
        await assert.rejects(() => client.ModelView(world.MemberId, { cursor: first.nextCursor, pageSize: 2 }), WireWorld.IsStale)
    })
})

test('a non-positive pageSize is rejected', async () =>
{
    await WireWorld.With(async world =>
    {
        const client = world.Connect()
        await assert.rejects(() => client.ModelView(world.MemberId, { pageSize: 0 }), WireWorld.IsInvalidParams)
        await assert.rejects(() => client.ModelView(world.MemberId, { pageSize: 1.5 }), WireWorld.IsInvalidParams)
    })
})

test('an edge to an unresolvable node is dropped', () =>
{
    // the graph store rejects a dangling edge on insert, so a repository surfaces one from outEdges instead
    const repo = FilterFixture.Build(false, new DanglingEdgeRepository(FilterFixture.Eu1, FilterFixture.Peer, FilterFixture.Ghost))
    assert.equal(repo.resolve(FilterFixture.Ghost), undefined)
    assert.ok(repo.outEdges(FilterFixture.Eu1).some(e => e.to === FilterFixture.Ghost))
    const filter = new ModelReadFilter(repo, FilterFixture.Context(), AllowAllFieldReadMask.Instance)
    const member = FilterFixture.Member(filter.Page(new Map(), 0, 100), FilterFixture.Eu1)
    assert.ok(member.edges.length > 0)
    assert.ok(member.edges.every(e => e.to !== FilterFixture.Ghost))
})

test('a via that resolves to a visible node is kept and masked by its localId', () =>
{
    const repo = FilterFixture.Build(true)
    repo.addEdge({ kind: EdgeKind.Relationship, via: FilterFixture.Eu2, from: FilterFixture.Eu1, to: FilterFixture.Eu2 })
    const mask = new RecordingFieldMask()
    const filter = new ModelReadFilter(repo, FilterFixture.Context(), mask)
    const member = FilterFixture.Member(filter.Page(new Map(), 0, 100), FilterFixture.Eu1)
    assert.ok(member.edges.some(e => e.via === FilterFixture.Eu2 && e.to === FilterFixture.Eu2))
    assert.ok(mask.Asked.includes(RecordingFieldMask.Key(FilterFixture.Concept, FilterFixture.Eu2Local)))
    assert.ok(!mask.Asked.includes(RecordingFieldMask.Key(FilterFixture.Concept, FilterFixture.Eu2)))
})

test('a via that resolves to a hidden node is dropped', () =>
{
    const repo = FilterFixture.Build(true)
    repo.addEdge({ kind: EdgeKind.Relationship, via: FilterFixture.Us2, from: FilterFixture.Eu1, to: FilterFixture.Eu2 })
    assert.ok(repo.outEdges(FilterFixture.Eu1).some(e => e.via === FilterFixture.Us2))
    const filter = new ModelReadFilter(repo, FilterFixture.Context(), AllowAllFieldReadMask.Instance)
    const member = FilterFixture.Member(filter.Page(new Map(), 0, 100), FilterFixture.Eu1)
    assert.ok(member.edges.length > 0)
    assert.ok(member.edges.every(e => e.via !== FilterFixture.Us2))
})

test('under a hiding policy the wire nextCursor is absent exactly on the last page', async () =>
{
    await WireWorld.With(async world =>
    {
        const client = world.Connect()
        const unpaged = await client.ModelView(world.MemberId)
        const ids = unpaged.items.map(m => m.id)
        for (const hidden of WireWorld.HiddenServices)
        {
            assert.ok(!ids.includes(hidden))
        }
        for (const shown of WireWorld.VisibleServices)
        {
            assert.ok(ids.includes(shown))
        }
        for (const size of [1, 2, ids.length])
        {
            const pages = await WireWorld.Walk(client, world.MemberId, size)
            assert.deepEqual(pages.flatMap(p => p.items.map(m => m.id)), ids, FilterFixture.SizeLabel(size))
            assert.equal(pages.length, Math.ceil(ids.length / size), FilterFixture.SizeLabel(size))
            assert.ok(pages.slice(0, -1).every(p => p.nextCursor !== undefined && p.items.length === size), FilterFixture.SizeLabel(size))
            assert.equal(pages[pages.length - 1]!.nextCursor, undefined, FilterFixture.SizeLabel(size))
        }
    }, WireWorld.PolicyModelTodl)
})
