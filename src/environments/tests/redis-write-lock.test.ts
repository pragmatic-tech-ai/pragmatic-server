import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RedisWriteLock, RedisWriteLockTiming, type IRedisLockClient } from '../redis-write-lock.js'
import { WriteLockBusyError } from '../../host/cypher/write-lock.js'

/** An in-memory stand-in for the three Redis commands (SET NX, GET, and the CAS scripts), keyed by script text prefix. */
class FakeRedis implements IRedisLockClient
{
    public readonly Keys = new Map<string, string>()
    public Down = false

    public async set(key: string, value: string): Promise<string | null>
    {
        this.Check()
        if (this.Keys.has(key)) return null
        this.Keys.set(key, value)
        return 'OK'
    }

    public async get(key: string): Promise<string | null>
    {
        this.Check()
        return this.Keys.get(key) ?? null
    }

    public async eval(script: string, options: { keys: string[], arguments: string[] }): Promise<unknown>
    {
        this.Check()
        const [key] = options.keys
        if (this.Keys.get(key!) !== options.arguments[0]) return 0
        if (script.includes('del')) this.Keys.delete(key!)
        return 1
    }

    private Check(): void
    {
        if (this.Down) throw new Error('redis down')
    }
}

class LockHarness
{
    public static readonly Env = 'env-1'
    public readonly Redis = new FakeRedis()
    private clock = 0

    public Lock(): RedisWriteLock
    {
        const timing = new RedisWriteLockTiming(30_000, 10_000, 200, 50)
        return new RedisWriteLock(LockHarness.Env, async () => this.Redis, timing, () => this.clock, async ms => { this.clock += ms })
    }
}

test('one lease at a time across lock instances sharing a Redis; release frees it', async () =>
{
    const h = new LockHarness()
    const workerA = h.Lock()
    const workerB = h.Lock()
    const lease = await workerA.Acquire()
    assert.equal(await lease.Held(), true)
    await assert.rejects(() => workerB.Acquire(), WriteLockBusyError)
    await lease.Release()
    const next = await workerB.Acquire()
    assert.equal(await next.Held(), true)
    await next.Release()
    assert.equal(h.Redis.Keys.size, 0)
})

test('a lease whose key expired or was taken over reports not held (fencing)', async () =>
{
    const h = new LockHarness()
    const lease = await h.Lock().Acquire()
    h.Redis.Keys.clear()
    assert.equal(await lease.Held(), false)
    h.Redis.Keys.set('pragmatic:write:' + LockHarness.Env, 'someone-else')
    assert.equal(await lease.Held(), false)
    await lease.Release()
    assert.equal(h.Redis.Keys.get('pragmatic:write:' + LockHarness.Env), 'someone-else')
})

test('an unreachable Redis fails closed', async () =>
{
    const h = new LockHarness()
    h.Redis.Down = true
    await assert.rejects(() => h.Lock().Acquire(), WriteLockBusyError)
})

/** A Redis whose SET lands but whose reply is lost (the caller sees an error, e.g. a timeout). */
class LostReplyRedis extends FakeRedis
{
    public override async set(key: string, value: string): Promise<string | null>
    {
        await super.set(key, value)
        throw new Error('timed out')
    }
}

test('a SET whose reply is lost releases the token it may have planted', async () =>
{
    const redis = new LostReplyRedis()
    const lock = new RedisWriteLock(LockHarness.Env, async () => redis, new RedisWriteLockTiming(30_000, 10_000, 200, 50), () => 0, async () => {})
    await assert.rejects(() => lock.Acquire(), WriteLockBusyError)
    assert.equal(redis.Keys.size, 0)
})
