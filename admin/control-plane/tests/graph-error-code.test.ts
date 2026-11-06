import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GraphErrorCode } from '../graph-error-code.js'
import { GraphErrorCode as ServerGraphErrorCode } from '../../../src/host/graphs/graph-error-codes.js'

test('the control plane copy matches the environment server codes', () =>
{
    assert.deepEqual(Object.entries(GraphErrorCode), Object.entries(ServerGraphErrorCode))
})
