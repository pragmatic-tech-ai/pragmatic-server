import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { FakeRedisStore } from './fake-redis.js'
import { RedisWorkerRouter, NoWorkersAvailableError } from '../redis-worker-router.js'
import { WorkerRegistration } from '../worker-registration.js'

class Clock
{
    public value = 1_000_000

    public now = (): number => this.value
}

class Workers
{
    public static readonly Key = 'pragmatic:workers'

    public static Seed(store: FakeRedisStore, host: string, port: number, score: number): void
    {
        store.ZAdd(Workers.Key, { score, value: JSON.stringify({ host, port }) })
    }
}

test('routes a tenant to a live worker and claims the route', async () =>
{
    const store = new FakeRedisStore()
    const clock = new Clock()
    Workers.Seed(store, 'w1', 9001, clock.value + 30_000)
    const router = new RedisWorkerRouter('redis://x', clock.now, () => store.Client())
    const ep = await router.RouteOrSpawn('acme')
    assert.deepEqual(ep, { host: 'w1', port: 9001 })
    assert.equal(store.GetString('pragmatic:route:acme'), JSON.stringify({ host: 'w1', port: 9001 }))
    await router.Drain()
})

test('renews an active claim when its worker is still live (Review Focus 4)', async () =>
{
    const store = new FakeRedisStore()
    const clock = new Clock()
    Workers.Seed(store, 'w1', 9001, clock.value + 30_000)
    store.SetString('pragmatic:route:acme', JSON.stringify({ host: 'w1', port: 9001 }))
    store.SetPx('pragmatic:route:acme', 1)
    const router = new RedisWorkerRouter('redis://x', clock.now, () => store.Client())
    const ep = await router.RouteOrSpawn('acme')
    assert.deepEqual(ep, { host: 'w1', port: 9001 })
    assert.equal(store.PxOf('pragmatic:route:acme'), 30_000)
    await router.Drain()
})

test('re-homes to a live worker when the claimed worker is gone (Review Focus 2)', async () =>
{
    const store = new FakeRedisStore()
    const clock = new Clock()
    Workers.Seed(store, 'w2', 9002, clock.value + 30_000)
    store.SetString('pragmatic:route:acme', JSON.stringify({ host: 'w1', port: 9001 }))
    const router = new RedisWorkerRouter('redis://x', clock.now, () => store.Client())
    const ep = await router.RouteOrSpawn('acme')
    assert.deepEqual(ep, { host: 'w2', port: 9002 })
    assert.equal(store.GetString('pragmatic:route:acme'), JSON.stringify({ host: 'w2', port: 9002 }))
    await router.Drain()
})

test('two routers over one store converge to the same worker on a cold tenant (Review Focus 3)', async () =>
{
    const store = new FakeRedisStore()
    const clock = new Clock()
    Workers.Seed(store, 'wa', 1, clock.value + 30_000)
    Workers.Seed(store, 'wb', 2, clock.value + 30_000)
    const r1 = new RedisWorkerRouter('redis://x', clock.now, () => store.Client())
    const r2 = new RedisWorkerRouter('redis://x', clock.now, () => store.Client())
    const a = await r1.RouteOrSpawn('acme')
    const b = await r2.RouteOrSpawn('acme')
    assert.deepEqual(a, b)
    await r1.Drain()
    await r2.Drain()
})

test('an empty worker set fails closed (Review Focus 1)', async () =>
{
    const store = new FakeRedisStore()
    const clock = new Clock()
    const router = new RedisWorkerRouter('redis://x', clock.now, () => store.Client())
    await assert.rejects(() => router.RouteOrSpawn('acme'), NoWorkersAvailableError)
    await router.Drain()
})

test('gated-live: a registered worker is routed to; after it stops, the tenant re-homes', async t =>
{
    const url = process.env.PRAGMATIC_TEST_REDIS_URL
    if (url === undefined)
    {
        t.skip('PRAGMATIC_TEST_REDIS_URL not set')
        return
    }
    const tenant = `t-${randomBytes(6).toString('hex')}`
    const w1 = new WorkerRegistration(url, { host: '127.0.0.1', port: 7001 })
    const w2 = new WorkerRegistration(url, { host: '127.0.0.1', port: 7002 })
    const router = new RedisWorkerRouter(url)
    try
    {
        await w1.Start()
        await w2.Start()
        const first = await router.RouteOrSpawn(tenant)
        assert.ok(first.port === 7001 || first.port === 7002)
        await (first.port === 7001 ? w1 : w2).Drain()
        const second = await router.RouteOrSpawn(tenant)
        assert.notEqual(second.port, first.port)
    }
    finally
    {
        await w1.Drain().catch(() => {})
        await w2.Drain().catch(() => {})
        await router.Drain()
    }
})
