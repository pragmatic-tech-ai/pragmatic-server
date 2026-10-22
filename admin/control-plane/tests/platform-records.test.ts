import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RecordId } from '../platform-records.js'

describe('RecordId', () =>
{
    it('Validate accepts a plain slug and rejects empty/dot/separator ids', () =>
    {
        assert.doesNotThrow(() => RecordId.Validate('acme-eu'))
        for (const bad of ['', '.', '..', 'a/b', 'a\b', 'a:b'])
        {
            assert.throws(() => RecordId.Validate(bad), /invalid record id/)
        }
    })
})
