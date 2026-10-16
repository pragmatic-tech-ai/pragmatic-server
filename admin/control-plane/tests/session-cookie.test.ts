import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionCookie } from '../session-cookie.js'

describe('SessionCookie', () =>
{
    it('builds an insecure cookie', () =>
    {
        const c = SessionCookie.Build('tok123', new Date(Date.now() + 3600_000), false)
        assert.match(c, /^cp_session=tok123;/)
        assert.ok(c.includes('HttpOnly'))
        assert.ok(c.includes('SameSite=Strict'))
        assert.ok(c.includes('Path=/'))
        assert.match(c, /Max-Age=\d+/)
        assert.ok(!c.includes('; Secure'))
    })

    it('adds Secure when requested', () =>
    {
        assert.ok(SessionCookie.Build('t', new Date(Date.now() + 1000), true).includes('; Secure'))
    })

    it('builds a clearing cookie', () =>
    {
        const c = SessionCookie.BuildClearing(false)
        assert.match(c, /^cp_session=;/)
        assert.ok(c.includes('Max-Age=0'))
    })

    it('reads the cookie from a header', () =>
    {
        assert.equal(SessionCookie.Read('a=1; cp_session=abc; b=2'), 'abc')
        assert.equal(SessionCookie.Read('x=1'), undefined)
        assert.equal(SessionCookie.Read(undefined), undefined)
    })

    it('ignores a lookalike cookie name', () =>
    {
        assert.equal(SessionCookie.Read('xcp_session=bad; cp_session=good'), 'good')
    })

    it('clamps a past expiry to zero', () =>
    {
        assert.ok(SessionCookie.Build('t', new Date(Date.now() - 10000), false).includes('Max-Age=0'))
    })

    it('reads a single pair', () =>
    {
        assert.equal(SessionCookie.Read('cp_session=onlyone'), 'onlyone')
    })
})
