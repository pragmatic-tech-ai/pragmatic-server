import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check } from '@pragmatic-tech-ai/todl'
import type { Repository } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { ModelShardCache } from '../model-shard-cache.js'
import type { LocatedShard } from '../model-shard-graph.js'
import type { TenantRepository } from '../tenant-graph-source.js'

/** Counts shard builds so a test can see reuse and invalidation. */
class CountingShardCache extends ModelShardCache
{
    public Builds = 0

    protected override Build(shard: LocatedShard): Promise<IGraphQuery>
    {
        this.Builds++
        return super.Build(shard)
    }
}

class ShardFixture
{
    public static readonly Source = 'namespace acme { concept Widget { } '
        + 'model ShopA : acme { Widget a1 { label = "alpha"; } } model ShopB : acme { Widget b1 { label = "beta"; } } }'

    public static Repo(): Repository
    {
        return check([{ uri: 'model.todl', text: ShardFixture.Source }]).model
    }

    public static Cache(repos: () => readonly Repository[]): CountingShardCache
    {
        return new CountingShardCache(async () => repos().map((repo): TenantRepository => ({ repo, model: 'm', version: '0.0.0' })))
    }
}

test('lists every member shard id, sorted, and locates only members', async () =>
{
    const repo = ShardFixture.Repo()
    const cache = ShardFixture.Cache(() => [repo])
    const ids = await cache.Ids()
    assert.equal(ids.length, 2)
    assert.deepEqual(ids, [...ids].sort())
    assert.ok((await cache.Locate(ids[0]!)) !== undefined)
    assert.equal(await cache.Locate('acme.missing'), undefined)
})

test('a shard graph is built once and shared until a source repository changes', async () =>
{
    const repo = ShardFixture.Repo()
    const cache = ShardFixture.Cache(() => [repo])
    const shard = (await cache.Locate((await cache.Ids())[0]!))!
    const first = await cache.Graph(shard)
    assert.equal(await cache.Graph(shard), first)
    assert.equal(cache.Builds, 1)
    repo.changed.emit({} as never)
    const again = (await cache.Locate(shard.Name))!
    assert.notEqual(await cache.Graph(again), first)
    assert.equal(cache.Builds, 2)
    cache.Dispose()
})

test('a different source set rebuilds the index', async () =>
{
    let repos = [ShardFixture.Repo()]
    const cache = ShardFixture.Cache(() => repos)
    const shard = (await cache.Locate((await cache.Ids())[0]!))!
    await cache.Graph(shard)
    repos = [ShardFixture.Repo()]
    const moved = (await cache.Locate(shard.Name))!
    assert.equal(moved.Repo, repos[0])
    await cache.Graph(moved)
    assert.equal(cache.Builds, 2)
})

test('a shard located before an invalidation is built for its caller but never cached for the new generation', async () =>
{
    const repo = ShardFixture.Repo()
    const cache = ShardFixture.Cache(() => [repo])
    const name = (await cache.Ids())[0]!
    const stale = (await cache.Locate(name))!
    repo.changed.emit({} as never)
    const fresh = (await cache.Locate(name))!
    assert.notEqual(fresh, stale)
    const staleGraph = await cache.Graph(stale)
    const freshGraph = await cache.Graph(fresh)
    assert.notEqual(freshGraph, staleGraph)
    assert.equal(await cache.Graph(fresh), freshGraph)
    assert.equal(cache.Builds, 2)
})

test('after Dispose the cache still answers but never re-subscribes to repositories', async () =>
{
    const repo = ShardFixture.Repo()
    let live = 0
    const subscribe = repo.changed.subscribe.bind(repo.changed)
    repo.changed.subscribe = handler =>
    {
        live++
        const inner = subscribe(handler)
        return { dispose: () => { live--; inner.dispose() } } as ReturnType<typeof subscribe>
    }
    const cache = ShardFixture.Cache(() => [repo])
    await cache.Ids()
    assert.equal(live, 1)
    cache.Dispose()
    assert.equal(live, 0)
    assert.equal((await cache.Ids()).length, 2)
    assert.equal(live, 0)
})
