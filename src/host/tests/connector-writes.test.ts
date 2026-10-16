import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConnectorWrites } from '../connector-writes.js'
import type { ConnectorBinding } from '@pragmatic-tech-ai/todl'

test('ToExternalFields maps members through FieldMap and drops the id key', () =>
{
    const binding = { IdKey: 'ID', FieldMap: { ownerid: 'OWNER_ID', rowkey: 'ID' } } as unknown as ConnectorBinding
    const out = ConnectorWrites.ToExternalFields(binding, { ownerid: 'u1', rowkey: 'drop', owningbu: 'sales' })
    assert.deepEqual(out, { OWNER_ID: 'u1', owningbu: 'sales' })
    assert.equal('ID' in out, false)
})
