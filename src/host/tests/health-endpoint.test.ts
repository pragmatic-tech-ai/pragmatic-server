import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HealthEndpoint } from '../health-endpoint.js'

test('liveness is always 200 regardless of readiness', () =>
{
    const endpoint = new HealthEndpoint()
    assert.equal(endpoint.Handle('GET', '/healthz', false)?.status, 200)
    assert.equal(endpoint.Handle('GET', '/healthz', true)?.status, 200)
})

test('readiness is 503 until ready, then 200', () =>
{
    const endpoint = new HealthEndpoint()
    assert.equal(endpoint.Handle('GET', '/readyz', false)?.status, 503)
    assert.equal(endpoint.Handle('GET', '/readyz', true)?.status, 200)
})

test('a non-health path returns null so the caller continues', () =>
{
    const endpoint = new HealthEndpoint()
    assert.equal(endpoint.Handle('GET', '/auth/login', true), null)
})

test('a non-GET method on a health path is not handled', () =>
{
    const endpoint = new HealthEndpoint()
    assert.equal(endpoint.Handle('POST', '/healthz', true), null)
})
