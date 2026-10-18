import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectorBinding, ExternalRecord } from '@pragmatic-tech-ai/todl'
import { ConnectorInstanceView } from '../connector-instance-view.js'

class Fixture
{
    public static Binding(): ConnectorBinding
    {
        return { Concept: 'Customer', FieldMap: { owner: 'owner_id', name: 'full_name' } } as unknown as ConnectorBinding
    }
}

test('ConnectorInstanceView resolves mapped members through FieldMap', () =>
{
    const record: ExternalRecord = { owner_id: 'u1', full_name: 'Ann', extra: 9 }
    const view = new ConnectorInstanceView(Fixture.Binding(), record)
    assert.equal(view.Concept, 'Customer')
    assert.equal(view.Field('owner'), 'u1')
    assert.equal(view.Field('name'), 'Ann')
    assert.equal(view.Field('missing'), undefined)
})

test('ConnectorInstanceView does not fall back to raw columns or member names', () =>
{
    const record: ExternalRecord = { owner_id: 'u1', extra: 9, missing: 'raw' }
    const view = new ConnectorInstanceView(Fixture.Binding(), record)
    assert.equal(view.Field('extra'), undefined)
    assert.equal(view.Field('missing'), undefined)
    assert.equal(view.Field('owner_id'), undefined)
})
