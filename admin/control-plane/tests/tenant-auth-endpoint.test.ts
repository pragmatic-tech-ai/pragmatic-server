import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { TenantAuthEndpoint } from '../tenant-auth/tenant-auth-endpoint.js'
import { TenantLoginError, type ITenantOidcRelyingParty } from '../tenant-auth/tenant-oidc-relying-party.js'
import { TenantSessionStore } from '../tenant-auth/tenant-session.js'
import { TenantSessionCookie } from '../tenant-auth/tenant-session-cookie.js'

class FakeRelyingParty implements ITenantOidcRelyingParty
{
    public static readonly AuthorizeUrl = 'https://idp.example/authorize?state=abc'
    public Fail = false
    public BeginFail = false
    public Crash: Error | undefined

    public async Begin(_tenantId: string): Promise<{ Url: string; State: string }>
    {
        if (this.BeginFail)
        {
            throw new TenantLoginError()
        }
        return { Url: FakeRelyingParty.AuthorizeUrl, State: 'abc' }
    }

    public async Complete(_tenantId: string, _code: string, _state: string): Promise<{ principalId: string; email?: string }>
    {
        if (this.Crash !== undefined)
        {
            throw this.Crash
        }
        if (this.Fail)
        {
            throw new TenantLoginError()
        }
        return { principalId: 'sub-1', email: 'a@b.c' }
    }
}

class Recorder
{
    public Status = 0
    public Headers: Record<string, string | string[]> = {}
    public Body = ''

    public writeHead(status: number, headers?: Record<string, string | string[]>): this
    {
        this.Status = status
        this.Headers = { ...this.Headers, ...(headers ?? {}) }
        return this
    }

    public end(body?: string): void
    {
        this.Body = body ?? ''
    }
}

class Harness
{
    public static readonly Callback = '/tenant-auth/oidc/callback?tenant=t1&code=c&state=abc'
    public readonly Dir = mkdtempSync(join(tmpdir(), 'tenant-auth-'))
    public readonly Rp = new FakeRelyingParty()
    public readonly Sessions = new TenantSessionStore(join(this.Dir, 'sessions.json'), 3600000)
    public readonly Endpoint = new TenantAuthEndpoint(this.Rp, this.Sessions, false)

    public async Call(method: string, url: string, cookie?: string): Promise<{ handled: boolean; res: Recorder }>
    {
        const res = new Recorder()
        const handled = await this.Endpoint.Handle(this.Request(method, url, cookie), res as unknown as ServerResponse, new URL(url, 'http://localhost').pathname)
        return { handled, res }
    }

    public Request(method: string, url: string, cookie?: string): IncomingMessage
    {
        return { method, url, headers: cookie === undefined ? {} : { cookie } } as unknown as IncomingMessage
    }

    /** The request Cookie header for the cookie a response set. */
    public CookieHeader(res: Recorder): string
    {
        const raw = res.Headers['Set-Cookie']
        assert.ok(typeof raw === 'string')
        return raw.split(';')[0]!
    }

    public TokenOf(res: Recorder): string
    {
        const read = TenantSessionCookie.Read(this.CookieHeader(res))
        assert.ok(read !== null)
        return read.token
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

describe('TenantAuthEndpoint', () =>
{
    let h: Harness

    beforeEach(() =>
    {
        h = new Harness()
    })

    afterEach(() =>
    {
        h.Dispose()
    })

    it('ignores unrelated paths', async () =>
    {
        assert.equal((await h.Call('GET', '/other')).handled, false)
    })

    it('begin redirects to the IdP url, 400 without tenant', async () =>
    {
        const ok = await h.Call('GET', '/tenant-auth/oidc/begin?tenant=t1')
        assert.equal(ok.res.Status, 302)
        assert.equal(ok.res.Headers['Location'], FakeRelyingParty.AuthorizeUrl)
        assert.equal(ok.res.Headers['Cache-Control'], 'no-store')
        assert.equal((await h.Call('GET', '/tenant-auth/oidc/begin')).res.Status, 400)
    })

    it('begin is 401 when Begin throws TenantLoginError', async () =>
    {
        h.Rp.BeginFail = true
        const { res } = await h.Call('GET', '/tenant-auth/oidc/begin?tenant=t1')
        assert.equal(res.Status, 401)
        assert.equal(res.Headers['Cache-Control'], 'no-store')
    })

    it('callback issues a session cookie and redirects to /', async () =>
    {
        const { res } = await h.Call('GET', Harness.Callback)
        assert.equal(res.Status, 302)
        assert.equal(res.Headers['Location'], '/')
        assert.equal(res.Headers['Cache-Control'], 'no-store')
        assert.equal(TenantSessionCookie.Read(h.CookieHeader(res))?.tenantId, 't1')
        const session = await h.Sessions.Validate(h.TokenOf(res))
        assert.equal(session?.principalId, 'sub-1')
        assert.equal(session?.tenantId, 't1')
    })

    it('callback 400 on missing tenant, code or state', async () =>
    {
        assert.equal((await h.Call('GET', '/tenant-auth/oidc/callback?tenant=t1&code=c')).res.Status, 400)
        assert.equal((await h.Call('GET', '/tenant-auth/oidc/callback?tenant=t1&state=abc')).res.Status, 400)
        assert.equal((await h.Call('GET', '/tenant-auth/oidc/callback?code=c&state=abc')).res.Status, 400)
    })

    it('callback failure is 401 with no cookie, a generic body, and no secret or token', async () =>
    {
        const good = await h.Call('GET', Harness.Callback)
        const token = h.TokenOf(good.res)
        h.Rp.Fail = true
        const { res } = await h.Call('GET', '/tenant-auth/oidc/callback?tenant=t1&code=SECRETCODE&state=abc')
        assert.equal(res.Status, 401)
        assert.equal(res.Headers['Set-Cookie'], undefined)
        assert.equal(res.Headers['Cache-Control'], 'no-store')
        assert.equal(res.Body, '{"error":"unauthorized"}')
        assert.ok(!res.Body.includes('SECRETCODE'))
        assert.ok(!res.Body.includes(token))
    })

    it('rethrows an unrelated Complete error without writing a response', async () =>
    {
        h.Rp.Crash = new Error('db exploded SECRETCODE')
        const res = new Recorder()
        await assert.rejects(
            h.Endpoint.Handle(h.Request('GET', Harness.Callback), res as unknown as ServerResponse, '/tenant-auth/oidc/callback'),
            /db exploded/)
        assert.equal(res.Status, 0)
        assert.equal(res.Body, '')
    })

    it('session returns the principal with the cookie, 401 without', async () =>
    {
        const login = await h.Call('GET', Harness.Callback)
        const ok = await h.Call('GET', '/tenant-auth/session', h.CookieHeader(login.res))
        assert.equal(ok.res.Status, 200)
        assert.equal(ok.res.Headers['Cache-Control'], 'no-store')
        assert.deepEqual(JSON.parse(ok.res.Body), { tenantId: 't1', principalId: 'sub-1', email: 'a@b.c' })
        const none = await h.Call('GET', '/tenant-auth/session')
        assert.equal(none.res.Status, 401)
        assert.equal(none.res.Headers['Cache-Control'], 'no-store')
    })

    it('session is 401 when the cookie tenant does not match the session tenant', async () =>
    {
        const login = await h.Call('GET', Harness.Callback)
        const forged = TenantSessionCookie.Build('other', h.TokenOf(login.res), new Date(Date.now() + 60000), false).split(';')[0]!
        assert.equal((await h.Call('GET', '/tenant-auth/session', forged)).res.Status, 401)
    })

    it('405 with an Allow header on a wrong method', async () =>
    {
        const wrongForSession = await h.Call('POST', '/tenant-auth/session')
        assert.equal(wrongForSession.res.Status, 405)
        assert.equal(wrongForSession.res.Headers['Allow'], 'GET')
        const wrongForLogout = await h.Call('GET', '/tenant-auth/logout')
        assert.equal(wrongForLogout.res.Status, 405)
        assert.equal(wrongForLogout.res.Headers['Allow'], 'POST')
    })

    it('logout revokes the session and clears the cookie', async () =>
    {
        const login = await h.Call('GET', Harness.Callback)
        const cookie = h.CookieHeader(login.res)
        const token = h.TokenOf(login.res)
        const out = await h.Call('POST', '/tenant-auth/logout', cookie)
        assert.equal(out.res.Status, 204)
        assert.match(String(out.res.Headers['Set-Cookie']), /Max-Age=0/)
        assert.equal(await h.Sessions.Validate(token), null)
        assert.equal((await h.Call('GET', '/tenant-auth/session', cookie)).res.Status, 401)
    })

    it('logout without a cookie is 204 and still clears', async () =>
    {
        const out = await h.Call('POST', '/tenant-auth/logout')
        assert.equal(out.res.Status, 204)
        assert.match(String(out.res.Headers['Set-Cookie']), /Max-Age=0/)
    })
})
