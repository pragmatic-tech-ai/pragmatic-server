import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Repository, Cypher } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { TenantGraphCache } from '../tenant-graph-cache.js'
import type { TenantGraphArtifact, TenantRepository } from '../tenant-graph-source.js'

class CacheFixture
{
    public static readonly Customer = 'Customer'
    public static readonly Order = 'Purchase'
    public static readonly Region = 'region'
    public static readonly Name = 'name'
    public static readonly Eu = 'Customer:cust-eu'
    public static readonly Us = 'Customer:cust-us'
    public static readonly OrderEu = 'Purchase:o-eu'
    public static readonly OrderUs = 'Purchase:o-us'
    public static readonly CountQuery = 'MATCH (x:Customer) RETURN count(x) AS n'
    public static readonly NamesQuery = 'MATCH (x:Customer) RETURN x.name AS name'
    public static readonly TraverseQuery = 'MATCH (o:Purchase)-[:buyer]->(c:Customer) RETURN c.name AS name'
    public static readonly EdgeCountQuery = 'MATCH ()-[r:buyer]->() RETURN count(r) AS n'
    public static readonly Shared = 'Customer:shared'
    public static readonly OrderCountQuery = 'MATCH (o:Purchase) RETURN count(o) AS n'

    public static Context(region: string): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('u1', 't1', PrincipalKind.User, new Map([[CacheFixture.Region, region]]), [])
        return new AccessContext(principal, tenant, [], new ResourceAuthorizationPolicy())
    }

    /** Customers are readable only where customer.region equals the principal's region claim. */
    public static Repo(): Repository
    {
        const repo = new Repository()
        const b = repo.builder()
        b.definePrimitive('string')
        b.defineConcept(CacheFixture.Customer)
        b.defineConcept(CacheFixture.Order)
        b.addField(CacheFixture.Customer, CacheFixture.Region, 'string')
        b.addField(CacheFixture.Customer, CacheFixture.Name, 'string')
        b.addConceptRelationship(CacheFixture.Order, 'buyer', [CacheFixture.Customer])
        const predicate = { kind: 2, op: 0, left: { kind: 0, root: 1, member: CacheFixture.Region }, right: { kind: 0, root: 0, member: CacheFixture.Region } }
        b.definePolicy(`${CacheFixture.Customer}@policy`, CacheFixture.Customer, JSON.stringify([{ effect: 'allow', action: 'read', predicate }]))
        CacheFixture.AddCustomer(b, CacheFixture.Eu, 'eu', 'Eve')
        CacheFixture.AddCustomer(b, CacheFixture.Us, 'us', 'Uma')
        b.assertInstance(CacheFixture.Order, CacheFixture.OrderEu)
        b.addRelationship(CacheFixture.OrderEu, 'buyer', CacheFixture.Eu)
        b.assertInstance(CacheFixture.Order, CacheFixture.OrderUs)
        b.addRelationship(CacheFixture.OrderUs, 'buyer', CacheFixture.Us)
        b.commit()
        return repo
    }

    /** One customer with a fixed id, region us; optionally guarded by the region-claim read policy. */
    public static SharedRepo(withPolicy: boolean): Repository
    {
        const repo = new Repository()
        const b = repo.builder()
        b.definePrimitive('string')
        b.defineConcept(CacheFixture.Customer)
        b.addField(CacheFixture.Customer, CacheFixture.Region, 'string')
        b.addField(CacheFixture.Customer, CacheFixture.Name, 'string')
        if (withPolicy)
        {
            const predicate = { kind: 2, op: 0, left: { kind: 0, root: 1, member: CacheFixture.Region }, right: { kind: 0, root: 0, member: CacheFixture.Region } }
            b.definePolicy(`${CacheFixture.Customer}@policy`, CacheFixture.Customer, JSON.stringify([{ effect: 'allow', action: 'read', predicate }]))
        }
        CacheFixture.AddCustomer(b, CacheFixture.Shared, 'us', 'Uma')
        b.commit()
        return repo
    }

    public static AddCustomer(b: ReturnType<Repository['builder']>, id: string, region: string, name: string): void
    {
        b.assertInstance(CacheFixture.Customer, id)
        b.setField(id, CacheFixture.Region, region)
        b.setField(id, CacheFixture.Name, name)
    }

    public static Rows(query: IGraphQuery, text: string): unknown[]
    {
        const result = Cypher.CypherEngine.OverQuery(query).Execute(text)
        return result.Rows.map(r => (r[0] instanceof Cypher.ScalarValue ? r[0].Value : r[0]))
    }
}

class CountingCache extends TenantGraphCache
{
    public ComposeCalls = 0

    protected override Compose(entries: readonly TenantRepository[]): TenantGraphArtifact
    {
        this.ComposeCalls++
        return super.Compose(entries)
    }
}

test('a policy-hidden instance is absent from count, direct return and traversal', async () =>
{
    const cache = new TenantGraphCache(() => [{ repo: CacheFixture.Repo(), model: 'shop', version: '1.0.0' }])
    const query = await cache.GraphFor(CacheFixture.Context('eu'))
    assert.deepEqual(CacheFixture.Rows(query, CacheFixture.CountQuery), [1])
    assert.deepEqual(CacheFixture.Rows(query, CacheFixture.NamesQuery), ['Eve'])
    assert.deepEqual(CacheFixture.Rows(query, CacheFixture.TraverseQuery), ['Eve'])
    assert.deepEqual(CacheFixture.Rows(query, CacheFixture.OrderCountQuery), [2])
    // Edge filter pinned on its own: the buyer edge touching the hidden customer is gone.
    assert.deepEqual(CacheFixture.Rows(query, CacheFixture.EdgeCountQuery), [1])
    cache.Dispose()
})

test('two principals see different instance sets from the same cached artifact', async () =>
{
    const repo = CacheFixture.Repo()
    const cache = new CountingCache(() => [{ repo, model: 'shop', version: '1.0.0' }])
    const eu = await cache.GraphFor(CacheFixture.Context('eu'))
    const us = await cache.GraphFor(CacheFixture.Context('us'))
    assert.deepEqual(CacheFixture.Rows(eu, CacheFixture.NamesQuery), ['Eve'])
    assert.deepEqual(CacheFixture.Rows(us, CacheFixture.NamesQuery), ['Uma'])
    assert.equal(cache.ComposeCalls, 1)
    cache.Dispose()
})

test('a repository change invalidates the cache and the next call recomposes', async () =>
{
    const repo = CacheFixture.Repo()
    const cache = new CountingCache(() => [{ repo, model: 'shop', version: '1.0.0' }])
    await cache.GraphFor(CacheFixture.Context('eu'))
    await cache.GraphFor(CacheFixture.Context('eu'))
    assert.equal(cache.ComposeCalls, 1)
    const b = repo.builder()
    CacheFixture.AddCustomer(b, 'Customer:cust-eu2', 'eu', 'Eli')
    b.commit()
    const query = await cache.GraphFor(CacheFixture.Context('eu'))
    assert.equal(cache.ComposeCalls, 2)
    assert.deepEqual(CacheFixture.Rows(query, CacheFixture.CountQuery), [2])
    cache.Dispose()
})

test('an id denied by ANY repository containing it is dropped everywhere (deny-wins)', async () =>
{
    const guarded = CacheFixture.SharedRepo(true)
    const open = CacheFixture.SharedRepo(false)
    const cache = new TenantGraphCache(() => [
        { repo: guarded, model: 'guarded', version: '1.0.0' },
        { repo: open, model: 'open', version: '1.0.0' },
    ])
    const eu = await cache.GraphFor(CacheFixture.Context('eu'))
    assert.deepEqual(CacheFixture.Rows(eu, CacheFixture.NamesQuery), [])
    assert.deepEqual(CacheFixture.Rows(eu, CacheFixture.CountQuery), [0])
    const us = await cache.GraphFor(CacheFixture.Context('us'))
    assert.deepEqual(CacheFixture.Rows(us, CacheFixture.NamesQuery), ['Uma'])
    cache.Dispose()
})
