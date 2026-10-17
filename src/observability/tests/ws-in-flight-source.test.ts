import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WsInFlightSource } from '../ws-in-flight-source.js'

test('sums handler in-flight counts plus the extra http source', () =>
{
    const handlers = [{ InFlight: () => 2 }, { InFlight: () => 1 }]
    const source = new WsInFlightSource(handlers, { InFlight: () => 3 })
    assert.equal(source.InFlight(), 6)
})

test('tolerates no extra source', () =>
{
    const source = new WsInFlightSource([{ InFlight: () => 4 }])
    assert.equal(source.InFlight(), 4)
})
