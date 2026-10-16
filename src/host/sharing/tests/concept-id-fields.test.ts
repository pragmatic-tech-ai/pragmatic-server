import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConceptIdFields } from '../concept-id-fields.js'

test('IdFieldFor returns the binding IdKey and defaults to id', () =>
{
    const plan = { Bindings: [{ Concept: 'shop.Widget', IdKey: 'widgetId' }, { Concept: 'shop.Order', IdKey: 'id' }] }
    const fields = ConceptIdFields.From(plan as never)
    assert.equal(fields.IdFieldFor('shop.Widget'), 'widgetId')
    assert.equal(fields.IdFieldFor('shop.Order'), 'id')
    assert.equal(fields.IdFieldFor('shop.Unbound'), 'id')
})
