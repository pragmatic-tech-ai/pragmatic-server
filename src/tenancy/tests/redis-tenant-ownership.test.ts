import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from 'redis'
import type { RedisClientType } from 'redis'
import { RedisTenantOwnership } from '../redis-tenant-ownership.js'

const url = process.env.PRAGMATIC_TEST_REDIS_URL

test('redis ownership: exactly one instance owns a tenant; release frees it', { skip: url === undefined ? 'set PRAGMATIC_TEST_REDIS_URL to run' : false }, async () =>
{
    const tenant = `t-${Date.now()}`
    const a = new RedisTenantOwnership(url as string, 'replica-a')
    const b = new RedisTenantOwnership(url as string, 'replica-b')
    await a.Start()
    await b.Start()
    try
    {
        assert.equal(await a.Acquire(tenant), true)
        assert.equal(await b.Acquire(tenant), false)
        assert.equal(await a.Acquire(tenant), true)
        assert.equal(a.Healthy(), true)
        await a.Release(tenant)
        assert.equal(await b.Acquire(tenant), true)
    }
    finally
    {
        await a.ReleaseAll()
        await b.ReleaseAll()
    }
})

test('redis ownership: renew keeps ownership and the lost handler does not fire while held', { skip: url === undefined ? 'set PRAGMATIC_TEST_REDIS_URL to run' : false }, async () =>
{
    const tenant = `t-${Date.now()}-renew`
    const a = new RedisTenantOwnership(url as string, 'replica-a')
    let lost = ''
    a.OnLost(id => { lost = id })
    await a.Start()
    try
    {
        assert.equal(await a.Acquire(tenant), true)
        await a.RenewNowForTest()
        assert.equal(lost, '')
        assert.equal(await a.Acquire(tenant), true)
    }
    finally
    {
        await a.ReleaseAll()
    }
})

test('redis ownership: a lost lease fires OnLost and drops the stale held entry', { skip: url === undefined ? 'set PRAGMATIC_TEST_REDIS_URL to run' : false }, async () =>
{
    const tenant = `t-${Date.now()}-lost`
    const a = new RedisTenantOwnership(url as string, 'replica-a')
    const b = new RedisTenantOwnership(url as string, 'replica-b')
    let lost = ''
    a.OnLost(id => { lost = id })
    await a.Start()
    await b.Start()
    const raw = createClient({ url: url as string })
    await raw.connect()
    try
    {
        assert.equal(await a.Acquire(tenant), true)
        await raw.del(`pragmatic:own:${tenant}`)
        assert.equal(await b.Acquire(tenant), true)
        await a.RenewNowForTest()
        assert.equal(lost, tenant)
        assert.equal(await a.Acquire(tenant), false)
    }
    finally
    {
        await raw.quit()
        await a.ReleaseAll()
        await b.ReleaseAll()
    }
})

test('a held key not renewable within the lease TTL is given up (lapse)', async () =>
{
    let clock = 1_000
    let evalShouldReject = false
    const fake =
    {
        isOpen: true,
        on(): void {},
        async connect(): Promise<void> {},
        async quit(): Promise<void> {},
        async set(): Promise<string | null> { return 'OK' },
        async eval(): Promise<number>
        {
            if (evalShouldReject)
            {
                throw new Error('unreachable')
            }
            return 1
        },
    }
    const ownership = new RedisTenantOwnership('redis://unused', 'replica-a', () => clock, () => fake as unknown as RedisClientType)
    let lost = ''
    ownership.OnLost(id => { lost = id })
    await ownership.Start()
    assert.equal(await ownership.Acquire('acme'), true)
    evalShouldReject = true
    clock += 30_000 // the lease TTL: past the drop threshold (TTL minus one renew cycle)
    await ownership.RenewNowForTest()
    assert.equal(lost, 'acme')
    await ownership.ReleaseAll()
})

test('Acquire fails closed (returns false) when the Redis command errors', async () =>
{
    const fake =
    {
        isOpen: true,
        on(): void {},
        async connect(): Promise<void> {},
        async quit(): Promise<void> {},
        async set(): Promise<string | null> { throw new Error('unreachable') },
        async eval(): Promise<number> { return 1 },
    }
    const ownership = new RedisTenantOwnership('redis://unused', 'replica-a', () => 1000, () => fake as unknown as RedisClientType)
    await ownership.Start()
    assert.equal(await ownership.Acquire('acme'), false)
    assert.equal(ownership.Healthy(), false)
    await ownership.ReleaseAll()
})

test('health recovers via the heartbeat after Redis comes back, with no held keys', async () =>
{
    let up = false
    const fake =
    {
        get isOpen() { return up },
        on(): void {},
        async connect(): Promise<void> { if (!up) { throw new Error('down') } },
        async quit(): Promise<void> {},
        async set(): Promise<string | null> { return 'OK' },
        async eval(): Promise<number> { return 1 },
    }
    const ownership = new RedisTenantOwnership('redis://unused', 'replica-a', () => 1000, () => fake as unknown as RedisClientType)
    await ownership.Start().catch(() => {})
    assert.equal(ownership.Healthy(), false)
    up = true
    await ownership.RenewNowForTest()
    assert.equal(ownership.Healthy(), true)
    await ownership.ReleaseAll()
})

test('a Release that fails while Redis is down is flushed on the next successful renew tick', async () =>
{
    let failEval = true
    const evals: Array<{ keys: string[], args: string[] }> = []
    const fake =
    {
        isOpen: true,
        on(): void {},
        async connect(): Promise<void> {},
        async quit(): Promise<void> {},
        async set(): Promise<string | null> { return 'OK' },
        async eval(_script: string, opts: { keys: string[], arguments: string[] }): Promise<number>
        {
            if (failEval)
            {
                throw new Error('unreachable')
            }
            evals.push({ keys: opts.keys, args: opts.arguments })
            return 1
        },
    }
    const ownership = new RedisTenantOwnership('redis://unused', 'replica-a', () => 1000, () => fake as unknown as RedisClientType)
    await ownership.Start()
    assert.equal(await ownership.Acquire('t1'), true)
    await ownership.Release('t1')
    assert.equal(ownership.PendingReleaseCountForTest(), 1)
    failEval = false
    await ownership.RenewNowForTest()
    assert.equal(ownership.PendingReleaseCountForTest(), 0)
    assert.ok(evals.some(e => e.keys[0] === 'pragmatic:own:t1'))
    await ownership.ReleaseAll()
})
