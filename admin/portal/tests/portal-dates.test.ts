import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PortalDates } from '../src/portal-dates.js'

describe('PortalDates', () =>
{
    it('formats a valid ISO timestamp as a date', () =>
    {
        assert.equal(PortalDates.Label('2026-01-02T03:04:05.000Z'), '2026-01-02')
    })

    it('returns Unknown for empty, undefined and invalid input', () =>
    {
        assert.equal(PortalDates.Label(''), 'Unknown')
        assert.equal(PortalDates.Label(undefined), 'Unknown')
        assert.equal(PortalDates.Label('not-a-date'), 'Unknown')
    })
})
