import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { TenantPlaneHost } from '../tenant-plane-host.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import type { EnvironmentChange } from '../environment-record.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { TenantRecord } from '../platform-records.js'
import type { IdpConnection } from '../idp-workload-driver.js'
import { TenantHostResolver } from '../tenant-auth/tenant-host-resolver.js'
import { TenantSessionStore, type TenantSession } from '../tenant-auth/tenant-session.js'
import { TenantSessionCookie } from '../tenant-auth/tenant-session-cookie.js'
import { TenantAuthEndpoint } from '../tenant-auth/tenant-auth-endpoint.js'
import { TenantAuthGate } from '../tenant-auth/tenant-auth-gate.js'
import { TenantPrincipalSessions } from '../tenant-auth/tenant-principal-sessions.js'
import { TenantPasswordChange, type ITenantIdpConnector, type ISessionRotator } from '../tenant-auth/tenant-password-change.js'
import { IdpPasswordResult, type IdpPasswordOutcome, type IIdpPasswordClient } from '../tenant-auth/idp-password-client.js'
import type { ITenantOidcRelyingParty } from '../tenant-auth/tenant-oidc-relying-party.js'
import type { ITenantApiEndpoint, TenantPlane } from '../tenant-auth/tenant-plane.js'
import { TenantEventBus } from '../tenant-api/tenant-events.js'

type Reply = { status: number; body: string; cacheControl?: string; retryAfter?: string; setCookie?: string[] }
type ClientCall = { tenantId: string; email: string; current: string; next: string; baseUrl: string; endUserIp?: string }

class StubDirectory
{
    public GetTenant(id: string): TenantRecord | undefined
    {
        return id === PwKit.TenantId ? ({ id } as TenantRecord) : undefined
    }
}

class QuietService
{
    public OnChanged(_cb: (change: EnvironmentChange) => void): () => void
    {
        return () => undefined
    }
}

class UnusedApi implements ITenantApiEndpoint
{
    public async Handle(_req: IncomingMessage, _res: ServerResponse, _path: string, _session: TenantSession): Promise<boolean>
    {
        return false
    }
}

class UnusedRelyingParty implements ITenantOidcRelyingParty
{
    public async Begin(_tenantId: string, _callbackUrl: string): Promise<{ Url: string; State: string }>
    {
        throw new Error('unused')
    }

    public async Complete(_tenantId: string, _code: string, _state: string, _callbackUrl: string): Promise<{ principalId: string; email?: string }>
    {
        throw new Error('unused')
    }
}

class FakeConnector implements ITenantIdpConnector
{
    public Missing = false
    public Throws = false

    public async ConnectForTenant(tenantId: string): Promise<IdpConnection | undefined>
    {
        if (this.Throws)
        {
            throw new Error('docker down')
        }
        return this.Missing ? undefined : { baseUrl: 'https://idp.test/' + tenantId, browserBaseUrl: '', ca: Buffer.alloc(0), adminToken: '', adminTokenRef: '', caDir: '' }
    }
}

class FakeIdpClient implements IIdpPasswordClient
{
    public Outcome: IdpPasswordOutcome = { Result: IdpPasswordResult.Changed }
    public DelayMs = 0
    public readonly Calls: ClientCall[] = []

    public LastEndUserIp = ''

    public async ChangePassword(conn: IdpConnection, tenantId: string, email: string, currentPassword: string, newPassword: string, endUserIp: string): Promise<IdpPasswordOutcome>
    {
        this.LastEndUserIp = endUserIp
        this.Calls.push({ tenantId, email, current: currentPassword, next: newPassword, baseUrl: conn.baseUrl })
        if (this.DelayMs > 0)
        {
            await new Promise(res => setTimeout(res, this.DelayMs))
        }
        return this.Outcome
    }
}

class FailingRotator implements ISessionRotator
{
    public async RotateFor(_tenantId: string, _principalId: string, _oldSessionId: string): Promise<TenantSession>
    {
        throw new Error('disk full')
    }
}

/** A gate that admits a socket (its upgrade check passed) but finds the session gone on the re-check after tracking. */
class EndedAfterAdmissionGate extends TenantAuthGate
{
    public override async IsLive(_sessionId: string, _tenantId: string): Promise<boolean>
    {
        return false
    }
}

class PwKit
{
    public static readonly TenantId = 'acme'
    public static readonly TenantHost = 'acme.admin.example.com'
    public static readonly Origin = 'https://acme.admin.example.com'
    public static readonly Path = '/tenant-auth/password'
    public static readonly Owner = 'owner'
    public static readonly OwnerEmail = 'owner@acme.test'
    public static readonly Current = 'owner-current-password'
    public static readonly Next = 'owner-new-password-1'

    public static Cookie(token: string): string
    {
        return TenantSessionCookie.Name + '=' + encodeURIComponent(PwKit.TenantId) + '.' + token
    }

    public static Send(host: TenantPlaneHost, method: string, token: string | undefined, body?: unknown, origin: string = PwKit.Origin, path: string = PwKit.Path, extra: Record<string, string> = {}): Promise<Reply>
    {
        const headers: Record<string, string> = { host: PwKit.TenantHost, origin, 'content-type': 'application/json', ...extra }
        if (token !== undefined)
        {
            headers.cookie = PwKit.Cookie(token)
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({
                    status: res.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString('utf8'),
                    cacheControl: res.headers['cache-control'] as string | undefined,
                    retryAfter: res.headers['retry-after'] as string | undefined,
                    setCookie: res.headers['set-cookie'],
                }))
            })
            req.on('error', reject)
            req.end(body === undefined ? undefined : JSON.stringify(body))
        })
    }

    public static Change(host: TenantPlaneHost, token: string | undefined, current: string = PwKit.Current, next: string = PwKit.Next, extra: Record<string, unknown> = {}): Promise<Reply>
    {
        return PwKit.Send(host, 'POST', token, { currentPassword: current, newPassword: next, ...extra })
    }

    /** The session token in a reply's pts_session Set-Cookie. */
    public static TokenFrom(reply: Reply): string
    {
        const cookie = (reply.setCookie ?? []).find(c => c.startsWith(TenantSessionCookie.Name + '='))
        assert.ok(cookie, 'a fresh session cookie is set')
        const read = TenantSessionCookie.Read(cookie.split(';')[0])
        assert.ok(read)
        assert.equal(read.tenantId, PwKit.TenantId)
        assert.match(cookie, /HttpOnly/)
        assert.match(cookie, /SameSite=/)
        return read.token
    }

    public static async OpenEvents(host: TenantPlaneHost, token: string): Promise<WebSocket>
    {
        const ws = new WebSocket(`ws://127.0.0.1:${host.Address().port}/tenant-api/events`, { headers: { host: PwKit.TenantHost, origin: PwKit.Origin, cookie: PwKit.Cookie(token) } })
        await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
        return ws
    }

    public static async ClosedSoon(ws: WebSocket): Promise<boolean>
    {
        if (ws.readyState === WebSocket.CLOSED)
        {
            return true
        }
        return await new Promise<boolean>(res =>
        {
            const timer = setTimeout(() => res(false), 500)
            ws.once('close', () => { clearTimeout(timer); res(true) })
        })
    }
}

describe('Tenant self-service password change (POST /tenant-auth/password)', () =>
{
    let parent: string
    let host: TenantPlaneHost
    let store: TenantSessionStore
    let connector: FakeConnector
    let client: FakeIdpClient
    let logged: string[]
    let originalError: typeof console.error

    async function Start(rotator?: ISessionRotator, gate?: TenantAuthGate, trustedProxy: boolean = false): Promise<void>
    {
        const principals = new TenantPrincipalSessions(store)
        const change = new TenantPasswordChange(connector, client, rotator ?? principals, false, trustedProxy)
        const plane: TenantPlane = {
            endpoint: new TenantAuthEndpoint(new UnusedRelyingParty(), store, false, change),
            gate: gate ?? new TenantAuthGate(store),
            api: new UnusedApi(),
            events: new TenantEventBus(),
            principals,
        }
        const resolver = new TenantHostResolver('admin.example.com', 'https', new StubDirectory() as unknown as PlatformDirectory)
        host = new TenantPlaneHost(plane, resolver, join(parent, 'static'), new QuietService() as unknown as IEnvironmentService)
        await host.Listen(0, '127.0.0.1')
    }

    beforeEach(() =>
    {
        parent = mkdtempSync(join(tmpdir(), 'tenant-pw-'))
        mkdirSync(join(parent, 'static'))
        store = new TenantSessionStore(join(parent, 'tenant-sessions.json'), 3600000)
        connector = new FakeConnector()
        client = new FakeIdpClient()
        logged = []
        originalError = console.error
        console.error = (...args: unknown[]) => { logged.push(args.map(a => String(a)).join(' ')) }
    })

    afterEach(async () =>
    {
        console.error = originalError
        await host?.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('changes the password at the IdP as the SESSION user, rotates the caller onto a fresh session, and ends every other session and socket', async () =>
    {
        await Start()
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const elsewhere = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const colleague = await store.Issue(PwKit.TenantId, 'u2', 'u2@acme.test')
        const mySocket = await PwKit.OpenEvents(host, mine.id)
        const elsewhereSocket = await PwKit.OpenEvents(host, elsewhere.id)
        const colleagueSocket = await PwKit.OpenEvents(host, colleague.id)

        // A body-supplied identity is ignored: the IdP is asked about the session's email and tenant only.
        const r = await PwKit.Change(host, mine.id, PwKit.Current, PwKit.Next, { email: 'victim@acme.test', tenantId: 'other', confirmPassword: PwKit.Next })
        assert.equal(r.status, 200)
        assert.equal(r.cacheControl, 'no-store')
        assert.deepEqual(JSON.parse(r.body), { ok: true, otherSessionsEnded: true })
        assert.deepEqual(client.Calls, [{ tenantId: PwKit.TenantId, email: PwKit.OwnerEmail, current: PwKit.Current, next: PwKit.Next, baseUrl: 'https://idp.test/acme' }])
        assert.match(client.LastEndUserIp, /127\.0\.0\.1$/, 'the end user address (here the socket peer; no trusted proxy) is relayed')

        const fresh = PwKit.TokenFrom(r)
        assert.notEqual(fresh, mine.id)
        assert.equal(await store.Validate(mine.id), null, 'the old cookie no longer works (a stolen copy is useless)')
        assert.equal((await PwKit.Change(host, mine.id, PwKit.Next, 'another-new-password')).status, 401)
        assert.equal((await store.Validate(fresh))?.email, PwKit.OwnerEmail)
        assert.equal(await store.Validate(elsewhere.id), null)
        assert.notEqual(await store.Validate(colleague.id), null)
        assert.equal(await PwKit.ClosedSoon(elsewhereSocket), true)
        await new Promise(res => setTimeout(res, 100))
        assert.equal(mySocket.readyState, WebSocket.OPEN, 'the caller socket moved to the fresh session')
        assert.equal(colleagueSocket.readyState, WebSocket.OPEN)
        // The moved socket now belongs to the fresh session: ending that one closes it.
        assert.equal(host.ClosePrincipal(PwKit.TenantId, PwKit.Owner, fresh), 0)
        assert.equal(host.ClosePrincipal(PwKit.TenantId, PwKit.Owner), 1)
        assert.ok(!r.body.includes(PwKit.Next) && !logged.join('\n').includes(PwKit.Next))
        mySocket.close()
        colleagueSocket.close()
    })

    it('maps the IdP outcomes: wrong current 403, throttled 429 with Retry-After passed through, any other refusal 502', async () =>
    {
        await Start()
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const elsewhere = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        client.Outcome = { Result: IdpPasswordResult.WrongPassword }
        const wrong = await PwKit.Change(host, mine.id)
        assert.equal(wrong.status, 403)
        assert.equal(wrong.cacheControl, 'no-store')
        assert.equal((JSON.parse(wrong.body) as { error: string }).error, 'The current password is not correct.')
        client.Outcome = { Result: IdpPasswordResult.Throttled, RetryAfterSeconds: 42 }
        const throttled = await PwKit.Change(host, mine.id)
        assert.equal(throttled.status, 429)
        assert.equal(throttled.retryAfter, '42')
        client.Outcome = { Result: IdpPasswordResult.Throttled }
        const bare = await PwKit.Change(host, mine.id)
        assert.equal(bare.status, 429)
        assert.equal(bare.retryAfter, undefined)
        client.Outcome = { Result: IdpPasswordResult.Failed }
        const failed = await PwKit.Change(host, mine.id)
        assert.equal(failed.status, 502)
        assert.equal((JSON.parse(failed.body) as { error: string }).error, 'The password could not be changed.')
        assert.notEqual(await store.Validate(elsewhere.id), null, 'no session ends unless the change succeeded')
    })

    it('an IdP that cannot be found or reached is a 503', async () =>
    {
        await Start()
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        connector.Missing = true
        assert.equal((await PwKit.Change(host, mine.id)).status, 503)
        connector.Missing = false
        connector.Throws = true
        assert.equal((await PwKit.Change(host, mine.id)).status, 503)
        assert.equal(client.Calls.length, 0)
    })

    it('a short, mismatched, unchanged or missing new password is a 400 and the IdP is not asked', async () =>
    {
        await Start()
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const short = await PwKit.Change(host, mine.id, PwKit.Current, 'short-pw')
        assert.equal(short.status, 400)
        assert.match(short.body, /at least 12 characters/)
        assert.equal((await PwKit.Change(host, mine.id, PwKit.Current, PwKit.Next, { confirmPassword: 'another-new-password' })).status, 400)
        assert.equal((await PwKit.Change(host, mine.id, PwKit.Current, PwKit.Current)).status, 400)
        assert.equal((await PwKit.Send(host, 'POST', mine.id, { newPassword: PwKit.Next })).status, 400)
        assert.equal((await PwKit.Send(host, 'POST', mine.id, 'not an object')).status, 400)
        assert.equal(client.Calls.length, 0)
    })

    it('needs a session of this tenant (401), a session with an email (409), a POST (405) and the tenant origin (403)', async () =>
    {
        await Start()
        assert.equal((await PwKit.Change(host, undefined)).status, 401)
        assert.equal((await PwKit.Change(host, 'forged-token')).status, 401)
        const otherTenant = await store.Issue('other', PwKit.Owner, PwKit.OwnerEmail)
        assert.equal((await PwKit.Change(host, otherTenant.id)).status, 401)
        const noEmail = await store.Issue(PwKit.TenantId, PwKit.Owner)
        assert.equal((await PwKit.Change(host, noEmail.id)).status, 409)
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        assert.equal((await PwKit.Send(host, 'GET', mine.id)).status, 405)
        assert.equal((await PwKit.Send(host, 'POST', mine.id, { currentPassword: PwKit.Current, newPassword: PwKit.Next }, 'https://evil.example.com')).status, 403)
        assert.equal(client.Calls.length, 0)
    })

    it('a second change while one is running is a 409; the first completes', async () =>
    {
        await Start()
        client.DelayMs = 200
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const first = PwKit.Change(host, mine.id)
        await new Promise(res => setTimeout(res, 50))
        const second = await PwKit.Change(host, mine.id, PwKit.Current, 'another-new-password')
        assert.equal(second.status, 409)
        assert.equal((JSON.parse(second.body) as { error: string }).error, 'A password change for this account is already running.')
        const r = await first
        assert.equal(r.status, 200)
        assert.notEqual(await store.Validate(PwKit.TokenFrom(r)), null)
        assert.equal(client.Calls.length, 1)
    })

    it('a socket admitted just before its session ended is closed by the re-check after tracking', async () =>
    {
        await Start(undefined, new EndedAfterAdmissionGate(store))
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const socket = await PwKit.OpenEvents(host, mine.id)
        assert.equal(await PwKit.ClosedSoon(socket), true)
    })

    it('a rotation whose write fails changes nothing: the caller keeps its session, no socket closes, the warning is truthful', async () =>
    {
        const sub = join(parent, 'sub')
        store = new TenantSessionStore(join(sub, 'tenant-sessions.json'), 3600000)
        await Start()
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const elsewhere = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const mySocket = await PwKit.OpenEvents(host, mine.id)
        const elsewhereSocket = await PwKit.OpenEvents(host, elsewhere.id)
        rmSync(sub, { recursive: true, force: true })
        writeFileSync(sub, 'blocked')
        const r = await PwKit.Change(host, mine.id)
        assert.equal(r.status, 200)
        const body = JSON.parse(r.body) as { otherSessionsEnded: boolean; warning?: string }
        assert.equal(body.otherSessionsEnded, false)
        assert.match(body.warning ?? '', /could not be signed out/)
        assert.equal((r.setCookie ?? []).some(c => c.startsWith(TenantSessionCookie.Name + '=')), false)
        assert.notEqual(await store.Validate(mine.id), null)
        assert.notEqual(await store.Validate(elsewhere.id), null)
        await new Promise(res => setTimeout(res, 100))
        assert.equal(mySocket.readyState, WebSocket.OPEN)
        assert.equal(elsewhereSocket.readyState, WebSocket.OPEN)
        mySocket.close()
        elsewhereSocket.close()
        rmSync(sub, { force: true })
    })

    it('logout whose revocation write fails still clears the cookie and answers signed out; the session is refused', async () =>
    {
        const sub = join(parent, 'sub')
        store = new TenantSessionStore(join(sub, 'tenant-sessions.json'), 3600000)
        await Start()
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        rmSync(sub, { recursive: true, force: true })
        writeFileSync(sub, 'blocked')
        const r = await PwKit.Send(host, 'POST', mine.id, {}, PwKit.Origin, '/tenant-auth/logout')
        assert.equal(r.status, 204)
        assert.ok((r.setCookie ?? []).some(c => c.startsWith(TenantSessionCookie.Name + '=;') || /Max-Age=0/.test(c)))
        assert.equal(await store.Validate(mine.id), null)
        rmSync(sub, { force: true })
    })

    it('the relayed end-user address: the last x-forwarded-for hop only behind a trusted proxy and only when it is an IP', async () =>
    {
        await Start(undefined, undefined, true)
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const body = { currentPassword: PwKit.Current, newPassword: PwKit.Next }
        let r = await PwKit.Send(host, 'POST', mine.id, body, PwKit.Origin, PwKit.Path, { 'x-forwarded-for': '10.0.0.1, 203.0.113.9' })
        assert.equal(client.LastEndUserIp, '203.0.113.9')
        const fresh = PwKit.TokenFrom(r)
        r = await PwKit.Send(host, 'POST', fresh, body, PwKit.Origin, PwKit.Path, { 'x-forwarded-for': 'not an address<script>' })
        assert.equal(r.status, 200)
        assert.match(client.LastEndUserIp, /127\.0\.0\.1$/, 'a malformed hop falls back to the socket peer')
    })

    it('without the trusted-proxy flag x-forwarded-for is ignored: the socket peer is relayed', async () =>
    {
        await Start()
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        await PwKit.Send(host, 'POST', mine.id, { currentPassword: PwKit.Current, newPassword: PwKit.Next }, PwKit.Origin, PwKit.Path, { 'x-forwarded-for': '203.0.113.9' })
        assert.match(client.LastEndUserIp, /127\.0\.0\.1$/)
    })

    it('a change whose session rotation failed still reports success, with otherSessionsEnded false and a warning', async () =>
    {
        await Start(new FailingRotator())
        const mine = await store.Issue(PwKit.TenantId, PwKit.Owner, PwKit.OwnerEmail)
        const r = await PwKit.Change(host, mine.id)
        assert.equal(r.status, 200)
        const body = JSON.parse(r.body) as { ok: boolean; otherSessionsEnded: boolean; warning?: string }
        assert.equal(body.ok, true)
        assert.equal(body.otherSessionsEnded, false)
        assert.match(body.warning ?? '', /could not be signed out/)
    })
})
