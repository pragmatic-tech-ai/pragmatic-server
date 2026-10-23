import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InvalidRecordIdError, RecordId } from '../platform-records.js'
import type { TenantRecord } from '../platform-records.js'

describe('RecordId', () =>
{
    it('Validate accepts a plain slug and rejects empty/dot/separator ids', () =>
    {
        assert.doesNotThrow(() => RecordId.Validate('acme-eu'))
        for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b'])
        {
            assert.throws(() => RecordId.Validate(bad), /invalid record id/)
            assert.throws(() => RecordId.Validate(bad), InvalidRecordIdError)
        }
    })
})

describe('TenantRecord', () =>
{
    it('round-trips the optional owner and idp metadata fields', () =>
    {
        const record: TenantRecord = {
            id: 'acme',
            clientId: 'client-1',
            displayName: 'Acme',
            createdAt: '2026-10-23T00:00:00.000Z',
            ownerEmail: 'owner@acme.example',
            ownerPrincipalId: 'principal-1',
            idpBaseUrl: 'https://idp.acme.example',
            idpCaRef: 'ca-ref',
            idpAdminTokenRef: 'admin-token-ref'
        }
        assert.deepEqual(JSON.parse(JSON.stringify(record)), record)
    })

    it('accepts a pre-6c record without the optional fields', () =>
    {
        const legacy: TenantRecord = { id: 'acme', clientId: 'client-1', displayName: 'Acme', createdAt: '2026-10-01T00:00:00.000Z' }
        assert.equal(legacy.ownerEmail, undefined)
        assert.equal(legacy.idpBaseUrl, undefined)
    })
})
