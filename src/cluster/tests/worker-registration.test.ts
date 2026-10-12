import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RedisClientType } from 'redis'
import { FakeRedisStore } from './fake-redis.js'
import { WorkerRegistration } from '../worker-registration.js'

class Clock
{
    public value = 1_000_000

    public now = (): number => this.value
}

test('Start registers the worker endpoint in the live set', async () =>
{
    const store = new FakeRedisStore()
    const clock = new Clock()
    const reg = new WorkerRegistration('redis://x', { host: 'w1', port: 9001 }, clock.now, () => store.Client())
    await reg.Start()
    assert.deepEqual(store.ZRangeByScore('pragmatic:workers', clock.value), [JSON.stringify({ host: 'w1', port: 9001 })])
    await reg.Drain()
})

test('a heartbeat refreshes the score so the member stays live as time advances', async () =>
{
    const store = new FakeRedisStore()
    const clock = new Clock()
    const reg = new WorkerRegistration('redis://x', { host: 'w1', port: 9001 }, clock.now, () => store.Client())
    await reg.Start() // score = 1_030_000
    clock.value = 1_035_000 // past the original expiry; member is live now ONLY if the heartbeat refreshed it
    await reg.HeartbeatNowForTest()
    assert.equal(store.ZRangeByScore('pragmatic:workers', clock.value).length, 1)
    await reg.Drain()
})

test('Drain removes the worker from the live set (Review Focus 5)', async () =>
{
    const store = new FakeRedisStore()
    const clock = new Clock()
    const reg = new WorkerRegistration('redis://x', { host: 'w1', port: 9001 }, clock.now, () => store.Client())
    await reg.Start()
    await reg.Drain()
    assert.deepEqual(store.ZRangeByScore('pragmatic:workers', clock.value), [])
})

test('a connect failure is swallowed so Start resolves (fail-soft)', async () =>
{
    const clock = new Clock()
    const reg = new WorkerRegistration('redis://x', { host: 'w1', port: 9001 }, clock.now, () =>
    {
        const client = { isOpen: false, on: () => client, connect: async () => { throw new Error('down') }, quit: async () => {} }
        return client as unknown as RedisClientType
    })
    await reg.Start() // must not throw
    await reg.Drain()
})

test('a heartbeat after Drain does not re-register the worker', async () =>
{
    const store = new FakeRedisStore()
    const clock = new Clock()
    const reg = new WorkerRegistration('redis://x', { host: 'w1', port: 9001 }, clock.now, () => store.Client())
    await reg.Start()
    await reg.Drain()
    await reg.HeartbeatNowForTest()
    assert.deepEqual(store.ZRangeByScore('pragmatic:workers', clock.value), [])
})
