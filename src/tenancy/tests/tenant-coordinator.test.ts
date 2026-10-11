import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryTenantCoordinator } from '../tenant-coordinator.js'

class Clock
{
    public Value = 0

    public Now = (): number =>
    {
        return this.Value
    }
}

test('an idle tenant past the TTL is an evict candidate; a fresh one is not', () =>
{
    const clock = new Clock()
    const coordinator = new InMemoryTenantCoordinator(clock.Now)
    coordinator.Note('t1')
    clock.Value = 1000
    assert.deepEqual(coordinator.EvictCandidates(clock.Value, 1000), ['t1'])
    assert.deepEqual(coordinator.EvictCandidates(999, 1000), [])
})

test('a tenant with an active connection is never an evict candidate', () =>
{
    const clock = new Clock()
    const coordinator = new InMemoryTenantCoordinator(clock.Now)
    coordinator.Note('t1')
    coordinator.Acquire('t1')
    clock.Value = 10_000
    assert.deepEqual(coordinator.EvictCandidates(clock.Value, 1000), [])
    coordinator.Release('t1')
    assert.deepEqual(coordinator.EvictCandidates(clock.Value + 1000, 1000), ['t1'])
})

test('Release clamps at zero and Forget drops the tenant', () =>
{
    const coordinator = new InMemoryTenantCoordinator(() => 0)
    coordinator.Note('t1')
    coordinator.Release('t1')
    coordinator.Acquire('t1')
    assert.deepEqual(coordinator.EvictCandidates(10_000, 0), [])
    coordinator.Release('t1')
    assert.deepEqual(coordinator.Known(), ['t1'])
    coordinator.Forget('t1')
    assert.deepEqual(coordinator.Known(), [])
})
