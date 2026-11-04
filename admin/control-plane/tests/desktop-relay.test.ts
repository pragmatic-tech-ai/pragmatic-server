import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { AppWriteStatus, PragmaticClient, type TokenIssuedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AuditRegistry, type AuditRecord } from '../audit-record.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvironmentUnreachableError, type EnvironmentEndpoints, type EnvironmentUrlsLease } from '../environment-endpoints.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { DesktopAuthGate } from '../tenant-auth/desktop-auth-gate.js'
import { DesktopRelay, WsUpstreamDialer, type IUpstreamDialer } from '../tenant-auth/desktop-relay.js'
import { DesktopTargets, type DesktopCapabilitiesSource } from '../tenant-auth/desktop-targets.js'
import { TenantSessionKind, TenantSessionStore } from '../tenant-auth/tenant-session.js'

/** A fake environment server: answers graph/list, graph/contribute, application/deploy and records what it saw. */
class FakeUpstream
{
    public static readonly FailingGraph = 'boom'
    public readonly methods: string[] = []
    public readonly bearers: string[] = []
    public readonly urls: string[] = []
    private readonly sockets = new Set<WebSocket>()
    private wss: WebSocketServer | undefined
    public closedByPeer = 0

    public async Start(): Promise<number>
    {
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
        this.wss = wss
        await new Promise<void>(res => wss.once('listening', () => res()))
        wss.on('connection', (ws, req) =>
        {
            this.sockets.add(ws)
            this.bearers.push(String(req.headers.authorization))
            this.urls.push(String(req.url))
            ws.on('close', () =>
            {
                this.sockets.delete(ws)
                this.closedByPeer++
            })
            ws.on('message', data => this.Answer(ws, JSON.parse(String(data)) as { id?: number; method: string; params?: Record<string, unknown> }))
        })
        return (wss.address() as AddressInfo).port
    }

    public CloseAll(): void
    {
        for (const ws of this.sockets)
        {
            ws.close(1000)
        }
    }

    public async Stop(): Promise<void>
    {
        for (const ws of this.sockets)
        {
            ws.terminate()
        }
        await new Promise<void>(res => this.wss?.close(() => res()) ?? res())
    }

    public Connections(): number
    {
        return this.urls.length
    }

    private Answer(ws: WebSocket, msg: { id?: number; method: string; params?: Record<string, unknown> }): void
    {
        this.methods.push(msg.method)
        if (msg.id === undefined)
        {
            return
        }
        const params = msg.params ?? {}
        let reply: Record<string, unknown>
        if (msg.method === 'graph/contribute' && params.graphName === FakeUpstream.FailingGraph)
        {
            reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'contribute failed' } }
        }
        else if (msg.method === 'graph/contribute')
        {
            reply = { jsonrpc: '2.0', id: msg.id, result: { name: params.graphName, description: '', packages: [] } }
        }
        else if (msg.method === 'application/deploy')
        {
            reply = { jsonrpc: '2.0', id: msg.id, result: { status: AppWriteStatus.Applied, appName: params.appName, appVersion: params.appVersion } }
        }
        else
        {
            reply = { jsonrpc: '2.0', id: msg.id, result: [] }
        }
        ws.send(JSON.stringify(reply))
    }
}

/** IEnvironmentService fake: the env list plus the two credential mints (which can be made to fail). */
class RelayService
{
    public failMint = false
    public mints: string[] = []

    public constructor(private readonly records: readonly EnvironmentRecord[])
    {
    }

    public async ListReconciled(): Promise<readonly EnvironmentRecord[]>
    {
        return this.records
    }

    public async AdminIssueMakerToken(name: string): Promise<TokenIssuedDto>
    {
        return this.Mint(name, RelayKit.MakerToken)
    }

    public async AdminIssueDeployToken(name: string): Promise<TokenIssuedDto>
    {
        return this.Mint(name, RelayKit.DeployToken)
    }

    private Mint(name: string, token: string): TokenIssuedDto
    {
        this.mints.push(name)
        if (this.failMint)
        {
            throw new Error('mint failed')
        }
        return { tokenRef: 'ref', token, principalId: 'maker', scopes: [], expiresAt: null }
    }
}

/** EnvironmentEndpoints fake: hands out the fake upstream's URL and counts leases and releases. */
class RelayEndpoints
{
    public leases = 0
    public releases = 0
    public unreachable = false

    public constructor(public port: number)
    {
    }

    public async UrlsFor(): Promise<EnvironmentUrlsLease>
    {
        if (this.unreachable)
        {
            throw new EnvironmentUnreachableError()
        }
        this.leases++
        return { httpUrl: 'http://127.0.0.1:' + String(this.port), wsUrl: 'ws://127.0.0.1:' + String(this.port), Release: () => { this.releases++ } }
    }
}

class CountingDialer implements IUpstreamDialer
{
    public dials = 0
    private readonly inner = new WsUpstreamDialer()

    public Dial(url: string, bearer: string): Promise<WebSocket>
    {
        this.dials++
        return this.inner.Dial(url, bearer)
    }
}

class RelayDirectory implements ITenantDirectory
{
    public GetTenant(id: string): TenantRecord | undefined
    {
        return { id, clientId: 'c1', displayName: id, createdAt: '2026-01-01T00:00:00.000Z', ownerPrincipalId: RelayKit.Principal }
    }

    public GetHive(): HiveRecord | undefined
    {
        return undefined
    }

    public ListHives(): readonly HiveRecord[]
    {
        return []
    }
}

/** One relay under test: a real session store + audit file, the relay mounted on a bare http server's upgrade. */
class RelayKit
{
    public static readonly TenantId = 'acme'
    public static readonly OtherTenant = 'globex'
    public static readonly Principal = 'user-1'
    public static readonly Email = 'ann@acme.test'
    public static readonly Dev = 'acme-dev'
    public static readonly DevId = 'env-acme-dev-id'
    public static readonly DevStopped = 'acme-dev-stopped'
    public static readonly Run = 'acme-run'
    public static readonly RunId = 'env-acme-run-id'
    public static readonly ForeignDev = 'globex-dev'
    public static readonly MakerToken = 'minted-maker-credential'
    public static readonly DeployToken = 'minted-deploy-credential'
    public static readonly Graph = 'payments'
    public static readonly NotAvailable = 'This method is not available through the desktop relay.'

    public dir = ''
    public store!: TenantSessionStore
    public audit!: AuditRegistry
    public service!: RelayService
    public endpoints!: RelayEndpoints
    public dialer!: CountingDialer
    public relay!: DesktopRelay
    public upstream!: FakeUpstream
    public desktopToken = ''
    public consoleToken = ''
    private server: Server | undefined
    private port = 0

    public async Start(capabilities?: DesktopCapabilitiesSource): Promise<void>
    {
        this.dir = await mkdtemp(join(tmpdir(), 'desktop-relay-'))
        this.store = new TenantSessionStore(join(this.dir, 'sessions.json'), 60000)
        this.audit = new AuditRegistry(join(this.dir, 'tenant-desktop-audit.json'))
        await this.audit.Load()
        this.upstream = new FakeUpstream()
        const upstreamPort = await this.upstream.Start()
        this.service = new RelayService([
            RelayKit.Record(RelayKit.Dev, RelayKit.DevId, RelayKit.TenantId, EnvType.Development, EnvStatus.Running),
            RelayKit.Record(RelayKit.DevStopped, 'env-stopped', RelayKit.TenantId, EnvType.Development, EnvStatus.Stopped),
            RelayKit.Record(RelayKit.Run, RelayKit.RunId, RelayKit.TenantId, EnvType.Runtime, EnvStatus.Running),
            RelayKit.Record(RelayKit.ForeignDev, 'env-foreign', RelayKit.OtherTenant, EnvType.Development, EnvStatus.Running),
        ])
        this.endpoints = new RelayEndpoints(upstreamPort)
        this.dialer = new CountingDialer()
        const service = this.service as unknown as IEnvironmentService
        this.relay = new DesktopRelay(new DesktopAuthGate(this.store), new DesktopTargets(service, new RelayDirectory(), capabilities), service,
            this.endpoints as unknown as EnvironmentEndpoints, this.audit, this.dialer)
        this.desktopToken = (await this.store.Issue(RelayKit.TenantId, RelayKit.Principal, RelayKit.Email, TenantSessionKind.Desktop)).id
        this.consoleToken = (await this.store.Issue(RelayKit.TenantId, RelayKit.Principal, RelayKit.Email)).id
        const server = createServer((_req, res) => { res.statusCode = 404; res.end() })
        server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => void this.relay.Upgrade(req, socket, head))
        this.server = server
        await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()))
        this.port = (server.address() as AddressInfo).port
    }

    public async Stop(): Promise<void>
    {
        this.relay.Close()
        await this.upstream.Stop()
        const server = this.server
        if (server !== undefined)
        {
            server.closeAllConnections()
            await new Promise<void>(res => server.close(() => res()))
        }
        // Audit appends run after the answer is written; let the last ones land before removing their directory.
        await new Promise(res => setTimeout(res, 50))
        await rm(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    }

    public Url(env: string, action: string): string
    {
        return 'ws://127.0.0.1:' + String(this.port) + '/desktop/relay?environment=' + encodeURIComponent(env) + '&action=' + encodeURIComponent(action)
    }

    /** Dials the relay raw; resolves the refusal status, or 101 with the open socket. */
    public Dial(env: string, action: string, bearer?: string, origin?: string): Promise<{ status: number; ws?: WebSocket }>
    {
        const headers: Record<string, string> = bearer === undefined ? {} : { Authorization: 'Bearer ' + bearer }
        const ws = new WebSocket(this.Url(env, action), origin === undefined ? { headers } : { headers, origin })
        return new Promise(res =>
        {
            ws.once('unexpected-response', (_req, response) =>
            {
                res({ status: response.statusCode ?? 0 })
                ws.terminate()
            })
            ws.once('open', () => res({ status: 101, ws }))
            ws.once('error', () => res({ status: -1 }))
        })
    }

    public Client(env: string, action: string): Promise<PragmaticClient>
    {
        return PragmaticClient.ConnectAsync(this.Url(env, action), { bearerToken: this.desktopToken })
    }

    public Audit(): AuditRecord[]
    {
        return [...this.audit.List()].sort((a, b) => a.at.localeCompare(b.at))
    }

    public static Record(name: string, environmentId: string, tenantId: string, type: EnvType, status: EnvStatus): EnvironmentRecord
    {
        const template = type === EnvType.Development ? Template.DevBlank : Template.RuntimePostgres
        return { name, type, template, environmentId, tenantId, createdAt: '2026-10-23T00:00:00.000Z', status }
    }

    public static Request(id: number, method: string, params: unknown = {}): string
    {
        return JSON.stringify({ jsonrpc: '2.0', id, method, params })
    }

    public static Next(ws: WebSocket): Promise<Record<string, unknown>>
    {
        return new Promise(res => ws.once('message', data => res(JSON.parse(String(data)) as Record<string, unknown>)))
    }

    public static Closed(ws: WebSocket): Promise<number>
    {
        return new Promise(res => ws.once('close', code => res(code)))
    }

    public static async Until(check: () => boolean): Promise<void>
    {
        for (let i = 0; i < 200 && !check(); i++)
        {
            await new Promise(res => setTimeout(res, 10))
        }
        assert.ok(check(), 'condition not reached')
    }

    public static Contribute(graphName: string): { graphName: string; solutionId: string; packages: [] }
    {
        return { graphName, solutionId: 'sol-1', packages: [] }
    }

    public static Deploy(): { appName: string; appVersion: string; packages: []; uiBundle: []; manifest: { name: string; version: string; packages: []; ui: { entry: string; assets: [] } } }
    {
        return { appName: 'shop', appVersion: '1.0.0', packages: [], uiBundle: [], manifest: { name: 'shop', version: '1.0.0', packages: [], ui: { entry: 'index.html', assets: [] } } }
    }
}

describe('DesktopRelay refusals', () =>
{
    let kit: RelayKit

    beforeEach(async () =>
    {
        kit = new RelayKit()
        await kit.Start()
    })

    afterEach(async () =>
    {
        await kit.Stop()
    })

    it('401 without a bearer, or with a console (non-desktop) token; no upstream dial', async () =>
    {
        assert.equal((await kit.Dial(RelayKit.Dev, 'contribute')).status, 401)
        assert.equal((await kit.Dial(RelayKit.Dev, 'contribute', kit.consoleToken)).status, 401)
        assert.equal((await kit.Dial(RelayKit.Dev, 'contribute', 'not-a-token')).status, 401)
        assert.equal(kit.dialer.dials, 0)
        assert.equal(kit.endpoints.leases, 0)
        const audit = kit.Audit()
        assert.equal(audit.length, 3)
        assert.ok(audit.every(r => r.status === 401 && r.actor === AuditRegistry.AnonymousActor))
        assert.ok(audit.every(r => !JSON.stringify(r).includes(kit.consoleToken)))
    })

    it('403 for any upgrade carrying an Origin header, even with a valid desktop bearer', async () =>
    {
        assert.equal((await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken, 'http://evil.test')).status, 403)
        assert.equal(kit.dialer.dials, 0)
        assert.equal(kit.service.mints.length, 0)
        assert.equal(kit.Audit()[0]?.status, 403)
        assert.equal(kit.Audit()[0]?.actor, AuditRegistry.AnonymousActor)
    })

    it('400 for an unknown action or a missing environment', async () =>
    {
        assert.equal((await kit.Dial(RelayKit.Dev, 'delete', kit.desktopToken)).status, 400)
        assert.equal((await kit.Dial('', 'contribute', kit.desktopToken)).status, 400)
        assert.equal(kit.dialer.dials, 0)
        assert.equal(kit.Audit()[0]?.status, 400)
        assert.equal(kit.Audit()[0]?.actor, RelayKit.TenantId + '/' + RelayKit.Email)
    })

    it('403 for a wrong-type, foreign or unknown env, and for a role without the environments capability', async () =>
    {
        assert.equal((await kit.Dial(RelayKit.Dev, 'publish', kit.desktopToken)).status, 403)
        assert.equal((await kit.Dial(RelayKit.Run, 'contribute', kit.desktopToken)).status, 403)
        assert.equal((await kit.Dial(RelayKit.ForeignDev, 'contribute', kit.desktopToken)).status, 403)
        assert.equal((await kit.Dial('missing', 'contribute', kit.desktopToken)).status, 403)
        assert.equal(kit.dialer.dials, 0)
        assert.equal(kit.service.mints.length, 0)
        const last = kit.Audit().at(-1)
        assert.equal(last?.status, 403)
        assert.equal(last?.method, 'contribute')
        assert.equal(last?.path, 'missing')
    })

    it('409 for an eligible env that is not running', async () =>
    {
        assert.equal((await kit.Dial(RelayKit.DevStopped, 'contribute', kit.desktopToken)).status, 409)
        assert.equal(kit.dialer.dials, 0)
        assert.equal(kit.Audit()[0]?.status, 409)
    })

    it('502 when the credential cannot be minted; the lease is released and nothing is dialed', async () =>
    {
        kit.service.failMint = true
        assert.equal((await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken)).status, 502)
        assert.equal(kit.dialer.dials, 0)
        assert.equal(kit.endpoints.releases, kit.endpoints.leases)
        assert.equal(kit.Audit()[0]?.status, 502)
    })

    it('502 when the environment is unreachable or the upstream refuses the dial; the lease is released', async () =>
    {
        kit.endpoints.unreachable = true
        assert.equal((await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken)).status, 502)
        kit.endpoints.unreachable = false
        await kit.upstream.Stop()
        assert.equal((await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken)).status, 502)
        assert.equal(kit.endpoints.leases, 1)
        assert.equal(kit.endpoints.releases, 1)
        assert.equal(kit.Audit().filter(r => r.status === 502).length, 2)
    })
})

describe('DesktopRelay contribute', () =>
{
    let kit: RelayKit

    beforeEach(async () =>
    {
        kit = new RelayKit()
        await kit.Start()
    })

    afterEach(async () =>
    {
        await kit.Stop()
    })

    it('forwards graph/list and graph/contribute with the minted maker credential and audits the contribute', async () =>
    {
        const client = await kit.Client(RelayKit.Dev, 'contribute')
        assert.deepEqual(await client.ListGraphs(), [])
        const detail = await client.ContributeGraph(RelayKit.Contribute(RelayKit.Graph) as never)
        assert.equal(detail.name, RelayKit.Graph)
        await client.DisposeAsync()
        assert.deepEqual(kit.upstream.methods, ['graph/list', 'graph/contribute'])
        assert.deepEqual(kit.upstream.bearers, ['Bearer ' + RelayKit.MakerToken])
        assert.ok(kit.upstream.urls[0]?.includes('environment=' + RelayKit.DevId))
        assert.ok(!kit.upstream.bearers.some(b => b.includes(kit.desktopToken)))
        await RelayKit.Until(() => kit.Audit().length === 1)
        const rec = kit.Audit()[0] as AuditRecord
        assert.equal(rec.actor, RelayKit.TenantId + '/' + RelayKit.Email)
        assert.equal(rec.method, 'contribute')
        assert.equal(rec.path, RelayKit.Dev)
        assert.equal(rec.status, 200)
        assert.equal(rec.note, RelayKit.Graph)
        assert.ok(!JSON.stringify(kit.Audit()).includes(RelayKit.MakerToken))
    })

    it('audits a contribute that fails with a JSON-RPC error as 500', async () =>
    {
        const client = await kit.Client(RelayKit.Dev, 'contribute')
        await assert.rejects(client.ContributeGraph(RelayKit.Contribute(FakeUpstream.FailingGraph) as never))
        await client.DisposeAsync()
        await RelayKit.Until(() => kit.Audit().length === 1)
        assert.equal(kit.Audit()[0]?.status, 500)
        assert.equal(kit.Audit()[0]?.note, FakeUpstream.FailingGraph)
    })

    it('answers graph/delete with -32601 and never forwards it', async () =>
    {
        const client = await kit.Client(RelayKit.Dev, 'contribute')
        await assert.rejects(client.DeleteGraph({ graphName: RelayKit.Graph } as never), (err: { code?: number; message?: string }) =>
            err.code === -32601 && err.message === RelayKit.NotAvailable)
        assert.deepEqual(await client.ListGraphs(), [])
        await client.DisposeAsync()
        assert.deepEqual(kit.upstream.methods, ['graph/list'])
    })

    it('drops a non-allowlisted notification and forwards an allowlisted request after it', async () =>
    {
        const { ws } = await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken)
        ws?.send(JSON.stringify({ jsonrpc: '2.0', method: 'graph/delete', params: {} }))
        ws?.send(RelayKit.Request(1, 'graph/list'))
        assert.deepEqual((await RelayKit.Next(ws as WebSocket)).result, [])
        assert.deepEqual(kit.upstream.methods, ['graph/list'])
        ws?.close()
    })

    it('closes the relay with 1008 on a non-JSON frame and on a batch', async () =>
    {
        const first = (await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken)).ws as WebSocket
        const firstClosed = RelayKit.Closed(first)
        first.send('not json')
        assert.equal(await firstClosed, 1008)
        const second = (await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken)).ws as WebSocket
        const secondClosed = RelayKit.Closed(second)
        second.send(JSON.stringify([JSON.parse(RelayKit.Request(1, 'graph/list'))]))
        assert.equal(await secondClosed, 1008)
        assert.deepEqual(kit.upstream.methods, [])
        await RelayKit.Until(() => kit.endpoints.releases === 2)
    })

    it('closing the upstream closes the client and releases the lease exactly once', async () =>
    {
        const { ws } = await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken)
        const closed = RelayKit.Closed(ws as WebSocket)
        await RelayKit.Until(() => kit.upstream.Connections() === 1)
        kit.upstream.CloseAll()
        await closed
        await RelayKit.Until(() => kit.endpoints.releases === 1)
        await new Promise(res => setTimeout(res, 30))
        assert.equal(kit.endpoints.releases, 1)
    })

    it('closing the client closes the upstream and releases the lease', async () =>
    {
        const { ws } = await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken)
        await RelayKit.Until(() => kit.upstream.Connections() === 1)
        ws?.close()
        await RelayKit.Until(() => kit.upstream.closedByPeer === 1 && kit.endpoints.releases === 1)
    })

    it('a password change (ClosePrincipal) ends the principal\'s relays', async () =>
    {
        const { ws } = await kit.Dial(RelayKit.Dev, 'contribute', kit.desktopToken)
        const closed = RelayKit.Closed(ws as WebSocket)
        assert.equal(kit.relay.ClosePrincipal(RelayKit.TenantId, RelayKit.Principal), 1)
        await closed
        await RelayKit.Until(() => kit.endpoints.releases === 1)
    })
})

describe('DesktopRelay publish', () =>
{
    let kit: RelayKit

    beforeEach(async () =>
    {
        kit = new RelayKit()
        await kit.Start()
    })

    afterEach(async () =>
    {
        await kit.Stop()
    })

    it('forwards application/deploy with the deploy credential, refuses graph/contribute, and audits the deploy', async () =>
    {
        const client = await kit.Client(RelayKit.Run, 'publish')
        await assert.rejects(client.ContributeGraph(RelayKit.Contribute(RelayKit.Graph) as never), (err: { code?: number }) => err.code === -32601)
        const result = await client.DeployApplication(RelayKit.Deploy() as never)
        assert.equal(result.status, AppWriteStatus.Applied)
        await client.DisposeAsync()
        assert.deepEqual(kit.upstream.methods, ['application/deploy'])
        assert.deepEqual(kit.upstream.bearers, ['Bearer ' + RelayKit.DeployToken])
        assert.ok(kit.upstream.urls[0]?.includes('environment=' + RelayKit.RunId))
        await RelayKit.Until(() => kit.Audit().length === 1)
        const rec = kit.Audit()[0] as AuditRecord
        assert.equal(rec.method, 'publish')
        assert.equal(rec.path, RelayKit.Run)
        assert.equal(rec.status, 200)
        assert.equal(rec.note, 'shop')
    })
})
