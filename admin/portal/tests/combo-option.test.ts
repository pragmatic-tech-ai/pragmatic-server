import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ComboOption } from '../src/kit/index.js'

describe('ComboOption', () =>
{
    it('exposes the display label and the picked value (client id lives in Value)', () =>
    {
        const o = new ComboOption('One', 'c1')
        assert.equal(o.Label, 'One')
        assert.equal(o.Value, 'c1')
    })
})
