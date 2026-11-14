import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryEnvironmentOwnership, EnvironmentOwnedElsewhereError } from '../environment-ownership.js'

test('in-memory ownership always grants and is always healthy', async () =>
{
    const ownership = new InMemoryEnvironmentOwnership()
    await ownership.Start()
    assert.equal(await ownership.Acquire('t1'), true)
    assert.equal(await ownership.Acquire('t1'), true)
    assert.equal(ownership.Healthy(), true)
    await ownership.Release('t1')
    await ownership.ReleaseAll()
})

test('in-memory ownership never fires the lost handler', async () =>
{
    const ownership = new InMemoryEnvironmentOwnership()
    let fired = false
    ownership.OnLost(() => { fired = true })
    await ownership.Acquire('t1')
    assert.equal(fired, false)
})

test('EnvironmentOwnedElsewhereError is an Error with a stable name', () =>
{
    const error = new EnvironmentOwnedElsewhereError()
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'EnvironmentOwnedElsewhereError')
})
