import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InProcessWriteLock } from '../write-lock.js'

// moved from dev-cypher-executor.test.ts (the lock outlives the legacy executor)
test('the in-process lock hands out one lease at a time, in arrival order', async () =>
{
    const lock = new InProcessWriteLock()
    const order: string[] = []
    const first = await lock.Acquire()
    const second = lock.Acquire().then(lease => { order.push('second'); return lease })
    await new Promise(resolve => setTimeout(resolve, 10))
    order.push('first-release')
    await first.Release()
    assert.equal(await first.Held(), false)
    const lease = await second
    assert.deepEqual(order, ['first-release', 'second'])
    assert.equal(await lease.Held(), true)
    await lease.Release()
})
