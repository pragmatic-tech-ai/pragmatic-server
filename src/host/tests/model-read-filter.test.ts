import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Repository } from '@pragmatic-tech-ai/todl'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { ModelReadFilter } from '../model-read-filter.js'

class ModelFixture
{
    public static readonly Concept = 'shop.Customer'
    public static readonly Region = 'region'
    public static readonly Eu = 'shop.Customer:cust-eu'
    public static readonly Us = 'shop.Customer:cust-us'

    public static Context(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('u1', 't1', PrincipalKind.User, new Map(), [])
        return new AccessContext(principal, tenant, [], new ResourceAuthorizationPolicy())
    }

    public static Base(repo: Repository): void
    {
        const b = repo.builder()
        b.definePrimitive('string')
        b.defineConcept(ModelFixture.Concept)
        b.addField(ModelFixture.Concept, ModelFixture.Region, 'string')
        b.assertInstance(ModelFixture.Concept, ModelFixture.Eu)
        b.setField(ModelFixture.Eu, ModelFixture.Region, 'eu')
        b.assertInstance(ModelFixture.Concept, ModelFixture.Us)
        b.setField(ModelFixture.Us, ModelFixture.Region, 'us')
        b.commit()
    }

    public static WithPolicy(): Repository
    {
        const repo = new Repository()
        const b = repo.builder()
        b.definePrimitive('string')
        b.defineConcept(ModelFixture.Concept)
        b.addField(ModelFixture.Concept, ModelFixture.Region, 'string')
        const predicate = { kind: 2, op: 0, left: { kind: 0, root: 1, member: ModelFixture.Region }, right: { kind: 1, value: 'eu' } }
        b.definePolicy(`${ModelFixture.Concept}@policy`, ModelFixture.Concept, JSON.stringify([{ effect: 'allow', action: 'read', predicate }]))
        b.assertInstance(ModelFixture.Concept, ModelFixture.Eu)
        b.setField(ModelFixture.Eu, ModelFixture.Region, 'eu')
        b.assertInstance(ModelFixture.Concept, ModelFixture.Us)
        b.setField(ModelFixture.Us, ModelFixture.Region, 'us')
        b.commit()
        return repo
    }

    public static NoPolicy(): Repository
    {
        const repo = new Repository()
        ModelFixture.Base(repo)
        return repo
    }
}

test('a policy allow-where rule keeps the matching instance and drops the rest', () =>
{
    const filter = new ModelReadFilter(ModelFixture.WithPolicy(), ModelFixture.Context())
    const ids = filter.Project(new Map()).members.map(member => member.id)
    assert.ok(ids.includes(ModelFixture.Eu))
    assert.ok(!ids.includes(ModelFixture.Us))
})

test('a hidden instance id does not leak through provenanceOf', () =>
{
    const filter = new ModelReadFilter(ModelFixture.WithPolicy(), ModelFixture.Context())
    const provenance = new Map([[ModelFixture.Eu, 'a.todl'], [ModelFixture.Us, 'b.todl']])
    const projection = filter.Project(provenance)
    assert.equal(projection.provenanceOf[ModelFixture.Eu], 'a.todl')
    assert.equal(ModelFixture.Us in projection.provenanceOf, false)
})

test('Hidden reports the dropped instance and not the permitted one', () =>
{
    const filter = new ModelReadFilter(ModelFixture.WithPolicy(), ModelFixture.Context())
    assert.equal(filter.Hidden(ModelFixture.Us), true)
    assert.equal(filter.Hidden(ModelFixture.Eu), false)
})

test('a model with no policy keeps every instance', () =>
{
    const filter = new ModelReadFilter(ModelFixture.NoPolicy(), ModelFixture.Context())
    const ids = filter.Project(new Map()).members.map(member => member.id)
    assert.ok(ids.includes(ModelFixture.Eu))
    assert.ok(ids.includes(ModelFixture.Us))
})

test('Hidden is false for an id the model cannot resolve', () =>
{
    const filter = new ModelReadFilter(ModelFixture.WithPolicy(), ModelFixture.Context())
    assert.equal(filter.Hidden('shop.Customer:does-not-exist'), false)
})

test('a structural definition node survives filtering', () =>
{
    const filter = new ModelReadFilter(ModelFixture.WithPolicy(), ModelFixture.Context())
    const ids = filter.Project(new Map()).members.map(member => member.id)
    assert.ok(ids.includes(ModelFixture.Concept))
})
