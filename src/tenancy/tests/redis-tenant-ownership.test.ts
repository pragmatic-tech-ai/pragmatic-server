import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from 'redis'
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

test('redis ownership: a key not renewable within the lease TTL is given up', { skip: url === undefined ? 'set PRAGMATIC_TEST_REDIS_URL to run' : false }, async () =>
{
    const tenant = `t-${Date.now()}-lapse`
    let clock = 1_000_000
    const a = new RedisTenantOwnership(url as string, 'replica-a', () => clock)
    let lost = ''
    a.OnLost(id => { lost = id })
    await a.Start()
    const raw = createClient({ url: url as string })
    await raw.connect()
    try
    {
        assert.equal(await a.Acquire(tenant), true)
        await raw.del(`pragmatic:own:${tenant}`)
        clock += 31_000
        await a.RenewNowForTest()
        assert.equal(lost, tenant)
        assert.equal(await a.Acquire(tenant), true)
    }
    finally
    {
        await raw.quit()
        await a.ReleaseAll()
    }
})
