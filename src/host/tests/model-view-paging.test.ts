import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Repository, EdgeKind } from '@pragmatic-tech-ai/todl'
import type { Edge } from '@pragmatic-tech-ai/todl'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { ModelReadFilter } from '../model-read-filter.js'
import type { ModelMemberPage } from '../model-projection.js'
import { AllowAllFieldReadMask } from '../cypher/field-masked-graph-query.js'
import type { IFieldReadMask } from '../cypher/field-masked-graph-query.js'

/*
 * The runtime (non-dev) ModelReadFilter over an in-memory repository. The dev tenant's model/view runs on the dev
 * graph engine (DevModelView): this file's wire cases, and engine ports of every case here, live in
 * host/engine/tests/dev-model-view.test.ts.
 */

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

test('a field-masked attr is absent', () =>
{
    const filter = new ModelReadFilter(FilterFixture.Build(false), FilterFixture.Context(), new DenyOneFieldMask(FilterFixture.Concept, FilterFixture.Secret))
    const member = FilterFixture.Member(filter.Page(new Map(), 0, 100), FilterFixture.Eu1)
    assert.deepEqual(member.attrs, { [FilterFixture.Region]: FilterFixture.EuValue })
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

test('provenanceOf holds only page members', () =>
{
    const repo = FilterFixture.Build(true)
    const provenance = new Map(repo.allNodes().map(node => [node.id, `${node.id}.todl`] as [string, string]))
    const filter = new ModelReadFilter(repo, FilterFixture.Context(), AllowAllFieldReadMask.Instance)
    for (const page of FilterFixture.Walk(filter, provenance, 2))
    {
        assert.deepEqual(Object.keys(page.ProvenanceOf).sort(), page.Items.map(m => m.id).filter(id => provenance.has(id)).sort())
    }
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
