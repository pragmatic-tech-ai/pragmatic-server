import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VersionOrder } from '../src/version-order.js'

describe('VersionOrder.Compare', () =>
{
    it('orders numerically, not lexically', () =>
    {
        assert.equal(VersionOrder.Compare('1.10.0', '1.9.0'), 1)
        assert.equal(VersionOrder.Compare('1.9.0', '1.10.0'), -1)
    })

    it('ignores leading zeros', () =>
    {
        assert.equal(VersionOrder.Compare('1.01', '1.1'), 0)
    })

    it('treats a missing segment as lower', () =>
    {
        assert.equal(VersionOrder.Compare('1.0', '1.0.1'), -1)
    })

    it('falls back to text order for non-numeric segments', () =>
    {
        assert.equal(VersionOrder.Compare('1.a', '1.b'), -1)
    })

    it('returns 0 for equal versions', () =>
    {
        assert.equal(VersionOrder.Compare('2.0.0', '2.0.0'), 0)
    })
})
