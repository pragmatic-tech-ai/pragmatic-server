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
import { EnvStatus, EnvType, EnvironmentChangeKind, Template, type EnvironmentChange, type EnvironmentRecord } from '../environment-record.js'
import type { ILogProcess } from '../../../environments/seed/docker.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { TenantRecord } from '../platform-records.js'
import { TenantHostResolver } from '../tenant-auth/tenant-host-resolver.js'
import { TenantSessionStore, type TenantSession } from '../tenant-auth/tenant-session.js'
import { TenantSessionCookie } from '../tenant-auth/tenant-session-cookie.js'
import { TenantAuthEndpoint } from '../tenant-auth/tenant-auth-endpoint.js'
import { TenantAuthGate } from '../tenant-auth/tenant-auth-gate.js'
import type { ITenantOidcRelyingParty } from '../tenant-auth/tenant-oidc-relying-party.js'
import type { ITenantApiEndpoint, TenantPlane } from '../tenant-auth/tenant-plane.js'
import { TenantEventBus } from '../tenant-api/tenant-events.js'

type Reply = { status: number; body: string }

enum HttpMethod
{
    Get = 'GET',
    Post = 'POST',
}

/** A directory that knows exactly the tenant ids it was seeded with (the only surface the resolver touches). */
class StubDirectory
{
    public constructor(private readonly ids: readonly string[])
    {
    }

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.ids.includes(id) ? ({ id } as TenantRecord) : undefined
    }
}

/** A recording log process: forwards pushed chunks and flags when Kill ran. */
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

/**
 * A minimal environment service exposing only what the tenant listener touches: the change subscription (RULING 5),
 * List (log-socket ownership check) and LogStream (the forwarded chunks). Everything else is unused.
 */
class FakeStreamingService
{
    public readonly LogStreamNames: string[] = []
    public LastLogProcess: FakeLogProcess | undefined
    private readonly changeCallbacks = new Set<(change: EnvironmentChange) => void>()
    private readonly records: EnvironmentRecord[]

    public constructor(records: EnvironmentRecord[])
    {
        this.records = records
    }

    public OnChanged(cb: (change: EnvironmentChange) => void): () => void
    {
        this.changeCallbacks.add(cb)
        return () => this.changeCallbacks.delete(cb)
    }

    public FireChange(rec: EnvironmentRecord, kind: EnvironmentChangeKind = EnvironmentChangeKind.Changed): void
    {
        for (const cb of [...this.changeCallbacks])
        {
            cb({ kind, record: rec })
        }
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.records
    }

    public LogStream(name: string, onData: (chunk: string) => void): ILogProcess
    {
        this.LogStreamNames.push(name)
        const proc = new FakeLogProcess()
        proc.Attach(onData)
        this.LastLogProcess = proc
        return proc
    }
}

/** A stub tenant data API that answers every gated request 200, echoing the resolved tenant and path. */
class StubTenantApi implements ITenantApiEndpoint
{
    public Calls = 0
    private static readonly StatusOk = 200
    private static readonly ContentType = 'Content-Type'
    private static readonly JsonType = 'application/json; charset=utf-8'

    public async Handle(_req: IncomingMessage, res: ServerResponse, path: string, session: TenantSession): Promise<boolean>
    {
        this.Calls++
        res.writeHead(StubTenantApi.StatusOk, { [StubTenantApi.ContentType]: StubTenantApi.JsonType })
        res.end(JSON.stringify({ path, tenantId: session.tenantId }))
        return true
    }
}

/** Captures the tenant id + callback the endpoint passes, and encodes both into the authorize URL it returns. */
class CapturingRelyingParty implements ITenantOidcRelyingParty
{
    public LastTenantId: string | undefined
    public LastCallback: string | undefined
    private static readonly Authorize = 'https://idp.test/authorize'
    private static readonly RedirectParam = '?redirect_uri='
    private static readonly TenantParam = '&tn='

    public async Begin(tenantId: string, callbackUrl?: string): Promise<{ Url: string; State: string }>
    {
        this.LastTenantId = tenantId
        this.LastCallback = callbackUrl
        return {
            Url: CapturingRelyingParty.Authorize + CapturingRelyingParty.RedirectParam + encodeURIComponent(callbackUrl ?? '') + CapturingRelyingParty.TenantParam + tenantId,
            State: 's',
        }
    }

    public async Complete(tenantId: string, _code: string, _state: string, callbackUrl?: string): Promise<{ principalId: string; email?: string }>
    {
        this.LastTenantId = tenantId
        this.LastCallback = callbackUrl
        return { principalId: 'sub-1' }
    }
}

class Kit
{
    public static readonly BaseDomain = 'admin.example.com'
    public static readonly Scheme = 'https'
    public static readonly TenantId = 'acme'
    public static readonly TenantHost = 'acme.admin.example.com'
    public static readonly ForeignHost = 'evil.example.com'
    public static readonly UnknownHost = 'nope.admin.example.com'
    public static readonly ExpectedCallback = 'https://acme.admin.example.com/tenant-auth/oidc/callback'
    public static readonly AllowedOrigin = 'https://acme.admin.example.com'
    public static readonly ForeignOrigin = 'https://evil.example.com'
    public static readonly CrossTenantOrigin = 'https://other.admin.example.com'
    public static readonly OperatorCookie = 'cp_session=operator-token'
    public static readonly HostHeader = 'host'
    public static readonly CookieHeader = 'cookie'
    public static readonly OriginHeader = 'origin'
    public static readonly BeginPath = '/tenant-auth/oidc/begin'
    public static readonly SessionPath = '/tenant-auth/session'
    public static readonly LogoutPath = '/tenant-auth/logout'
    public static readonly TenantApiHivesPath = '/tenant-api/hives'
    public static readonly ApiPingPath = '/api/ping'
    public static readonly RootPath = '/'
    private static readonly PairSeparator = '='
    private static readonly TenantTokenSeparator = '.'

    public static Resolver(): TenantHostResolver
    {
        return new TenantHostResolver(Kit.BaseDomain, Kit.Scheme, new StubDirectory([Kit.TenantId]) as unknown as PlatformDirectory)
    }

    public static PtsCookie(tenantId: string, token: string): string
    {
        return TenantSessionCookie.Name + Kit.PairSeparator + encodeURIComponent(tenantId) + Kit.TenantTokenSeparator + token
    }

    public static Raw(host: TenantPlaneHost, method: string, path: string, headers: Record<string, string>): Promise<Reply>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end()
        })
    }

    public static Delay(ms: number): Promise<void>
    {
        return new Promise(res => setTimeout(res, ms))
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

    public static Record(name: string, tenantId: string): EnvironmentRecord
    {
        return {
            name,
            type: EnvType.Development,
            template: Template.DevBlank,
            environmentId: name,
            tenantId,
            hostPort: 8101,
            containerName: 'ctr-' + name,
            volumeName: 'vol-' + name,
            bundleDir: '/bundle/' + name,
            createdAt: '2026-10-23T00:00:00.000Z',
            status: EnvStatus.Running,
        }
    }
}

describe('TenantPlaneHost routing and isolation', () =>
{
    let parent: string
    let host: TenantPlaneHost
    let store: TenantSessionStore
    let api: StubTenantApi
    let rp: CapturingRelyingParty
    let tenantRoot: string
    const IndexFile = 'index.html'
    const SecretFile = 'secret.txt'
    const TenantSentinel = 'TENANT-BUNDLE'
    const TraversalPath = '/../secret.txt'
    const EncodedTraversalPath = '/..%2fsecret.txt'

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'tph-'))
        tenantRoot = join(parent, 'tenant-static')
        mkdirSync(tenantRoot)
        writeFileSync(join(tenantRoot, IndexFile), TenantSentinel)
        writeFileSync(join(parent, SecretFile), 'secret')
        store = new TenantSessionStore(join(parent, 'tenant-sessions.json'), 3600000)
        api = new StubTenantApi()
        rp = new CapturingRelyingParty()
        const plane: TenantPlane = {
            endpoint: new TenantAuthEndpoint(rp, store, false),
            gate: new TenantAuthGate(store),
            api,
            events: new TenantEventBus(),
        }
        host = new TenantPlaneHost(plane, Kit.Resolver(), tenantRoot, new FakeStreamingService([]) as unknown as IEnvironmentService)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('refuses an unknown subdomain host with 403 before routing', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.TenantApiHivesPath, { [Kit.HostHeader]: Kit.UnknownHost })
        assert.equal(r.status, 403)
        assert.equal(JSON.parse(r.body).error, 'Host not allowed')
        assert.equal(api.Calls, 0)
    })

    it('refuses a foreign-domain host with 403', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.RootPath, { [Kit.HostHeader]: Kit.ForeignHost })
        assert.equal(r.status, 403)
    })

    it('answers /api/ping with 404 (no operator surface exists on this listener)', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.ApiPingPath, { [Kit.HostHeader]: Kit.TenantHost })
        assert.equal(r.status, 404)
    })

    it('begin redirects to authorize with the host-derived tenant and callback', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.BeginPath, { [Kit.HostHeader]: Kit.TenantHost })
        assert.equal(r.status, 302)
        assert.equal(rp.LastTenantId, Kit.TenantId)
        assert.equal(rp.LastCallback, Kit.ExpectedCallback)
    })

    it('rejects /tenant-api with no tenant cookie as 401', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.TenantApiHivesPath, { [Kit.HostHeader]: Kit.TenantHost })
        assert.equal(r.status, 401)
        assert.equal(JSON.parse(r.body).error, 'Authentication required')
        assert.equal(api.Calls, 0)
    })

    it('rejects /tenant-api carrying only an operator cookie as 401', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.TenantApiHivesPath, { [Kit.HostHeader]: Kit.TenantHost, [Kit.CookieHeader]: Kit.OperatorCookie })
        assert.equal(r.status, 401)
        assert.equal(api.Calls, 0)
    })

    it('passes a valid /tenant-api request through the gate to the api', async () =>
    {
        const issued = await store.Issue(Kit.TenantId, 'u1')
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.TenantApiHivesPath, {
            [Kit.HostHeader]: Kit.TenantHost,
            [Kit.CookieHeader]: Kit.PtsCookie(Kit.TenantId, issued.id),
        })
        assert.equal(r.status, 200)
        assert.equal(api.Calls, 1)
        assert.equal(JSON.parse(r.body).tenantId, Kit.TenantId)
    })

    it('reaches the /tenant-auth endpoint without any gate', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.SessionPath, { [Kit.HostHeader]: Kit.TenantHost })
        assert.equal(r.status, 401)
        assert.equal(JSON.parse(r.body).error, 'unauthorized')
    })

    it('rejects a mutating request with a foreign Origin as 403', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Post, Kit.LogoutPath, {
            [Kit.HostHeader]: Kit.TenantHost,
            [Kit.OriginHeader]: Kit.ForeignOrigin,
        })
        assert.equal(r.status, 403)
        assert.equal(JSON.parse(r.body).error, 'Origin not allowed')
    })

    it('allows a mutating request with the own-host Origin', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Post, Kit.LogoutPath, {
            [Kit.HostHeader]: Kit.TenantHost,
            [Kit.OriginHeader]: Kit.AllowedOrigin,
        })
        assert.equal(r.status, 204)
    })

    it('rejects a mutating /tenant-api request whose Origin is another tenant host as 403', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Post, Kit.TenantApiHivesPath, {
            [Kit.HostHeader]: Kit.TenantHost,
            [Kit.OriginHeader]: Kit.CrossTenantOrigin,
        })
        assert.equal(r.status, 403)
        assert.equal(JSON.parse(r.body).error, 'Origin not allowed')
        assert.equal(api.Calls, 0)
    })

    it('rejects a /tenant-api session whose tenant does not match the host tenant as 401', async () =>
    {
        const issued = await store.Issue('other', 'u1')
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.TenantApiHivesPath, {
            [Kit.HostHeader]: Kit.TenantHost,
            [Kit.CookieHeader]: Kit.PtsCookie('other', issued.id),
        })
        assert.equal(r.status, 401)
        assert.equal(api.Calls, 0)
    })

    it('serves the tenant bundle on a tenant host', async () =>
    {
        const r = await Kit.Raw(host, HttpMethod.Get, Kit.RootPath, { [Kit.HostHeader]: Kit.TenantHost })
        assert.equal(r.status, 200)
        assert.equal(r.body, TenantSentinel)
    })

    it('refuses traversal out of the tenant root', async () =>
    {
        const plain = await Kit.Raw(host, HttpMethod.Get, TraversalPath, { [Kit.HostHeader]: Kit.TenantHost })
        assert.equal(plain.status, 404)
        const encoded = await Kit.Raw(host, HttpMethod.Get, EncodedTraversalPath, { [Kit.HostHeader]: Kit.TenantHost })
        assert.equal(encoded.status, 404)
        assert.ok(!encoded.body.includes('secret'))
    })
})

describe('TenantPlaneHost streaming', () =>
{
    const TenantA = Kit.TenantId
    const OtherTenantHost = 'other.admin.example.com'
    const EnvA = 'env-a'
    const EnvB = 'env-b'
    const EventType = 'environment-changed'
    const CreatedEventType = 'environment-created'
    const DeletedEventType = 'environment-deleted'
    let parent: string
    let host: TenantPlaneHost
    let store: TenantSessionStore
    let service: FakeStreamingService
    let bus: TenantEventBus

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'tph-stream-'))
        store = new TenantSessionStore(join(parent, 'tenant-sessions.json'), 3600000)
        bus = new TenantEventBus()
        service = new FakeStreamingService([Kit.Record(EnvA, TenantA), Kit.Record(EnvB, 'other')])
        const plane: TenantPlane = {
            endpoint: new TenantAuthEndpoint(new CapturingRelyingParty(), store, false),
            gate: new TenantAuthGate(store),
            api: new StubTenantApi(),
            events: bus,
        }
        host = new TenantPlaneHost(plane, new TenantHostResolver(Kit.BaseDomain, Kit.Scheme, new StubDirectory([TenantA, 'other']) as unknown as PlatformDirectory), join(parent, 'tenant-static'), service as unknown as IEnvironmentService)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    function EventsUrl(): string
    {
        return `ws://127.0.0.1:${host.Address().port}/tenant-api/events`
    }

    function LogsUrl(env: string): string
    {
        return `ws://127.0.0.1:${host.Address().port}/tenant-api/environments/${env}/logs/stream`
    }

    it('delivers only the subscriber tenant own events (no cross-tenant leak)', async () =>
    {
        const issued = await store.Issue(TenantA, 'u1')
        const ws = new WebSocket(EventsUrl(), { headers: { [Kit.HostHeader]: Kit.TenantHost, [Kit.CookieHeader]: Kit.PtsCookie(TenantA, issued.id) } })
        assert.equal(await Kit.Opened(ws), true)
        const received: Array<{ type: string; environmentName: string }> = []
        ws.on('message', d => received.push(JSON.parse(d.toString())))
        service.FireChange(Kit.Record(EnvB, 'other'))
        service.FireChange(Kit.Record(EnvA, TenantA))
        for (let i = 0; i < 50 && received.length === 0; i++)
        {
            await Kit.Delay(10)
        }
        await Kit.Delay(50)
        assert.equal(received.length, 1)
        assert.deepEqual(received[0], { type: EventType, environmentName: EnvA })
        ws.close()
    })

    it('maps create and delete lifecycle changes to their own event types', async () =>
    {
        const issued = await store.Issue(TenantA, 'u1')
        const ws = new WebSocket(EventsUrl(), { headers: { [Kit.HostHeader]: Kit.TenantHost, [Kit.CookieHeader]: Kit.PtsCookie(TenantA, issued.id) } })
        assert.equal(await Kit.Opened(ws), true)
        const received: Array<{ type: string; environmentName: string }> = []
        ws.on('message', d => received.push(JSON.parse(d.toString())))
        service.FireChange(Kit.Record(EnvA, TenantA), EnvironmentChangeKind.Created)
        service.FireChange(Kit.Record(EnvA, TenantA), EnvironmentChangeKind.Deleted)
        for (let i = 0; i < 50 && received.length < 2; i++)
        {
            await Kit.Delay(10)
        }
        await Kit.Delay(50)
        assert.equal(received.length, 2)
        assert.deepEqual(received[0], { type: CreatedEventType, environmentName: EnvA })
        assert.deepEqual(received[1], { type: DeletedEventType, environmentName: EnvA })
        ws.close()
    })

    it('rejects an events socket with no pts_session cookie', async () =>
    {
        const ws = new WebSocket(EventsUrl(), { headers: { [Kit.HostHeader]: Kit.TenantHost } })
        assert.equal(await Kit.Opened(ws), false)
    })

    it('rejects an events socket on a foreign host', async () =>
    {
        const issued = await store.Issue(TenantA, 'u1')
        const ws = new WebSocket(EventsUrl(), { headers: { [Kit.HostHeader]: Kit.ForeignHost, [Kit.CookieHeader]: Kit.PtsCookie(TenantA, issued.id) } })
        assert.equal(await Kit.Opened(ws), false)
    })

    it('streams log chunks for an owned env and kills the process on close', async () =>
    {
        const issued = await store.Issue(TenantA, 'u1')
        const ws = new WebSocket(LogsUrl(EnvA), { headers: { [Kit.HostHeader]: Kit.TenantHost, [Kit.CookieHeader]: Kit.PtsCookie(TenantA, issued.id) } })
        assert.equal(await Kit.Opened(ws), true)
        for (let i = 0; i < 50 && service.LastLogProcess === undefined; i++)
        {
            await Kit.Delay(10)
        }
        const chunk = new Promise<string>(res => ws.once('message', d => res(d.toString())))
        service.LastLogProcess!.Push('log-chunk-1')
        assert.equal(await chunk, 'log-chunk-1')
        assert.deepEqual(service.LogStreamNames, [EnvA])
        const closed = new Promise<void>(res => ws.once('close', () => res()))
        ws.close()
        await closed
        for (let i = 0; i < 50 && !service.LastLogProcess!.Killed; i++)
        {
            await Kit.Delay(10)
        }
        assert.equal(service.LastLogProcess!.Killed, true)
    })

    it('rejects a logs socket for an env owned by another tenant and starts no stream', async () =>
    {
        const issued = await store.Issue(TenantA, 'u1')
        const ws = new WebSocket(LogsUrl(EnvB), { headers: { [Kit.HostHeader]: Kit.TenantHost, [Kit.CookieHeader]: Kit.PtsCookie(TenantA, issued.id) } })
        await new Promise<void>(res =>
        {
            let settled = false
            const done = (): void => { if (!settled) { settled = true; res() } }
            ws.once('close', done)
            ws.once('error', done)
            ws.once('open', () => setTimeout(done, 200))
        })
        assert.equal(service.LogStreamNames.includes(EnvB), false)
    })

    it('rejects a logs socket with no pts_session cookie', async () =>
    {
        const ws = new WebSocket(LogsUrl(EnvA), { headers: { [Kit.HostHeader]: Kit.TenantHost } })
        assert.equal(await Kit.Opened(ws), false)
        assert.equal(service.LogStreamNames.includes(EnvA), false)
    })

    it('destroys an upgrade on an unknown ws path', async () =>
    {
        const issued = await store.Issue(TenantA, 'u1')
        const ws = new WebSocket(`ws://127.0.0.1:${host.Address().port}/tenant-api/other`, { headers: { [Kit.HostHeader]: Kit.TenantHost, [Kit.CookieHeader]: Kit.PtsCookie(TenantA, issued.id) } })
        assert.equal(await Kit.Opened(ws), false)
    })

    it('refuses an events socket whose session tenant does not match the host tenant', async () =>
    {
        const issued = await store.Issue(TenantA, 'u1')
        // An acme session cookie presented on the 'other' tenant's host: host↔session mismatch, refused outright.
        const ws = new WebSocket(EventsUrl(), { headers: { [Kit.HostHeader]: OtherTenantHost, [Kit.CookieHeader]: Kit.PtsCookie(TenantA, issued.id) } })
        assert.equal(await Kit.Opened(ws), false)
    })

    it('destroys an operator-events ws upgrade on the tenant listener', async () =>
    {
        const issued = await store.Issue(TenantA, 'u1')
        const ws = new WebSocket(`ws://127.0.0.1:${host.Address().port}/api/events`, { headers: { [Kit.HostHeader]: Kit.TenantHost, [Kit.CookieHeader]: Kit.PtsCookie(TenantA, issued.id) } })
        assert.equal(await Kit.Opened(ws), false)
    })
})
