import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryWorkerRouter } from '../worker-router.js'

test('routes every tenant to the single configured worker endpoint', async () =>
{
    const router = new InMemoryWorkerRouter({ host: '127.0.0.1', port: 9123 })
    const a = await router.RouteOrSpawn('t1')
    const b = await router.RouteOrSpawn('t2')
    assert.deepEqual(a, { host: '127.0.0.1', port: 9123 })
    assert.deepEqual(b, { host: '127.0.0.1', port: 9123 })
    await router.Drain()
})
