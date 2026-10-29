import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VersionOrder } from '../version-order.js'

class VersionFixture
{
    public static readonly Pairs: ReadonlyArray<readonly [string, string, number]> = [
        ['1.0.0', '1.0.0', 0],
        ['1.10.0', '1.9.0', 1],
        ['1.9.0', '1.10.0', -1],
        ['1.4', '1.4.1', -1],
        ['2.0.0', '1.9.9', 1],
        ['', '0', -1],
        ['99999999999999999999.0', '99999999999999999998.0', 1],
    ]
}

test('Compare returns the expected sign for the table', () =>
{
    for (const [a, b, expected] of VersionFixture.Pairs)
    {
        assert.equal(VersionOrder.Compare(a, b), expected, a + ' vs ' + b)
    }
})

test('Compare is antisymmetric on the table', () =>
{
    for (const [a, b] of VersionFixture.Pairs)
    {
        assert.equal(VersionOrder.Compare(a, b), -VersionOrder.Compare(b, a) || 0, a + ' vs ' + b)
    }
})

test('Compare is deterministic and never throws on non-numeric segments', () =>
{
    const first = VersionOrder.Compare('1.0.0-rc', '1.0.0')
    assert.ok(first === -1 || first === 0 || first === 1)
    assert.equal(VersionOrder.Compare('1.0.0-rc', '1.0.0'), first)
    assert.equal(VersionOrder.Compare('1.0.0', '1.0.0-rc'), -first || 0)
})
