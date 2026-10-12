import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryTenantOwnership, TenantOwnedElsewhereError } from '../tenant-ownership.js'

test('in-memory ownership always grants and is always healthy', async () =>
{
    const ownership = new InMemoryTenantOwnership()
    await ownership.Start()
    assert.equal(await ownership.Acquire('t1'), true)
    assert.equal(await ownership.Acquire('t1'), true)
    assert.equal(ownership.Healthy(), true)
    await ownership.Release('t1')
    await ownership.ReleaseAll()
})

test('in-memory ownership never fires the lost handler', async () =>
{
    const ownership = new InMemoryTenantOwnership()
    let fired = false
    ownership.OnLost(() => { fired = true })
    await ownership.Acquire('t1')
    assert.equal(fired, false)
})

test('TenantOwnedElsewhereError is an Error with a stable name', () =>
{
    const error = new TenantOwnedElsewhereError()
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'TenantOwnedElsewhereError')
})
