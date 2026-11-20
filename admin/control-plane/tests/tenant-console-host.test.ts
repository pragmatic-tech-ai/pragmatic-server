import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { OidcRelyingParty, SessionClaims, SessionStore, SignedInIdentity, UpgradeRefusal, type IOidcClientConfig } from '@pragmatic-tech-ai/pragmatic-app-host'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { AdvertOutcome, AdvertTrigger, ConsoleRegistration, ConsoleRegistrationState } from '../console-registration.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvStatus, EnvType, EnvironmentChangeKind, Template, type EnvironmentChange, type EnvironmentRecord } from '../environment-record.js'
import type { ILogProcess } from '../../../environments/seed/docker.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import { MemoryRecordMap } from '../record-map.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantEventBus, TenantEventType } from '../tenant-api/tenant-events.js'
import type { TenantProfileDto } from '../tenant-api/tenant-profile-dto.js'
import { DesktopAuthGate } from '../tenant-auth/desktop-auth-gate.js'
import { DesktopEndpoint } from '../tenant-auth/desktop-endpoint.js'
import type { DesktopRelay } from '../tenant-auth/desktop-relay.js'
import { DesktopSignInFlows } from '../tenant-auth/desktop-sign-in-flows.js'
import { DesktopTargets } from '../tenant-auth/desktop-targets.js'
import { TenantHostResolver } from '../tenant-auth/tenant-host-resolver.js'
import { TenantOidcClientKind, type ITenantOidcClients } from '../tenant-auth/tenant-oidc-clients.js'
import type { TenantPlane } from '../tenant-auth/tenant-plane.js'
import { TenantPrincipalSessions } from '../tenant-auth/tenant-principal-sessions.js'
import { TenantSessionGate } from '../tenant-auth/tenant-session-gate.js'
import { TenantSessionClaims, TenantSessions } from '../tenant-auth/tenant-sessions.js'
import { TenantConsoleHost } from '../tenant-console-host.js'
import type { TenantHealthMonitor } from '../tenant-health-monitor.js'

type Reply = { status: number; headers: IncomingHttpHeaders; body: string }

/** A directory of fixed tenants (created at the epoch) and their hives. */
class StubDirectory implements ITenantDirectory
{
    public readonly Tenants = new Map<string, TenantRecord>()

    public constructor(ids: readonly string[], private readonly hives: readonly HiveRecord[] = [])
    {
        for (const id of ids)
        {
            this.Tenants.set(id, { id, clientId: 'c', displayName: id, createdAt: '2020-01-01T00:00:00.000Z' })
        }
    }

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.Tenants.get(id)
    }

    public GetHive(id: string): HiveRecord | undefined
    {
        return this.hives.find(h => h.id === id)
    }

    public ListHives(tenantId: string): readonly HiveRecord[]
    {
        return this.hives.filter(h => h.tenantId === tenantId)
    }
}

/** A recording log process. */
class FakeLogProcess implements ILogProcess
{
    public Killed = false
    private sink: ((chunk: string) => void) | undefined

    public Attach(onData: (chunk: string) => void): void
    {
        this.sink = onData
    }

    public Push(chunk: string): void
    {
        this.sink?.(chunk)
    }

    public OnData(cb: (chunk: string) => void): void
    {
        this.sink = cb
    }

    public OnClose(): void
    {
    }

    public Kill(): void
    {
        this.Killed = true
    }
}

/** The environment service surface the console's host touches: changes, List, ListReconciled, LogStream. */
class FakeService
{
    public LastLog: FakeLogProcess | undefined
    private readonly callbacks = new Set<(change: EnvironmentChange) => void>()

    public constructor(private readonly records: EnvironmentRecord[])
    {
    }

    public OnChanged(cb: (change: EnvironmentChange) => void): () => void
    {
        this.callbacks.add(cb)
        return () => this.callbacks.delete(cb)
    }

    public Fire(rec: EnvironmentRecord, kind: EnvironmentChangeKind = EnvironmentChangeKind.Changed): void
    {
        for (const cb of [...this.callbacks])
        {
            cb({ kind, record: rec })
        }
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.records
    }

    public async ListReconciled(): Promise<readonly EnvironmentRecord[]>
    {
        return this.records
    }

    public LogStream(_name: string, onData: (chunk: string) => void): ILogProcess
    {
        const proc = new FakeLogProcess()
        proc.Attach(onData)
        this.LastLog = proc
        return proc
    }
}

/** The console's clients over a fake IdP: records the tenant and callback each sign-in ran with. */
class StubClients implements ITenantOidcClients
{
    public readonly Calls: { tenantId: string; callback: string }[] = []

    public constructor(private readonly idp: FakeOidcIdp, private readonly http: FakeOidcHttpClient, private readonly resolver: TenantHostResolver)
    {
    }

    public async ClientFor(req: IncomingMessage): Promise<IOidcClientConfig>
    {
        const host = req.headers.host as string
        return await this.For(TenantOidcClientKind.Console, this.resolver.TenantFor(host) as string, this.resolver.CallbackFor(host))
    }

    public async For(_kind: TenantOidcClientKind, tenantId: string, callback: string): Promise<IOidcClientConfig>
    {
        this.Calls.push({ tenantId, callback })
        return { Issuer: this.idp.Issuer, DiscoveryUrl: this.idp.DiscoveryUrl, ClientId: 'console', RedirectUri: callback, ClientSecret: 's', Http: this.http, FixedClaims: SessionClaims.From({ [TenantSessionClaims.TenantClaim]: tenantId }) }
    }
}

/** Stands in for DesktopRelay: records the upgrade target and refuses it 418 so the route is observable. */
class StubRelay
{
    private static readonly Teapot = 418
    public readonly Urls: string[] = []
    public readonly RetiredWith: number[] = []
    public Reinstated = 0
    public Closed = 0

    public async Admit(req: IncomingMessage): Promise<UpgradeRefusal | null>
    {
        this.Urls.push(String(req.url))
        return new UpgradeRefusal(StubRelay.Teapot, {})
    }

    public Attach(): void
    {
    }

    public Retire(code: number): number
    {
        this.RetiredWith.push(code)
        return 0
    }

    public Reinstate(): void
    {
        this.Reinstated++
    }

    public async Close(): Promise<void>
    {
        this.Closed++
    }

    public ClosePrincipal(): number
    {
        return 0
    }

    public CloseTenant(): number
    {
        return 0
    }
}

class CountingMonitor
{
    public Starts = 0
    public Stops = 0

    public Start(): void
    {
        this.Starts++
    }

    public Stop(): void
    {
        this.Stops++
    }
}

/** One composed console over in-memory sessions, a fake IdP and a stub directory, listening on a free port. */
class ConsoleKit
{
    public static readonly BaseDomain = 'admin.example.com'
    public static readonly TenantId = 'acme'
    public static readonly OtherTenantId = 'beta'
    public static readonly TenantHost = 'acme.admin.example.com'
    public static readonly OtherHost = 'beta.admin.example.com'
    public static readonly UnknownHost = 'nope.admin.example.com'
    public static readonly ForeignHost = 'evil.example.com'
    public static readonly LoopbackHost = '127.0.0.1:7002'
    public static readonly Origin = 'https://acme.admin.example.com'
    public static readonly Callback = 'https://acme.admin.example.com/tenant-auth/oidc/callback'

    public readonly Directory: StubDirectory
    public readonly Service: FakeService
    public readonly Sessions: TenantSessions
    public readonly Plane: TenantPlane
    public readonly Clients: StubClients
    public readonly Host: TenantConsoleHost
    public readonly Root: string

    private constructor(public readonly Idp: FakeOidcIdp, public readonly Http: FakeOidcHttpClient, options: { externalPort?: number; desktop?: boolean; consoleTenant?: string; relay?: StubRelay; registration?: ConsoleRegistration; monitor?: CountingMonitor })
    {
        this.Root = mkdtempSync(join(tmpdir(), 'tch-'))
        writeFileSync(join(this.Root, 'index.html'), 'TENANT-BUNDLE')
        this.Directory = new StubDirectory([ConsoleKit.TenantId, ConsoleKit.OtherTenantId])
        this.Service = new FakeService([ConsoleKit.Env('acme-dev', ConsoleKit.TenantId), ConsoleKit.Env('beta-dev', ConsoleKit.OtherTenantId)])
        const service = this.Service as unknown as IEnvironmentService
        const resolver = new TenantHostResolver(ConsoleKit.BaseDomain, 'https', this.Directory, options.externalPort)
        this.Sessions = new TenantSessions(TenantSessions.InMemory(), false)
        this.Clients = new StubClients(Idp, Http, resolver)
        const relyingParty = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
        const api = new TenantApiEndpoint(service, this.Directory, undefined as never, undefined as never, undefined as never)
        this.Plane = {
            sessions: this.Sessions,
            gate: new TenantSessionGate(this.Sessions.Store, this.Sessions.Cookie, resolver, this.Directory),
            relyingParty,
            clients: this.Clients,
            api,
            events: new TenantEventBus(),
            principals: new TenantPrincipalSessions(this.Sessions.Store),
        }
        if (options.desktop === true)
        {
            const gate = new DesktopAuthGate(this.Sessions.Store, this.Directory)
            this.Plane.desktop = new DesktopEndpoint({ RelyingParty: relyingParty, Clients: this.Clients }, this.Sessions, gate, new DesktopSignInFlows(), new DesktopTargets(service), this.Directory,
                s => ({ principalId: s.principalId } as TenantProfileDto), undefined, options.consoleTenant)
        }
        if (options.relay !== undefined)
        {
            this.Plane.relay = options.relay as unknown as DesktopRelay
        }
        this.Host = new TenantConsoleHost({ Plane: this.Plane, Resolver: resolver, Service: service, PortalRoot: this.Root, Registration: options.registration, Monitor: options.monitor as unknown as TenantHealthMonitor })
    }

    public static async Start(options: { externalPort?: number; desktop?: boolean; consoleTenant?: string; relay?: StubRelay; registration?: ConsoleRegistration; monitor?: CountingMonitor } = {}): Promise<ConsoleKit>
    {
        const idp = await FakeOidcIdp.Create()
        const kit = new ConsoleKit(idp, new FakeOidcHttpClient(idp), options)
        await kit.Host.Listen(0, '127.0.0.1')
        return kit
    }

    public async Stop(): Promise<void>
    {
        await this.Host.Close()
        rmSync(this.Root, { recursive: true, force: true })
    }

    public static Env(name: string, tenantId: string): EnvironmentRecord
    {
        return {
            name, type: EnvType.Development, template: Template.DevBlank, environmentId: name, tenantId, hostPort: 8101, containerName: 'ctr-' + name,
            volumeName: 'vol-' + name, bundleDir: '/bundle/' + name, createdAt: '2026-10-23T00:00:00.000Z', status: EnvStatus.Running,
        }
    }

    public Raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply>
    {
        const addr = this.Host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' } }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end(body)
        })
    }

    /** A console session of `principal` in `tenant`, as its cookie header. */
    public async Cookie(principal: string, tenant: string = ConsoleKit.TenantId): Promise<string>
    {
        const issued = await this.Sessions.Store.Issue(principal, TenantSessionClaims.Of(tenant, principal + '@acme.test'), TenantSessions.ConsolePolicy)
        return TenantSessions.CookieName + '=' + issued.Token
    }

    /** A single-use socket ticket for a cookie (POST /tenant-api/ws-ticket). */
    public async Ticket(cookie: string): Promise<string>
    {
        const r = await this.Raw('POST', TenantConsoleHost.TicketPath, { host: ConsoleKit.TenantHost, cookie, origin: 'http://' + ConsoleKit.TenantHost }, '{}')
        assert.equal(r.status, 200)
        return (JSON.parse(r.body) as { ticket: string }).ticket
    }

    public Socket(path: string, host: string, ticket?: string): WebSocket
    {
        const { port } = this.Host.Address()
        return new WebSocket('ws://127.0.0.1:' + String(port) + path, ticket === undefined ? [] : [ticket], { headers: { Host: host, Origin: 'http://' + host } })
    }

    public static Opened(ws: WebSocket): Promise<boolean>
    {
        return new Promise(res =>
        {
            ws.once('open', () => res(true))
            ws.once('error', () => res(false))
            ws.once('close', () => res(false))
        })
    }

    public static Closed(ws: WebSocket): Promise<number>
    {
        return new Promise(res => ws.once('close', code => res(code)))
    }

    public static Next(ws: WebSocket): Promise<string>
    {
        return new Promise(res => ws.once('message', data => res(String(data))))
    }

    /** Dials the relay path raw and resolves the status line and body of the answer. */
    public RawRelay(): Promise<{ statusLine: string; body: string }>
    {
        const { port } = this.Host.Address()
        return new Promise((res, rej) =>
        {
            const socket = connect(port, '127.0.0.1', () =>
            {
                socket.write(['GET /desktop/relay?environment=acme-dev&action=contribute HTTP/1.1', 'Host: ' + ConsoleKit.LoopbackHost, 'Connection: Upgrade', 'Upgrade: websocket',
                    'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', '', ''].join('\r\n'))
            })
            const chunks: Buffer[] = []
            socket.on('data', (c: Buffer) => chunks.push(c))
            socket.on('error', rej)
            socket.on('close', () =>
            {
                const text = Buffer.concat(chunks).toString('utf8')
                const split = text.indexOf('\r\n\r\n')
                res({ statusLine: text.slice(0, text.indexOf('\r\n')), body: split < 0 ? '' : text.slice(split + 4) })
            })
        })
    }
}

describe('TenantConsoleHost routing and isolation', () =>
{
    let kit: ConsoleKit

    beforeEach(async () => { kit = await ConsoleKit.Start() })
    afterEach(async () => { await kit.Stop() })

    it('refuses an unknown subdomain host and a foreign host with 403 before routing', async () =>
    {
        for (const host of [ConsoleKit.UnknownHost, ConsoleKit.ForeignHost, ConsoleKit.LoopbackHost])
        {
            const r = await kit.Raw('GET', '/tenant-api/hives', { host })
            assert.equal(r.status, 403, host)
        }
    })

    it('answers an operator path with a JSON 404 or the portal: no operator surface exists here', async () =>
    {
        assert.equal((await kit.Raw('GET', '/tenant-api/operators', { host: ConsoleKit.TenantHost })).status, 404)
        const ping = await kit.Raw('GET', '/api/ping', { host: ConsoleKit.TenantHost })
        assert.equal(ping.body.includes('"ok"'), false)
    })

    it('begin redirects to the IdP with the host-derived tenant and callback', async () =>
    {
        const r = await kit.Raw('GET', TenantConsoleHost.BeginPath, { host: ConsoleKit.TenantHost })
        assert.equal(r.status, 302)
        assert.ok(String(r.headers.location).startsWith(kit.Idp.AuthorizationEndpoint + '?'))
        assert.equal(new URL(String(r.headers.location)).searchParams.get('redirect_uri'), ConsoleKit.Callback)
        assert.deepEqual(kit.Clients.Calls, [{ tenantId: ConsoleKit.TenantId, callback: ConsoleKit.Callback }])
    })

    it('a full sign-in: the callback issues the pts_session cookie; the session names the subject, tenant and bridged roles', async () =>
    {
        const begin = new URL(String((await kit.Raw('GET', TenantConsoleHost.BeginPath, { host: ConsoleKit.TenantHost })).headers.location))
        kit.Http.NextTokenResponse = kit.Idp.TokenResponse(await kit.Idp.MintIdToken({ sub: 'user-1', aud: 'console', nonce: begin.searchParams.get('nonce'), email: 'u@acme.test' }))
        const callback = await kit.Raw('GET', TenantConsoleHost.CallbackPath + '?code=c&state=' + encodeURIComponent(begin.searchParams.get('state') ?? ''), { host: ConsoleKit.TenantHost })
        assert.equal(callback.status, 302)
        assert.equal(callback.headers.location, '/')
        const cookie = String(callback.headers['set-cookie']).split(';')[0] as string
        assert.ok(cookie.startsWith(TenantSessions.CookieName + '='))
        const session = await kit.Raw('GET', TenantConsoleHost.SessionPath, { host: ConsoleKit.TenantHost, cookie })
        assert.equal(session.status, 200)
        assert.deepEqual(JSON.parse(session.body), { subject: 'user-1', claims: { app_roles: [], email: ['u@acme.test'], roles: ['admin'], tenant: [ConsoleKit.TenantId] } })
        assert.equal((await kit.Raw('GET', '/tenant-api/hives', { host: ConsoleKit.TenantHost, cookie })).status, 200)
    })

    it('rejects /tenant-api with no cookie, an operator cookie, or another tenant\'s session as 401', async () =>
    {
        assert.equal((await kit.Raw('GET', '/tenant-api/hives', { host: ConsoleKit.TenantHost })).status, 401)
        assert.equal((await kit.Raw('GET', '/tenant-api/hives', { host: ConsoleKit.TenantHost, cookie: 'cp_session=operator-token' })).status, 401)
        const beta = await kit.Cookie('user-b', ConsoleKit.OtherTenantId)
        assert.equal((await kit.Raw('GET', '/tenant-api/hives', { host: ConsoleKit.TenantHost, cookie: beta })).status, 401)
        assert.equal((await kit.Raw('GET', '/tenant-api/hives', { host: ConsoleKit.OtherHost, cookie: beta })).status, 200)
    })

    it('a mutation from a foreign Origin, or another tenant host\'s, is 403; the own Origin passes', async () =>
    {
        const cookie = await kit.Cookie('user-1')
        for (const origin of ['https://evil.example.com', 'https://beta.admin.example.com'])
        {
            assert.equal((await kit.Raw('POST', TenantConsoleHost.LogoutPath, { host: ConsoleKit.TenantHost, cookie, origin }, '{}')).status, 403, origin)
        }
        const own = await kit.Raw('POST', TenantConsoleHost.LogoutPath, { host: ConsoleKit.TenantHost, cookie, origin: 'http://' + ConsoleKit.TenantHost }, '{}')
        assert.ok(own.status < 300, String(own.status))
        assert.equal((await kit.Raw('GET', TenantConsoleHost.SessionPath, { host: ConsoleKit.TenantHost, cookie })).status, 401)
    })

    it('an environment admin may not change settings (403 from the host), the admin may', async () =>
    {
        kit.Directory.Tenants.set(ConsoleKit.TenantId, { ...kit.Directory.Tenants.get(ConsoleKit.TenantId)!, ownerPrincipalId: 'owner-1' })
        const member = await kit.Cookie('member-1')
        const put = await kit.Raw('PUT', '/tenant-api/environments/acme-dev/admin/config', { host: ConsoleKit.TenantHost, cookie: member, origin: 'http://' + ConsoleKit.TenantHost }, '{}')
        assert.equal(put.status, 403)
        const profile = JSON.parse((await kit.Raw('GET', '/tenant-api/profile', { host: ConsoleKit.TenantHost, cookie: member })).body) as TenantProfileDto
        assert.deepEqual(profile.capabilities, { envs: true, adopt: true, access: false, settings: false })
    })

    it('serves the portal bundle with its SPA fallback, and never outside its root', async () =>
    {
        const index = await kit.Raw('GET', '/', { host: ConsoleKit.TenantHost })
        assert.equal(index.status, 200)
        assert.equal(index.body, 'TENANT-BUNDLE')
        assert.equal((await kit.Raw('GET', '/environments', { host: ConsoleKit.TenantHost })).body, 'TENANT-BUNDLE')
        assert.equal((await kit.Raw('GET', '/..%2fsecret.txt', { host: ConsoleKit.TenantHost })).status, 404)
    })

    it('answers /healthz on any Host without a session', async () =>
    {
        assert.equal((await kit.Raw('GET', '/healthz', { host: 'anything.test' })).status, 200)
    })
})

describe('TenantConsoleHost with an external port (proxy-less local run)', () =>
{
    it('the OIDC callback carries the external port; the tenant host is accepted with or without it, and 403 on another port', async () =>
    {
        const kit = await ConsoleKit.Start({ externalPort: 7002 })
        try
        {
            const begin = await kit.Raw('GET', TenantConsoleHost.BeginPath, { host: 'acme.admin.example.com:7002' })
            assert.equal(begin.status, 302)
            assert.equal(kit.Clients.Calls[0]?.callback, 'https://acme.admin.example.com:7002/tenant-auth/oidc/callback')
            assert.equal((await kit.Raw('GET', TenantConsoleHost.BeginPath, { host: ConsoleKit.TenantHost })).status, 302)
            assert.equal((await kit.Raw('GET', TenantConsoleHost.BeginPath, { host: 'acme.admin.example.com:7003' })).status, 403)
        }
        finally
        {
            await kit.Stop()
        }
    })
})

describe('TenantConsoleHost sockets', () =>
{
    let kit: ConsoleKit

    beforeEach(async () => { kit = await ConsoleKit.Start() })
    afterEach(async () => { await kit.Stop() })

    it('the events socket opens with a ticket and delivers only its own tenant\'s events', async () =>
    {
        const ws = kit.Socket(TenantConsoleHost.EventsPath, ConsoleKit.TenantHost, await kit.Ticket(await kit.Cookie('user-1')))
        assert.equal(await ConsoleKit.Opened(ws), true)
        await new Promise(res => setTimeout(res, 50))
        const next = ConsoleKit.Next(ws)
        kit.Service.Fire(ConsoleKit.Env('beta-dev', ConsoleKit.OtherTenantId))
        kit.Service.Fire(ConsoleKit.Env('acme-dev', ConsoleKit.TenantId), EnvironmentChangeKind.Created)
        assert.deepEqual(JSON.parse(await next), { type: TenantEventType.EnvironmentCreated, environmentName: 'acme-dev' })
        ws.close()
    })

    it('a socket without a ticket, or with one used twice, is refused', async () =>
    {
        assert.equal(await ConsoleKit.Opened(kit.Socket(TenantConsoleHost.EventsPath, ConsoleKit.TenantHost)), false)
        const ticket = await kit.Ticket(await kit.Cookie('user-1'))
        const first = kit.Socket(TenantConsoleHost.EventsPath, ConsoleKit.TenantHost, ticket)
        assert.equal(await ConsoleKit.Opened(first), true)
        assert.equal(await ConsoleKit.Opened(kit.Socket(TenantConsoleHost.EventsPath, ConsoleKit.TenantHost, ticket)), false)
        first.close()
    })

    it('a ticket used on another tenant\'s host closes the socket with a policy violation', async () =>
    {
        const ws = kit.Socket(TenantConsoleHost.EventsPath, ConsoleKit.OtherHost, await kit.Ticket(await kit.Cookie('user-1')))
        assert.equal(await ConsoleKit.Closed(ws), 1008)
    })

    it('streams log chunks of an owned environment and kills the stream on close; a foreign one starts none', async () =>
    {
        const cookie = await kit.Cookie('user-1')
        const ws = kit.Socket('/tenant-api/environments/acme-dev/logs/stream', ConsoleKit.TenantHost, await kit.Ticket(cookie))
        assert.equal(await ConsoleKit.Opened(ws), true)
        await new Promise(res => setTimeout(res, 50))
        const next = ConsoleKit.Next(ws)
        kit.Service.LastLog?.Push('line-1')
        assert.ok((await next).includes('line-1'))
        const closed = ConsoleKit.Closed(ws)
        ws.close()
        await closed
        await new Promise(res => setTimeout(res, 50))
        assert.equal(kit.Service.LastLog?.Killed, true)
        kit.Service.LastLog = undefined
        const foreign = kit.Socket('/tenant-api/environments/beta-dev/logs/stream', ConsoleKit.TenantHost, await kit.Ticket(cookie))
        await ConsoleKit.Closed(foreign)
        assert.equal(kit.Service.LastLog, undefined)
    })

    it('ClosePrincipal (an Owner reset) closes that principal\'s sockets only; CloseTenant every socket of the tenant', async () =>
    {
        const a = kit.Socket(TenantConsoleHost.EventsPath, ConsoleKit.TenantHost, await kit.Ticket(await kit.Cookie('user-1')))
        const b = kit.Socket(TenantConsoleHost.EventsPath, ConsoleKit.TenantHost, await kit.Ticket(await kit.Cookie('user-2')))
        assert.equal(await ConsoleKit.Opened(a), true)
        assert.equal(await ConsoleKit.Opened(b), true)
        await new Promise(res => setTimeout(res, 50))
        const aClosed = ConsoleKit.Closed(a)
        await kit.Plane.principals.RevokeAllFor(ConsoleKit.TenantId, 'user-1')
        await aClosed
        assert.equal(b.readyState, WebSocket.OPEN)
        const bClosed = ConsoleKit.Closed(b)
        assert.equal(kit.Host.CloseTenant(ConsoleKit.TenantId), 1)
        await bClosed
    })

    it('a ticket whose session ended before the upgrade opens nothing', async () =>
    {
        const cookie = await kit.Cookie('user-1')
        const ticket = await kit.Ticket(cookie)
        await kit.Sessions.Store.Revoke(cookie.split('=')[1] as string)
        assert.equal(await ConsoleKit.Opened(kit.Socket(TenantConsoleHost.EventsPath, ConsoleKit.TenantHost, ticket)), false)
    })
})

describe('TenantConsoleHost health monitor lifecycle', () =>
{
    it('starts the monitor once on Listen and stops it once on Close', async () =>
    {
        const monitor = new CountingMonitor()
        const kit = await ConsoleKit.Start({ monitor })
        assert.equal(monitor.Starts, 1)
        assert.equal(monitor.Stops, 0)
        await kit.Stop()
        assert.equal(monitor.Stops, 1)
    })
})

describe('TenantConsoleHost desktop surface', () =>
{
    it('the desktop routes answer on any Host with the bearer\'s tenant; an unknown desktop path is a JSON 404, a wrong method 405', async () =>
    {
        const kit = await ConsoleKit.Start({ desktop: true })
        try
        {
            const desktop = await kit.Sessions.IssueDesktop(new SignedInIdentity('sub-1', TenantSessionClaims.Of(ConsoleKit.TenantId, undefined)))
            const ok = await kit.Raw('GET', '/desktop/targets', { host: ConsoleKit.LoopbackHost, authorization: 'Bearer ' + desktop.Token })
            assert.equal(ok.status, 200)
            assert.deepEqual(JSON.parse(ok.body), { contribute: [{ name: 'acme-dev', status: EnvStatus.Running }], publish: [] })
            const signedOut = await kit.Raw('GET', '/desktop/targets', { host: ConsoleKit.LoopbackHost })
            assert.deepEqual([signedOut.status, JSON.parse(signedOut.body)], [401, { error: 'signed-out' }])
            const unknown = await kit.Raw('GET', '/desktop/nothing', { host: ConsoleKit.LoopbackHost })
            assert.deepEqual([unknown.status, JSON.parse(unknown.body)], [404, { error: 'not-found' }])
            const wrong = await kit.Raw('GET', '/desktop/sign-out', { host: ConsoleKit.LoopbackHost })
            assert.equal(wrong.status, 405)
            assert.equal(wrong.headers.allow, 'POST')
            assert.equal((await kit.Raw('GET', TenantConsoleHost.SessionPath, { host: ConsoleKit.LoopbackHost })).status, 403)
        }
        finally
        {
            await kit.Stop()
        }
    })

    it('a request carrying an Origin is refused on the desktop surface (a browser page cannot drive it)', async () =>
    {
        const kit = await ConsoleKit.Start({ desktop: true })
        try
        {
            const r = await kit.Raw('GET', '/desktop/targets', { host: ConsoleKit.LoopbackHost, origin: 'http://' + ConsoleKit.LoopbackHost })
            assert.equal(r.status, 403)
        }
        finally
        {
            await kit.Stop()
        }
    })

    it('routes the /desktop/relay upgrade to the relay on any Host (its own HTTP answer), and closes the relay with the host', async () =>
    {
        const relay = new StubRelay()
        const kit = await ConsoleKit.Start({ desktop: true, relay })
        const answer = await kit.RawRelay()
        assert.ok(answer.statusLine.startsWith('HTTP/1.1 418'))
        assert.deepEqual(relay.Urls, ['/desktop/relay?environment=acme-dev&action=contribute'])
        await kit.Stop()
        assert.equal(relay.Closed, 1)
    })

    it('destroys a /desktop/relay upgrade when the plane has no relay', async () =>
    {
        const kit = await ConsoleKit.Start({ desktop: true })
        try
        {
            assert.equal((await kit.RawRelay()).statusLine, '')
        }
        finally
        {
            await kit.Stop()
        }
    })

    it('a refused console answers 503 on the desktop routes but still answers /desktop/console, and refuses the relay 503 before asking it', async () =>
    {
        const map = new MemoryRecordMap<unknown>()
        await map.Save(new Map([[ConsoleRegistration.StateKey, ConsoleRegistrationState.Refused]]), new Set([ConsoleRegistration.StateKey]))
        const registration = await ConsoleRegistration.Open(map, () => undefined)
        const relay = new StubRelay()
        const kit = await ConsoleKit.Start({ desktop: true, consoleTenant: ConsoleKit.TenantId, relay, registration })
        try
        {
            const targets = await kit.Raw('GET', '/desktop/targets', { host: ConsoleKit.LoopbackHost })
            assert.deepEqual([targets.status, JSON.parse(targets.body)], [503, ConsoleRegistration.RefusedBody])
            const lookup = await kit.Raw('GET', DesktopEndpoint.ConsolePath, { host: ConsoleKit.LoopbackHost })
            assert.deepEqual([lookup.status, JSON.parse(lookup.body)], [200, { tenantId: ConsoleKit.TenantId, tenantName: ConsoleKit.TenantId }])
            const upgrade = await kit.RawRelay()
            assert.ok(upgrade.statusLine.startsWith('HTTP/1.1 503'))
            assert.deepEqual(JSON.parse(upgrade.body), ConsoleRegistration.RefusedBody)
            assert.deepEqual(relay.Urls, [])
            assert.deepEqual(relay.RetiredWith, [4003])
        }
        finally
        {
            await kit.Stop()
        }
    })

    it('becoming Refused retires the relay with 4003; Registered again reinstates it', async () =>
    {
        const registration = await ConsoleRegistration.Open(new MemoryRecordMap<unknown>(), () => undefined)
        const relay = new StubRelay()
        const kit = await ConsoleKit.Start({ desktop: true, relay, registration })
        try
        {
            await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
            await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
            assert.deepEqual(relay.RetiredWith, [4003])
            await registration.Observe(AdvertOutcome.Accepted, AdvertTrigger.Timer)
            assert.equal(relay.Reinstated, 1)
        }
        finally
        {
            await kit.Stop()
        }
    })
})

describe('TenantConsoleHost and the operator plane share no session', () =>
{
    it('a session without a tenant claim (an operator\'s) never authenticates a tenant route', async () =>
    {
        const kit = await ConsoleKit.Start()
        try
        {
            const operator = await kit.Sessions.Store.Issue('op-1', SessionClaims.From({ email: 'op@platform.test', app_roles: ['operator.full'], amr: ['pwd'] }))
            const r = await kit.Raw('GET', '/tenant-api/hives', { host: ConsoleKit.TenantHost, cookie: TenantSessions.CookieName + '=' + operator.Token })
            assert.equal(r.status, 401)
            assert.equal(SessionStore.DigestOf(operator.Token).length > 0, true)
        }
        finally
        {
            await kit.Stop()
        }
    })
})
