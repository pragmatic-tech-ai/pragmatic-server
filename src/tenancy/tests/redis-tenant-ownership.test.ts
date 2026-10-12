import { test } from 'node:test'
import assert from 'node:assert/strict'
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
