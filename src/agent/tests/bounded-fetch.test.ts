import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BoundedFetch } from '../bounded-fetch.js'

class FetchFixture
{
    public static readonly TimeoutMs = 100

    /** A fetch whose headers arrive at once but whose body never ends (and ignores the abort signal). */
    public static Stalled(): typeof fetch
    {
        return (async () => ({ status: 200, ok: true, json: () => new Promise(() => undefined) })) as unknown as typeof fetch
    }

    public static Healthy(): typeof fetch
    {
        return (async () => ({ status: 200, ok: true, json: async () => ({ version: 'v1' }) })) as unknown as typeof fetch
    }
}

describe('BoundedFetch', () =>
{
    it('aborts a response whose body never finishes within the deadline', async () =>
    {
        const started = Date.now()
        await assert.rejects(() => BoundedFetch.Run('http://x', {}, FetchFixture.TimeoutMs, r => r.json(), FetchFixture.Stalled()))
        assert.ok(Date.now() - started < 2000)
    })

    it('returns the consumed body when it arrives in time', async () =>
    {
        const out = await BoundedFetch.Run('http://x', {}, FetchFixture.TimeoutMs, r => r.json(), FetchFixture.Healthy())
        assert.deepEqual(out, { version: 'v1' })
    })
})
