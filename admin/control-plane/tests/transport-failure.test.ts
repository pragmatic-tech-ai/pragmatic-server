import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TransportFailure } from '../transport-failure.js'

class TransportFixture
{
    public static Coded(code: string): Error
    {
        return Object.assign(new Error('socket failure'), { code })
    }
}

test('TransportFailure recognises TCP-level codes on the error or on its cause (fetch wraps the socket error)', () =>
{
    assert.equal(TransportFailure.Is(TransportFixture.Coded('ECONNREFUSED')), true)
    assert.equal(TransportFailure.Is(TransportFixture.Coded('ECONNRESET')), true)
    assert.equal(TransportFailure.Is(new TypeError('fetch failed', { cause: TransportFixture.Coded('UND_ERR_SOCKET') })), true)
})

test('TransportFailure does not treat an answered error or an unknown value as a dead tunnel', () =>
{
    assert.equal(TransportFailure.Is(new Error('The environment server refused the relay connection.')), false)
    assert.equal(TransportFailure.Is(TransportFixture.Coded('ENOENT')), false)
    assert.equal(TransportFailure.Is(undefined), false)
    assert.equal(TransportFailure.Is('ECONNREFUSED'), false)
})
