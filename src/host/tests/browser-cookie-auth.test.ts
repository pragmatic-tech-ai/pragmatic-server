import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import { ProvisionedSecretSource } from '../../config/provisioned-secret-source.js'
import type { ILogger, LogFields } from '../../observability/logger.js'
import type { IAccessAuditSink, AccessAuditEvent } from '../access-audit.js'

class CapturingLogger implements ILogger
{
    public readonly Lines: string[] = []

    public Info(message: string, fields?: LogFields): void
    {
        this.Lines.push(message + JSON.stringify(fields ?? {}))
    }

    public Warn(message: string, fields?: LogFields): void
    {
        this.Info(message, fields)
    }

    public Error(message: string, fields?: LogFields): void
    {
        this.Info(message, fields)
    }

    public Child(): ILogger
    {
        return this
    }
}

class CapturingAudit implements IAccessAuditSink
{
    public readonly Events: AccessAuditEvent[] = []

    public async Record(event: AccessAuditEvent): Promise<void>
    {
        this.Events.push(event)
    }
}

class CookieFixture
{
    public static readonly KeyEnv = 'PS_COOKIE_KEY'
    public static readonly Email = 'admin@t1.test'
    public static readonly Password = 'admin-pw-12345'
    public static readonly AllowedOrigin = 'https://app.example.com'

    public readonly Logger = new CapturingLogger()
    public readonly Audit = new CapturingAudit()
    public baseDir = ''
    public host!: PragmaticServerHost
    public base = ''

    public async StartAsync(): Promise<void>
    {
        this.baseDir = mkdtempSync(join(tmpdir(), 'ps-cookie-'))
        process.env[CookieFixture.KeyEnv] = randomBytes(32).toString('base64')
        const entries = new Map<string, TenantProvisioning>([['t1', {
            displayName: 'Tenant One',
            bootstrap: { adminEmail: CookieFixture.Email, adminPrincipalId: 'admin', adminPasswordRef: 't1-admin-pw', ownerGrant: true },
        }]])
        this.host = await PragmaticServerHost.StartAsync({
            host: '127.0.0.1',
            port: 0,
            baseDir: this.baseDir,
            masterKey: { base64Env: CookieFixture.KeyEnv },
            provisioning: new InMemoryTenantProvisioning(entries),
            provisionedSecrets: ProvisionedSecretSource.FromText(JSON.stringify({ 't1-admin-pw': CookieFixture.Password })),
            allowedOrigins: [CookieFixture.AllowedOrigin],
            logger: this.Logger,
            audit: this.Audit,
        })
        this.base = `http://${this.host.Address().host}:${this.host.Address().port}`
    }

    public async LoginAsync(password: string = CookieFixture.Password, path = '/auth/browser-login'): Promise<Response>
    {
        return fetch(`${this.base}${path}?tenant=t1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: CookieFixture.Email, password }) })
    }

    /** The name=value pair of the Set-Cookie header, as a browser would send it back. */
    public static CookiePair(response: Response): string
    {
        return response.headers.get('set-cookie')!.split(';')[0]
    }

    public static TokenOf(cookie: string): string
    {
        return cookie.slice(cookie.lastIndexOf('.') + 1)
    }

    public async StopAsync(): Promise<void>
    {
        await this.host.DisposeAsync()
        rmSync(this.baseDir, { recursive: true, force: true })
        delete process.env[CookieFixture.KeyEnv]
    }

    /** Opens a raw WebSocket (no ?tenant=) and resolves 'open' or the HTTP status that rejected the upgrade. */
    public ConnectAsync(headers: Record<string, string>): Promise<string>
    {
        const address = this.host.Address()
        return new Promise(resolve =>
        {
            const ws = new WebSocket(`ws://${address.host}:${address.port}/`, { headers })
            ws.on('open', () =>
            {
                ws.close()
                resolve('open')
            })
            ws.on('unexpected-response', (_req, res) =>
            {
                resolve(String(res.statusCode))
            })
            ws.on('error', () => resolve('error'))
        })
    }
}

test('login with the seeded admin sets an httpOnly SameSite session cookie bound to tenant + principal', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const response = await fixture.LoginAsync()
        assert.equal(response.status, 200)
        const setCookie = response.headers.get('set-cookie')!
        assert.match(setCookie, /^ps_session=/)
        assert.match(setCookie, /HttpOnly/)
        assert.match(setCookie, /SameSite=Strict/)
        assert.match(setCookie, /Max-Age=\d+/)
        assert.doesNotMatch(setCookie, /Secure/)
        const whoami = await fetch(`${fixture.base}/auth/session`, { headers: { Cookie: CookieFixture.CookiePair(response), Origin: fixture.base } })
        assert.equal(whoami.status, 200)
        const body = await whoami.json() as { tenant: string; principalId: string }
        assert.equal(body.tenant, 't1')
        assert.equal(body.principalId, 'admin')
    }
    finally
    {
        await fixture.StopAsync()
    }
})

test('wrong password sets no cookie', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const response = await fixture.LoginAsync('WRONG-password')
        assert.equal(response.status, 401)
        assert.equal(response.headers.get('set-cookie'), null)
    }
    finally
    {
        await fixture.StopAsync()
    }
})

test('WebSocket with a valid cookie + same-origin or allowlisted Origin authenticates with no ?tenant=', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const cookie = CookieFixture.CookiePair(await fixture.LoginAsync())
        assert.equal(await fixture.ConnectAsync({ Cookie: cookie, Origin: fixture.base }), 'open')
        assert.equal(await fixture.ConnectAsync({ Cookie: cookie, Origin: CookieFixture.AllowedOrigin }), 'open')
    }
    finally
    {
        await fixture.StopAsync()
    }
})

test('WebSocket is denied for a disallowed or missing Origin even with a valid cookie', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const cookie = CookieFixture.CookiePair(await fixture.LoginAsync())
        assert.equal(await fixture.ConnectAsync({ Cookie: cookie, Origin: 'https://evil.example.com' }), '401')
        assert.equal(await fixture.ConnectAsync({ Cookie: cookie, Origin: 'null' }), '401')
        assert.equal(await fixture.ConnectAsync({ Cookie: cookie }), '401')
        const http = await fetch(`${fixture.base}/auth/session`, { headers: { Cookie: cookie, Origin: 'https://evil.example.com' } })
        assert.equal(http.status, 401)
    }
    finally
    {
        await fixture.StopAsync()
    }
})

test('missing, forged, wrong-tenant and revoked cookies are denied with a clean 401', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const valid = CookieFixture.CookiePair(await fixture.LoginAsync())
        const token = CookieFixture.TokenOf(valid)
        const forged = 'ps_session=t1.' + randomBytes(32).toString('base64url')
        const wrongTenant = 'ps_session=t2.' + token
        const malformed = 'ps_session=garbage'
        for (const cookie of [forged, wrongTenant, malformed])
        {
            assert.equal(await fixture.ConnectAsync({ Cookie: cookie, Origin: fixture.base }), '401')
            const response = await fetch(`${fixture.base}/auth/session`, { headers: { Cookie: cookie, Origin: fixture.base } })
            assert.equal(response.status, 401)
            const text = await response.text()
            assert.ok(!text.includes(cookie) && !text.includes(token))
        }
        assert.equal(await fixture.ConnectAsync({ Origin: fixture.base }), '401')
        assert.equal((await fetch(`${fixture.base}/auth/session?tenant=t1`)).status, 401)
        const pack = await fixture.host.IdentityPackForTest('t1')
        await pack.Sessions.Revoke(token)
        assert.equal(await fixture.ConnectAsync({ Cookie: valid, Origin: fixture.base }), '401')
        assert.equal((await fetch(`${fixture.base}/auth/session`, { headers: { Cookie: valid, Origin: fixture.base } })).status, 401)
    }
    finally
    {
        await fixture.StopAsync()
    }
})

test('logout revokes the session and clears the cookie; it requires an allowed Origin', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const cookie = CookieFixture.CookiePair(await fixture.LoginAsync())
        assert.equal((await fetch(`${fixture.base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } })).status, 401)
        const out = await fetch(`${fixture.base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: fixture.base } })
        assert.equal(out.status, 204)
        assert.match(out.headers.get('set-cookie')!, /Max-Age=0/)
        assert.equal((await fetch(`${fixture.base}/auth/session`, { headers: { Cookie: cookie, Origin: fixture.base } })).status, 401)
    }
    finally
    {
        await fixture.StopAsync()
    }
})

test('the Authorization Bearer path still works and is unaffected by cookies', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const login = await fixture.LoginAsync(CookieFixture.Password, '/auth/login')
        assert.equal(login.headers.get('set-cookie'), null)
        const { token } = await login.json() as { token: string }
        const url = `ws://${fixture.host.Address().host}:${fixture.host.Address().port}/?tenant=t1`
        const client = await PragmaticClient.ConnectAsync(url, { bearerToken: token })
        await client.DisposeAsync()
        await assert.rejects(() => PragmaticClient.ConnectAsync(url, { bearerToken: 'bogus' }))
    }
    finally
    {
        await fixture.StopAsync()
    }
})

test('the cookie/session value appears in no log line or audit event', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const cookie = CookieFixture.CookiePair(await fixture.LoginAsync())
        const token = CookieFixture.TokenOf(cookie)
        await fixture.ConnectAsync({ Cookie: cookie, Origin: fixture.base })
        await fixture.ConnectAsync({ Cookie: cookie, Origin: 'https://evil.example.com' })
        await fetch(`${fixture.base}/auth/session`, { headers: { Cookie: cookie, Origin: fixture.base } })
        const captured = fixture.Logger.Lines.join('\n') + JSON.stringify(fixture.Audit.Events)
        assert.ok(!captured.includes(token))
    }
    finally
    {
        await fixture.StopAsync()
    }
})

test('browser login body carries no session token; the Bearer login still returns its token', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const browser = await fixture.LoginAsync()
        const token = CookieFixture.TokenOf(CookieFixture.CookiePair(browser))
        const text = await browser.text()
        assert.ok(!text.includes(token))
        const body = JSON.parse(text) as Record<string, unknown>
        assert.equal(body.token, undefined)
        assert.equal(body.tenant, 't1')
        assert.equal(body.principalId, 'admin')
        const bearer = await (await fixture.LoginAsync(CookieFixture.Password, '/auth/login')).json() as { token: string }
        assert.ok(bearer.token.length > 0)
    }
    finally
    {
        await fixture.StopAsync()
    }
})

test('a scheme-mismatched Origin is not same-origin', async () =>
{
    const fixture = new CookieFixture()
    await fixture.StartAsync()
    try
    {
        const cookie = CookieFixture.CookiePair(await fixture.LoginAsync())
        const httpsOrigin = fixture.base.replace('http://', 'https://')
        assert.equal(await fixture.ConnectAsync({ Cookie: cookie, Origin: httpsOrigin }), '401')
    }
    finally
    {
        await fixture.StopAsync()
    }
})
