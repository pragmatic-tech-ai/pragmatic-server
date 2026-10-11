import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { RedisWorkerRouter } from '../redis-worker-router.js'

class RedisFixture
{
    public static readonly UrlEnv = 'PRAGMATIC_TEST_REDIS_URL'
    public static readonly Host = '127.0.0.1'

    public static Url(): string | undefined
    {
        return process.env[RedisFixture.UrlEnv]
    }

    public static Tenant(): string
    {
        return `t-${randomBytes(6).toString('hex')}`
    }
}

test('the first router to claim a tenant owns it; a second router sees that lease and routes to it', async t =>
{
    const url = RedisFixture.Url()
    if (url === undefined)
    {
        t.skip('PRAGMATIC_TEST_REDIS_URL not set')
        return
    }
    const tenant = RedisFixture.Tenant()
    const r1 = new RedisWorkerRouter(url, { host: RedisFixture.Host, port: 7001 })
    const r2 = new RedisWorkerRouter(url, { host: RedisFixture.Host, port: 7002 })
    try
    {
        const a = await r1.RouteOrSpawn(tenant)
        assert.deepEqual(a, { host: RedisFixture.Host, port: 7001 })
        const b = await r2.RouteOrSpawn(tenant)
        assert.deepEqual(b, { host: RedisFixture.Host, port: 7001 })
    }
    finally
    {
        await r1.Drain()
        await r2.Drain()
    }
})
