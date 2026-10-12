import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check } from '@pragmatic-tech-ai/todl'
import { SolutionConnectorPlanner } from '../solution-connector-planner.js'

const META = `
namespace shop {
  concept Customer { name : string; }
  concept Lead { label : string; }
  datasource pg { kind = sql; }
  model Shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { name = "name"; }
  }
  model Crm : shop {
  }
}
`

test('Plan returns one ConnectorModel for the connector-bearing model only', () =>
{
    const { model, diagnostics } = check([{ uri: 'shop.todl', text: META }])
    assert.deepEqual(diagnostics, [])
    const planned = SolutionConnectorPlanner.Plan(model)
    assert.equal(planned.length, 1)
    const only = planned[0]!
    assert.ok(only.Plan.Bindings.length > 0)
    assert.ok(only.Base.nodes.length > 0)
})

test('the base shard carries the model own concept and is non-empty', () =>
{
    const { model } = check([{ uri: 'shop.todl', text: META }])
    const planned = SolutionConnectorPlanner.Plan(model)
    const only = planned[0]!
    // the shard is non-empty and contains the planned model's Customer concept.
    const ids = new Set(only.Base.nodes.map(n => n.id))
    assert.ok([...ids].some(id => id.includes('Customer')))
})
