import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { TenantAuthEndpoint } from '../tenant-auth/tenant-auth-endpoint.js'
import { TenantLoginError, type ITenantOidcRelyingParty } from '../tenant-auth/tenant-oidc-relying-party.js'
import { TenantSessionStore } from '../tenant-auth/tenant-session.js'

class FakeRelyingParty implements ITenantOidcRelyingParty
{
    public static readonly AuthorizeUrl = 'https://idp.example/authorize?state=abc'
    public Fail = false

    public async Begin(_tenantId: string): Promise<{ Url: string; State: string }>
    {
        return { Url: FakeRelyingParty.AuthorizeUrl, State: 'abc' }
    }

    public async Complete(_tenantId: string, _code: string, _state: string): Promise<{ principalId: string; email?: string }>
    {
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

describe('TenantAuthEndpoint', () =>
{
    let dir: string
    let rp: FakeRelyingParty
    let sessions: TenantSessionStore
    let endpoint: TenantAuthEndpoint

    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'tenant-auth-'))
        rp = new FakeRelyingParty()
        sessions = new TenantSessionStore(join(dir, 'sessions.json'), 3600000)
        endpoint = new TenantAuthEndpoint(rp, sessions, false)
    })

    afterEach(() =>
    {
        rmSync(dir, { recursive: true, force: true })
    })

    async function call(method: string, url: string, cookie?: string): Promise<{ handled: boolean; res: Recorder }>
    {
        const res = new Recorder()
        const req = { method, url, headers: cookie === undefined ? {} : { cookie } } as unknown as IncomingMessage
        const handled = await endpoint.Handle(req, res as unknown as ServerResponse, new URL(url, 'http://localhost').pathname)
        return { handled, res }
    }

    function cookieOf(res: Recorder): string
    {
        const raw = res.Headers['Set-Cookie']
        assert.ok(typeof raw === 'string')
        return raw.split(';')[0]!
    }

    it('ignores unrelated paths', async () =>
    {
        assert.equal((await call('GET', '/other')).handled, false)
    })

    it('begin redirects to the IdP url, 400 without tenant', async () =>
    {
        const ok = await call('GET', '/tenant-auth/oidc/begin?tenant=t1')
        assert.equal(ok.res.Status, 302)
        assert.equal(ok.res.Headers['Location'], FakeRelyingParty.AuthorizeUrl)
        assert.equal(ok.res.Headers['Cache-Control'], 'no-store')
        assert.equal((await call('GET', '/tenant-auth/oidc/begin')).res.Status, 400)
    })

    it('callback issues a session cookie and redirects to /', async () =>
    {
        const { res } = await call('GET', '/tenant-auth/oidc/callback?tenant=t1&code=c&state=abc')
        assert.equal(res.Status, 302)
        assert.equal(res.Headers['Location'], '/')
        assert.match(cookieOf(res), /^pts_session=t1\./)
        const token = cookieOf(res).split('.')[1]!
        const session = await sessions.Validate(token)
        assert.equal(session?.principalId, 'sub-1')
        assert.equal(session?.tenantId, 't1')
    })

    it('callback 400 on missing params', async () =>
    {
        assert.equal((await call('GET', '/tenant-auth/oidc/callback?tenant=t1&code=c')).res.Status, 400)
    })

    it('callback failure is 401 with no cookie and no secret', async () =>
    {
        rp.Fail = true
        const { res } = await call('GET', '/tenant-auth/oidc/callback?tenant=t1&code=SECRETCODE&state=abc')
        assert.equal(res.Status, 401)
        assert.equal(res.Headers['Set-Cookie'], undefined)
        assert.ok(!res.Body.includes('SECRETCODE'))
    })

    it('session returns the principal with the cookie, 401 without', async () =>
    {
        const login = await call('GET', '/tenant-auth/oidc/callback?tenant=t1&code=c&state=abc')
        const cookie = cookieOf(login.res)
        const ok = await call('GET', '/tenant-auth/session', cookie)
        assert.equal(ok.res.Status, 200)
        assert.deepEqual(JSON.parse(ok.res.Body), { tenantId: 't1', principalId: 'sub-1', email: 'a@b.c' })
        assert.equal((await call('GET', '/tenant-auth/session')).res.Status, 401)
    })

    it('logout revokes the session and clears the cookie', async () =>
    {
        const login = await call('GET', '/tenant-auth/oidc/callback?tenant=t1&code=c&state=abc')
        const cookie = cookieOf(login.res)
        const token = cookie.split('.')[1]!
        const out = await call('POST', '/tenant-auth/logout', cookie)
        assert.equal(out.res.Status, 204)
        assert.match(String(out.res.Headers['Set-Cookie']), /Max-Age=0/)
        assert.equal(await sessions.Validate(token), null)
        assert.equal((await call('GET', '/tenant-auth/session', cookie)).res.Status, 401)
    })
})
