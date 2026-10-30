import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrincipalConnectionRegistry } from '../principal-connection-registry.js'
import type { IRevocableConnection } from '../principal-connection-registry.js'

class FakeConnection implements IRevocableConnection
{
    public RevokeCount = 0

    public Revoke(): void
    {
        this.RevokeCount++
    }
}

describe('PrincipalConnectionRegistry', () =>
{
    it('revokes only the connections of the invalidated principal', () =>
    {
        const registry = new PrincipalConnectionRegistry()
        const a1 = new FakeConnection()
        const a2 = new FakeConnection()
        const b = new FakeConnection()
        registry.Add('t1', 'A', a1)
        registry.Add('t1', 'A', a2)
        registry.Add('t1', 'B', b)
        registry.InvalidatePrincipal('t1', 'A')
        assert.equal(a1.RevokeCount, 1)
        assert.equal(a2.RevokeCount, 1)
        assert.equal(b.RevokeCount, 0)
    })

    it('isolates tenants sharing a principal id', () =>
    {
        const registry = new PrincipalConnectionRegistry()
        const one = new FakeConnection()
        const two = new FakeConnection()
        registry.Add('t1', 'p', one)
        registry.Add('t2', 'p', two)
        registry.InvalidatePrincipal('t1', 'p')
        assert.equal(one.RevokeCount, 1)
        assert.equal(two.RevokeCount, 0)
    })

    it('skips a removed connection', () =>
    {
        const registry = new PrincipalConnectionRegistry()
        const a1 = new FakeConnection()
        const a2 = new FakeConnection()
        registry.Add('t1', 'A', a1)
        registry.Add('t1', 'A', a2)
        registry.Remove(a1)
        registry.InvalidatePrincipal('t1', 'A')
        assert.equal(a1.RevokeCount, 0)
        assert.equal(a2.RevokeCount, 1)
    })

    it('is a no-op for an unknown key', () =>
    {
        const registry = new PrincipalConnectionRegistry()
        assert.doesNotThrow(() => registry.InvalidatePrincipal('nope', 'nobody'))
    })
})
