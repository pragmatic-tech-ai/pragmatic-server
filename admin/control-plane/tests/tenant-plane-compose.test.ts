import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ControlPlaneServer } from '../server.js'

describe('ControlPlaneServer.ParseSecretTtlHours', () =>
{
    const defaultHours = 168

    for (const raw of [undefined, '', '0', '-3', 'abc', '1.5'])
    {
        it(`falls back to the default for ${JSON.stringify(raw)}`, () =>
        {
            assert.equal(ControlPlaneServer.ParseSecretTtlHours(raw), defaultHours)
        })
    }

    it('returns the integer for valid positive values', () =>
    {
        assert.equal(ControlPlaneServer.ParseSecretTtlHours('24'), 24)
        assert.equal(ControlPlaneServer.ParseSecretTtlHours('720'), 720)
    })
})
