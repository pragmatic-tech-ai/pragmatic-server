import type { ILogProcess } from '../../../environments/seed/docker.js'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { ControlPlaneHost, type GraphDto, type IEnvironmentService, type IGraphService, type PromotionResultDto } from '../control-plane-host.js'
import { RolloutFixture } from './rollout-fixture.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { CreateFailedError, DockerUnavailableError, EnvironmentExistsError, EnvironmentNotFoundError, ImageMissingError } from '../environment-service.js'
import { PortUnavailableError } from '../port-allocator.js'
import { InvalidEnvironmentNameError } from '../template-catalog.js'
import { WebSocket } from 'ws'
import { AdminProxyError, AdminProxyErrorKind, type AdminSnapshot } from '../admin-proxy.js'
import type { CreateAccountParams, GrantMutationDto, IdentityConfigDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EnvironmentChangeKind, EnvStatus, EnvType, Template, type EnvironmentChange, type EnvironmentRecord } from '../environment-record.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'

import { EnvironmentNotDevelopmentError, EnvironmentNotRuntimeError } from '../environment-service.js'
import { GraphExistsError, GraphNotFoundError } from '../graph-service.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSession } from '../operator-identity.js'
import { EventsTicketStore } from '../events-ticket-store.js'
import { OperatorSocketRegistry } from '../operator-socket-registry.js'
import { LoginThrottle } from '../login-throttle.js'

type Reply = { status: number; body: string; setCookie?: string[] | undefined }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Email = 'op@example.com'
    public static readonly Password = 'correct-horse'
    public static readonly Token = 'valid-token'
    public Revoked: string[] = []
    public readonly Extra = new Set<string>()
    public readonly Dead = new Set<string>()
    public readonly Throwing = new Set<string>()
    public ValidateCalls = 0
    public HoldCall = -1
    public Release: (() => void) | undefined

    public async Authenticate(email: string, password: string): Promise<OperatorSession | null>
    {
        if (email === FakeOperator.Email && password === FakeOperator.Password)
        {
            return { token: FakeOperator.Token, expiresAt: new Date(Date.now() + 3600000) }
        }
        return null
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        this.ValidateCalls++
        if (this.ValidateCalls === this.HoldCall)
        {
            await new Promise<void>(res => { this.Release = res })
        }
        if (this.Throwing.has(token))
        {
            throw new Error('validator down')
        }
        const known = token === FakeOperator.Token || this.Extra.has(token)
        return known && !this.Dead.has(token) ? { email: FakeOperator.Email, principalId: 'p1', role: OperatorRole.Full } : null
    }

    public async CreateOperator(_email: string, _password: string, _role: OperatorRole): Promise<void>
    {
    }

    public async Revoke(token: string): Promise<void>
    {
        this.Revoked.push(token)
    }
}

class FakeService implements IEnvironmentService
{
    public Calls: string[] = []
    public Throw: Error | undefined
    public Record: EnvironmentRecord = {
        name: 'x',
        template: Template.DevBlank,
        type: EnvType.Development,
        environmentId: 'dev',
        hostPort: 8101,
        containerName: 'ctr-secret-name',
        volumeName: 'vol-secret-name',
        bundleDir: '/secret/bundle',
        createdAt: '2026-10-16T00:00:00.000Z',
        status: EnvStatus.Running
    }

    public async Create(name: string, template: Template, type: EnvType, hostPort?: number, hiveId?: string): Promise<EnvironmentRecord>
    {
        this.Calls.push(`create:${name}:${template}:${type}:${String(hostPort)}` + (hiveId === undefined ? '' : `:${hiveId}`))
        this.MaybeThrow()
        const bound = hiveId === undefined ? {} : { hiveId, tenantId: 'plat-t1' }
        return { ...this.Record, name, template, type, ...bound }
    }

    public async Start(name: string): Promise<EnvironmentRecord>
    {
        this.Calls.push(`start:${name}`)
        this.MaybeThrow()
        return { ...this.Record, name }
    }

    public async Stop(name: string): Promise<EnvironmentRecord>
    {
        this.Calls.push(`stop:${name}`)
        this.MaybeThrow()
        return { ...this.Record, name, status: EnvStatus.Stopped }
    }

    public async Restart(name: string): Promise<EnvironmentRecord>
    {
        this.Calls.push(`restart:${name}`)
        this.MaybeThrow()
        return { ...this.Record, name }
    }

    public async Delete(name: string): Promise<void>
    {
        this.Calls.push(`delete:${name}`)
        this.MaybeThrow()
    }

    public List(): readonly EnvironmentRecord[]
    {
        return [this.Record]
    }

    public async ListReconciled(): Promise<readonly EnvironmentRecord[]>
    {
        this.MaybeThrow()
        return this.List()
    }

    public LogStream(): ILogProcess
    {
        return { OnData() {}, OnClose() {}, Kill() {} }
    }

    private readonly listeners = new Set<(change: EnvironmentChange) => void>()

    public get ListenerCount(): number
    {
        return this.listeners.size
    }

    public OnChanged(cb: (change: EnvironmentChange) => void): () => void
    {
        this.listeners.add(cb)
        return () => { this.listeners.delete(cb) }
    }

    public EmitChange(): void
    {
        for (const l of [...this.listeners])
        {
            l({ kind: EnvironmentChangeKind.Created, record: this.Record })
        }
    }

    public async Logs(name: string): Promise<string>
    {
        this.Calls.push(`logs:${name}`)
        return 'log-line'
    }

    public async AdminSnapshot(name: string): Promise<AdminSnapshot>
    {
        this.Calls.push(`adminSnapshot:${name}`)
        this.MaybeThrow()
        return { accounts: [], grants: [], config: {} as IdentityConfigDto }
    }

    public async AdminCreateAccount(name: string, params: CreateAccountParams): Promise<void>
    {
        this.Calls.push(`adminCreateAccount:${name}:${JSON.stringify(params)}`)
        this.MaybeThrow()
    }

    public async AdminDisableAccount(name: string, principalId: string): Promise<void>
    {
        this.Calls.push(`adminDisableAccount:${name}:${principalId}`)
        this.MaybeThrow()
    }

    public async AdminListTokens(name: string): Promise<any>
    {
        this.Calls.push(`adminListTokens:${name}`)
        return []
    }

    public async AdminIssueToken(name: string, _params: any): Promise<any>
    {
        this.Calls.push(`adminIssueToken:${name}`)
        throw new Error('unused')
    }

    public async AdminRevokeToken(name: string, _tokenRef: string): Promise<void>
    {
        this.Calls.push(`adminRevokeToken:${name}`)
    }

    public async AdminIssueMakerToken(name: string): Promise<any>
    {
        this.Calls.push(`adminIssueMakerToken:${name}`)
        this.MaybeThrow()
        return { token: 'SECRET-MAKER-TOKEN-123', tokenRef: 'ref-1', principalId: 'maker-1', scopes: ['graph:write'], expiresAt: '2027-01-01T00:00:00.000Z' }
    }

    public async AdminGrantRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        this.Calls.push(`adminGrantRole:${name}:${JSON.stringify(mutation)}`)
        this.MaybeThrow()
    }

    public async AdminGrantAppReader(name: string): Promise<void>
    {
        this.Calls.push(`adminGrantAppReader:${name}`)
        this.MaybeThrow()
    }

    public async AdminRevokeRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        this.Calls.push(`adminRevokeRole:${name}:${JSON.stringify(mutation)}`)
        this.MaybeThrow()
    }

    public async AdminGetConfig(name: string): Promise<IdentityConfigDto>
    {
        this.Calls.push(`adminGetConfig:${name}`)
        this.MaybeThrow()
        return {} as IdentityConfigDto
    }

    public async AdminGetSecurityModel(name: string): Promise<any>
    {
        this.Calls.push(`adminGetSecurityModel:${name}`)
        this.MaybeThrow()
        return undefined
    }

    public async AdminSetSecurityModel(name: string, model: any): Promise<void>
    {
        this.Calls.push(`adminSetSecurityModel:${name}:${JSON.stringify(model)}`)
        this.MaybeThrow()
    }

    public async AdminSetConfig(name: string, config: IdentityConfigDto): Promise<void>
    {
        this.Calls.push(`adminSetConfig:${name}:${JSON.stringify(config)}`)
        this.MaybeThrow()
    }

    private MaybeThrow(): void
    {
        if (this.Throw !== undefined)
        {
            throw this.Throw
        }
    }
}

class FakeGraphService implements IGraphService
{
    public Throw: Error | undefined
    public Calls: string[] = []
    public Seed: GraphDto[] = []
    public Loaded: GraphLoadedDto | null = { name: 'g1', packages: [{ id: 'p', version: '1' }], promotedAt: '2026-10-20T01:00:00.000Z' }

    public async Create(envName: string, name: string, description: string): Promise<GraphDto>
    {
        this.Calls.push(`create:${envName}:${name}`)
        this.MaybeThrow()
        return { name, description, packageCount: 0, createdAt: '2026-10-20T00:00:00.000Z' }
    }

    public async List(envName: string): Promise<readonly GraphDto[]>
    {
        this.Calls.push(`list:${envName}`)
        this.MaybeThrow()
        return this.Seed
    }

    public async Get(envName: string, graphName: string): Promise<GraphDto>
    {
        this.Calls.push(`get:${envName}:${graphName}`)
        this.MaybeThrow()
        const found = this.Seed.find(r => r.name === graphName)
        if (found === undefined)
        {
            throw new GraphNotFoundError(graphName)
        }
        return found
    }

    public async Delete(envName: string, graphName: string): Promise<void>
    {
        this.Calls.push(`delete:${envName}:${graphName}`)
        this.MaybeThrow()
    }

    public async Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
    {
        this.Calls.push(`promote:${sourceEnv}:${graphName}:${targetEnv}`)
        this.MaybeThrow()
        return { graphName, packageCount: 2, targetEnv }
    }

    public async GetLoaded(runtimeEnv: string): Promise<GraphLoadedDto | null>
    {
        this.Calls.push(`getLoaded:${runtimeEnv}`)
        this.MaybeThrow()
        return this.Loaded
    }

    private MaybeThrow(): void
    {
        if (this.Throw !== undefined)
        {
            throw this.Throw
        }
    }
}

class Harness
{
    public static readonly DtoKeys = ['createdAt', 'environmentId', 'hostPort', 'httpUrl', 'name', 'status', 'template', 'type', 'wsUrl']
    public static readonly GraphDtoKeys = ['createdAt', 'description', 'name', 'packageCount']
    public static readonly Forbidden = ['bundleDir', 'containerName', 'volumeName', 'master', 'secret', 'password', 'ctr-secret-name', 'vol-secret-name', '/secret/bundle']

    public static readonly AuthCookie = 'cp_session=valid-token'
    private static readonly PollMs = 10
    private static readonly SettleMs = 100
    private static readonly PollLimit = 300

    public static async Ticket(host: ControlPlaneHost): Promise<string>
    {
        const r = await Harness.Send(host, 'GET', '/api/events-ticket')
        assert.equal(r.status, 200)
        return (JSON.parse(r.body) as { ticket: string }).ticket
    }

    public static async TicketFor(host: ControlPlaneHost, token: string): Promise<string>
    {
        const r = await Harness.Anon(host, 'GET', '/api/events-ticket', undefined, { cookie: `cp_session=${token}` })
        assert.equal(r.status, 200)
        return (JSON.parse(r.body) as { ticket: string }).ticket
    }

    public static async OpenAs(host: ControlPlaneHost, token: string): Promise<WebSocket>
    {
        const ws = new WebSocket(`ws://127.0.0.1:${host.Address().port}/api/events`, [await Harness.TicketFor(host, token)])
        await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
        return ws
    }

    public static async OpenEvents(host: ControlPlaneHost, headers: Record<string, string> = {}): Promise<WebSocket>
    {
        const ws = new WebSocket(`ws://127.0.0.1:${host.Address().port}/api/events`, [await Harness.Ticket(host)], { headers })
        await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
        return ws
    }

    public static async WaitFor(done: () => boolean): Promise<void>
    {
        for (let i = 0; i < Harness.PollLimit && !done(); i++)
        {
            await Harness.Settle(Harness.PollMs)
        }
    }

    public static Settle(ms: number = Harness.SettleMs): Promise<void>
    {
        return new Promise(res => setTimeout(res, ms))
    }

    public static Send(host: ControlPlaneHost, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Reply>
    {
        return Harness.Raw(host, method, path, body, { 'content-type': 'application/json', cookie: Harness.AuthCookie, ...headers })
    }

    public static Anon(host: ControlPlaneHost, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Reply>
    {
        return Harness.Raw(host, method, path, body, { 'content-type': 'application/json', ...headers })
    }

    public static Raw(host: ControlPlaneHost, method: string, path: string, body: string | undefined, headers: Record<string, string>): Promise<Reply>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const sized = body === undefined ? headers : { 'content-length': String(Buffer.byteLength(body)), ...headers }
            const req = request({ host: addr.address, port: addr.port, method, path, headers: sized }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), setCookie: res.headers['set-cookie'] }))
            })
            req.on('error', reject)
            req.end(body)
        })
    }
}

describe('ControlPlaneHost', () =>
{
    let fake: FakeService
    let fakeGraph: FakeGraphService
    let operator: FakeOperator
    let host: ControlPlaneHost
    let root: string
    let parent: string

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-parent-'))
        writeFileSync(join(parent, 'sentinel.txt'), 'SENTINEL')
        root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        mkdirSync(join(root, 'assets'))
        writeFileSync(join(root, 'assets', 'app.js'), 'var a=1')
        fake = new FakeService()
        fakeGraph = new FakeGraphService()
        operator = new FakeOperator()
        const directory = new PlatformDirectory(new ClientRegistry(join(parent, 'clients.json')), new TenantRegistry(join(parent, 'tenants.json')), new HiveRegistry(join(parent, 'hives.json')), { List: () => [] })
        const factory = new HiveOrchestratorFactory()
        host = new ControlPlaneHost(fake, fakeGraph, root, operator, false, directory, await RolloutFixture.Create(parent, directory, factory), new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent))
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('lists environments as the connect-info DTO', async () =>
    {
        const r = await Harness.Send(host, 'GET', '/api/environments')
        assert.equal(r.status, 200)
        const arr = JSON.parse(r.body)
        assert.equal(arr.length, 1)
        assert.deepEqual(Object.keys(arr[0]).sort(), Harness.DtoKeys)
        assert.equal(arr[0].httpUrl, 'http://localhost:8101')
        assert.equal(arr[0].wsUrl, 'ws://localhost:8101/?environment=dev')
    })

    it('no longer serves the environment lifecycle routes (the tenant plane owns them)', async () =>
    {
        const create = JSON.stringify({ name: 'e1', template: 'dev-blank', type: 'development' })
        assert.equal((await Harness.Send(host, 'POST', '/api/environments', create)).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/start')).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/stop')).status, 404)
        assert.equal((await Harness.Send(host, 'GET', '/api/environments/x/logs')).status, 404)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/environments/x')).status, 404)
        assert.equal(fake.Calls.length, 0)
    })

    it('maps service errors on an operator route', async () =>
    {
        const path = '/api/environments'
        fake.Throw = new EnvironmentNotFoundError('x')
        assert.equal((await Harness.Send(host, 'GET', path)).status, 404)

        fake.Throw = new ImageMissingError('docker build -t foo .')
        const img = await Harness.Send(host, 'GET', path)
        assert.equal(img.status, 409)
        assert.equal(JSON.parse(img.body).buildCommand, 'docker build -t foo .')

        fake.Throw = new DockerUnavailableError()
        const dk = await Harness.Send(host, 'GET', path)
        assert.equal(dk.status, 503)
        assert.match(JSON.parse(dk.body).error, /Start Docker/)

        fake.Throw = new CreateFailedError('boom')
        assert.equal((await Harness.Send(host, 'GET', path)).status, 500)
        fake.Throw = new Error('weird')
        const gen = await Harness.Send(host, 'GET', path)
        assert.equal(gen.status, 500)
        assert.ok(!gen.body.includes('weird'))
    })

    it('list DTO carries type', async () =>
    {
        const list = await Harness.Send(host, 'GET', '/api/environments')
        assert.equal(JSON.parse(list.body)[0].type, 'development')
    })

    it('no longer recognises the retired hive agent routes (session gate applies, then 404)', async () =>
    {
        const target = '/api/hives/h1/agent/target'
        assert.equal((await Harness.Anon(host, 'GET', target, undefined, { authorization: 'Bearer anything' })).status, 401)
        assert.equal((await Harness.Send(host, 'GET', target)).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/h1/agent/report', JSON.stringify({ ready: true }))).status, 404)
    })

    it('never leaks secret or internal fields', async () =>
    {
        const list = await Harness.Send(host, 'GET', '/api/environments')
        assert.deepEqual(Object.keys(JSON.parse(list.body)[0]).sort(), Harness.DtoKeys)
        for (const f of Harness.Forbidden)
        {
            assert.ok(!list.body.includes(f), `body leaked ${f}`)
        }
    })

    it('serves static files, 404s misses and traversal', async () =>
    {
        const idx = await Harness.Send(host, 'GET', '/')
        assert.equal(idx.status, 200)
        assert.equal(idx.body, '<h1>portal</h1>')
        const js = await Harness.Send(host, 'GET', '/assets/app.js')
        assert.equal(js.status, 200)
        assert.equal(js.body, 'var a=1')
        assert.equal((await Harness.Send(host, 'GET', '/nope.txt')).status, 404)
        const t1 = await Harness.Send(host, 'GET', '/..%2fsentinel.txt')
        assert.equal(t1.status, 404)
        assert.ok(!t1.body.includes('SENTINEL'))
        const t2 = await Harness.Send(host, 'GET', '/%2e%2e/sentinel.txt')
        assert.equal(t2.status, 404)
        assert.ok(!t2.body.includes('SENTINEL'))
    })

    it('binds 127.0.0.1 only', () =>
    {
        assert.equal(host.Address().address, '127.0.0.1')
    })

    it('maps remaining client errors', async () =>
    {
        fake.Throw = new PortUnavailableError('8100 busy')
        assert.equal((await Harness.Send(host, 'GET', '/api/environments')).status, 409)
        fake.Throw = new EnvironmentExistsError('x')
        assert.equal((await Harness.Send(host, 'GET', '/api/environments')).status, 409)
        fake.Throw = new InvalidEnvironmentNameError('X!', '^a$')
        assert.equal((await Harness.Send(host, 'GET', '/api/environments')).status, 400)
    })

    it('hides internal detail on 500-class errors', async () =>
    {
        const orig = console.error
        console.error = () => undefined
        try
        {
            fake.Throw = new CreateFailedError('docker stderr C:\secret\path')
            const a = await Harness.Send(host, 'GET', '/api/environments')
            assert.equal(a.status, 500)
            assert.ok(!a.body.includes('secret'))
            fake.Throw = new Error('fs /etc/leak')
            const b = await Harness.Send(host, 'GET', '/api/environments')
            assert.equal(b.status, 500)
            assert.ok(!b.body.includes('leak'))
        }
        finally
        {
            console.error = orig
        }
    })

    it('rejects foreign Host headers and non-JSON bodies', async () =>
    {
        const addr = host.Address()
        const evil = await Harness.Send(host, 'GET', '/api/environments', undefined, { host: 'evil.example.com' })
        assert.equal(evil.status, 403)
        const ok = await Harness.Send(host, 'GET', '/api/environments', undefined, { host: `localhost:${addr.port}` })
        assert.equal(ok.status, 200)
        const text = await Harness.Send(host, 'POST', '/api/environments/x/maker-token', JSON.stringify({ name: 'e' }), { 'content-type': 'text/plain' })
        assert.equal(text.status, 415)
        assert.equal(fake.Calls.length, 0)
    })

    it('returns 400 for a malformed percent-encoded name', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', '/api/environments/%zz/loaded-graph')).status, 400)
    })

    it('broadcasts environments-changed to ws clients', async () =>
    {
        const addr = host.Address()
        const ws = await Harness.OpenEvents(host)
        const msg = new Promise<string>(res => ws.once('message', d => res(d.toString())))
        fake.EmitChange()
        assert.deepEqual(JSON.parse(await msg), { type: 'environments-changed' })
        ws.close()
    })

    it('subscribes once for many ws clients and releases after the last disconnects', async () =>
    {
        assert.equal(fake.ListenerCount, 0)
        const first = await Harness.OpenEvents(host)
        assert.equal(fake.ListenerCount, 1)
        const second = await Harness.OpenEvents(host)
        assert.equal(fake.ListenerCount, 1)
        first.close()
        await Harness.WaitFor(() => first.readyState === WebSocket.CLOSED)
        await Harness.Settle()
        assert.equal(fake.ListenerCount, 1)
        second.close()
        await Harness.WaitFor(() => fake.ListenerCount === 0)
        assert.equal(fake.ListenerCount, 0)
    })

    it('releases the subscription on Close', async () =>
    {
        await Harness.OpenEvents(host)
        assert.equal(fake.ListenerCount, 1)
        await host.Close()
        assert.equal(fake.ListenerCount, 0)
    })

    it('gates API routes behind the operator session', async () =>
    {
        assert.equal((await Harness.Anon(host, 'GET', '/api/environments')).status, 401)
        assert.equal((await Harness.Anon(host, 'GET', '/api/environments/x/loaded-graph')).status, 401)
        assert.equal((await Harness.Anon(host, 'GET', '/api/environments', undefined, { cookie: 'cp_session=bogus' })).status, 401)
        assert.equal((await Harness.Anon(host, 'GET', '/api/environments', undefined, { cookie: Harness.AuthCookie })).status, 200)
        assert.equal(fake.Calls.length, 0)
    })

    it('serves ping and static shell without a cookie', async () =>
    {
        assert.equal((await Harness.Anon(host, 'GET', '/api/ping')).status, 200)
        assert.equal((await Harness.Anon(host, 'GET', '/')).status, 200)
    })

    it('logs in with good credentials and sets a hardened cookie', async () =>
    {
        const r = await Harness.Anon(host, 'POST', '/api/login', JSON.stringify({ email: FakeOperator.Email, password: FakeOperator.Password }))
        assert.equal(r.status, 200)
        assert.deepEqual(JSON.parse(r.body), { email: FakeOperator.Email })
        const cookie = (r.setCookie ?? []).join('|')
        assert.ok(cookie.includes('cp_session='))
        assert.ok(cookie.includes('HttpOnly'))
        assert.ok(cookie.includes('SameSite=Strict'))
    })

    it('rejects bad credentials generically with no cookie', async () =>
    {
        const r = await Harness.Anon(host, 'POST', '/api/login', JSON.stringify({ email: 'nobody@example.com', password: 'nope' }))
        assert.equal(r.status, 401)
        assert.equal(r.setCookie, undefined)
        assert.ok(!r.body.includes('nobody@example.com'))
        assert.ok(!/exist|found/i.test(r.body))
        const bad = await Harness.Anon(host, 'POST', '/api/login', JSON.stringify({ email: 1 }))
        assert.equal(bad.status, 400)
    })

    it('reports the session', async () =>
    {
        const ok = await Harness.Anon(host, 'GET', '/api/session', undefined, { cookie: Harness.AuthCookie })
        assert.equal(ok.status, 200)
        assert.deepEqual(JSON.parse(ok.body), { email: FakeOperator.Email })
        assert.equal((await Harness.Anon(host, 'GET', '/api/session')).status, 401)
    })

    it('logs out: revokes and clears the cookie', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/logout')
        assert.equal(r.status, 200)
        assert.deepEqual(operator.Revoked, ['valid-token'])
        assert.ok((r.setCookie ?? []).join('|').includes('Max-Age=0'))
    })

    it('enforces same-origin on mutating API requests', async () =>
    {
        const path = '/api/logout'
        const evil = await Harness.Send(host, 'POST', path, undefined, { origin: 'http://evil.example' })
        assert.equal(evil.status, 403)
        assert.equal(fake.Calls.length, 0)
        const none = await Harness.Send(host, 'POST', path)
        assert.equal(none.status, 200)
        const addr = host.Address()
        const same = await Harness.Send(host, 'POST', path, undefined, { host: `localhost:${addr.port}`, origin: `http://localhost:${addr.port}` })
        assert.equal(same.status, 200)
        const evilLogin = await Harness.Anon(host, 'POST', '/api/login', JSON.stringify({ email: FakeOperator.Email, password: FakeOperator.Password }), { origin: 'http://evil.example' })
        assert.equal(evilLogin.status, 403)
    })

    it('enforces same-origin on the ws upgrade', async () =>
    {
        const addr = host.Address()
        const evil = new WebSocket(`ws://127.0.0.1:${addr.port}/api/events`, [await Harness.Ticket(host)], { headers: { Origin: 'http://evil.example' } })
        const evilOpened = await new Promise<boolean>(res => { evil.once('open', () => res(true)); evil.once('error', () => res(false)); evil.once('close', () => res(false)) })
        assert.equal(evilOpened, false)
        evil.terminate()
        const same = new WebSocket(`ws://127.0.0.1:${addr.port}/api/events`, [await Harness.Ticket(host)], { headers: { Origin: `http://127.0.0.1:${addr.port}` } })
        const sameOpened = await new Promise<boolean>(res => { same.once('open', () => res(true)); same.once('error', () => res(false)); same.once('close', () => res(false)) })
        assert.equal(sameOpened, true)
        same.close()
    })

    it('rejects ws upgrades without a valid single-use ticket (cookie alone is not enough)', async () =>
    {
        const url = `ws://127.0.0.1:${host.Address().port}/api/events`
        const opens = async (ws: WebSocket): Promise<boolean> =>
        {
            const opened = await new Promise<boolean>(res => { ws.once('open', () => res(true)); ws.once('error', () => res(false)); ws.once('close', () => res(false)) })
            ws.terminate()
            return opened
        }
        assert.equal(await opens(new WebSocket(url, { headers: { Cookie: Harness.AuthCookie } })), false)
        assert.equal(await opens(new WebSocket(url, ['bogus'])), false)
        const ticket = await Harness.Ticket(host)
        assert.equal(await opens(new WebSocket(url, [ticket])), true)
        assert.equal(await opens(new WebSocket(url, [ticket])), false)
    })

    it('events-ticket refuses a foreign Origin', async () =>
    {
        const r = await Harness.Anon(host, 'GET', '/api/events-ticket', undefined, { cookie: Harness.AuthCookie, origin: 'http://evil.example' })
        assert.equal(r.status, 403)
    })

    it('events-ticket requires a session', async () =>
    {
        assert.equal((await Harness.Anon(host, 'GET', '/api/events-ticket')).status, 401)
    })

    it('logout closes the operator event sockets of that session', async () =>
    {
        const ws = await Harness.OpenEvents(host)
        const closed = new Promise<void>(res => ws.once('close', () => res()))
        assert.equal((await Harness.Send(host, 'POST', '/api/logout', '{}')).status, 200)
        await closed
        assert.equal(ws.readyState, WebSocket.CLOSED)
    })

    it('POST graphs with name+description returns 201 and a leak-free GraphDto', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/environments/dev1/graphs', JSON.stringify({ name: 'g1', description: 'first' }))
        assert.equal(r.status, 201)
        const dto = JSON.parse(r.body)
        assert.deepEqual(Object.keys(dto).sort(), Harness.GraphDtoKeys)
        assert.equal(dto.packageCount, 0)
        for (const f of Harness.Forbidden)
        {
            assert.ok(!r.body.includes(f), `body leaked ${f}`)
        }
    })

    it('GET graphs lists the environment graphs', async () =>
    {
        fakeGraph.Seed = [{ name: 'g1', description: 'd', packageCount: 1, createdAt: '2026-10-20T00:00:00.000Z' }]
        const r = await Harness.Send(host, 'GET', '/api/environments/dev1/graphs')
        assert.equal(r.status, 200)
        const arr = JSON.parse(r.body)
        assert.equal(arr.length, 1)
        assert.deepEqual(Object.keys(arr[0]).sort(), Harness.GraphDtoKeys)
        assert.equal(arr[0].packageCount, 1)
        const one = await Harness.Send(host, 'GET', '/api/environments/dev1/graphs/g1')
        assert.equal(one.status, 200)
        assert.equal(JSON.parse(one.body).name, 'g1')
        const del = await Harness.Send(host, 'DELETE', '/api/environments/dev1/graphs/g1')
        assert.equal(del.status, 200)
    })

    it('maps graph service errors to statuses', async () =>
    {
        const body = JSON.stringify({ name: 'g1', description: 'd' })
        fakeGraph.Throw = new EnvironmentNotDevelopmentError('dev1')
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/dev1/graphs', body)).status, 400)
        fakeGraph.Throw = new EnvironmentNotFoundError('dev1')
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/dev1/graphs', body)).status, 404)
        fakeGraph.Throw = new GraphExistsError('g1')
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/dev1/graphs', body)).status, 409)
    })

    it('a missing graph name/description is 400; an unauthenticated graphs request is 401', async () =>
    {
        const noName = await Harness.Send(host, 'POST', '/api/environments/dev1/graphs', JSON.stringify({ description: 'd' }))
        assert.equal(noName.status, 400)
        const noDesc = await Harness.Send(host, 'POST', '/api/environments/dev1/graphs', JSON.stringify({ name: 'g1' }))
        assert.equal(noDesc.status, 400)
        assert.equal((await Harness.Send(host, 'GET', '/api/environments/%zz/graphs')).status, 400)
        assert.equal((await Harness.Anon(host, 'GET', '/api/environments/dev1/graphs')).status, 401)
        assert.equal((await Harness.Anon(host, 'POST', '/api/environments/dev1/graphs', JSON.stringify({ name: 'g1', description: 'd' }))).status, 401)
        assert.deepEqual(fakeGraph.Calls, [])
    })

    it('POST promote relays to the graph service and returns the promotion DTO', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/environments/dev1/graphs/g1/promote', JSON.stringify({ targetEnv: 'rt1' }))
        assert.equal(r.status, 200)
        assert.deepEqual(fakeGraph.Calls, ['promote:dev1:g1:rt1'])
        assert.deepEqual(JSON.parse(r.body), { graphName: 'g1', packageCount: 2, targetEnv: 'rt1' })
    })

    it('a non-POST on the promote path is not handled (404)', async () =>
    {
        const get = await Harness.Send(host, 'GET', '/api/environments/dev1/graphs/g1/promote')
        assert.equal(get.status, 404)
        assert.deepEqual(fakeGraph.Calls, [])
    })

    it('promote with a missing or empty targetEnv is 400', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/dev1/graphs/g1/promote', JSON.stringify({}))).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/dev1/graphs/g1/promote', JSON.stringify({ targetEnv: '' }))).status, 400)
        assert.deepEqual(fakeGraph.Calls, [])
    })

    it('maps a Development target promote error to 400', async () =>
    {
        fakeGraph.Throw = new EnvironmentNotRuntimeError('rt1')
        const r = await Harness.Send(host, 'POST', '/api/environments/dev1/graphs/g1/promote', JSON.stringify({ targetEnv: 'rt1' }))
        assert.equal(r.status, 400)
    })

    it('GET loaded-graph returns the runtime manifest, or JSON null when none', async () =>
    {
        const r = await Harness.Send(host, 'GET', '/api/environments/rt1/loaded-graph')
        assert.equal(r.status, 200)
        assert.deepEqual(fakeGraph.Calls, ['getLoaded:rt1'])
        assert.equal(JSON.parse(r.body).promotedAt, '2026-10-20T01:00:00.000Z')
        fakeGraph.Loaded = null
        const none = await Harness.Send(host, 'GET', '/api/environments/rt1/loaded-graph')
        assert.equal(none.status, 200)
        assert.equal(JSON.parse(none.body), null)
    })
})

describe('ControlPlaneHost operator socket lifecycle', () =>
{
    const SweepMs = 20
    const TicketTtlMs = 50
    let parent: string
    let operator: FakeOperator
    let host: ControlPlaneHost
    let clock: { T: number }
    let registry: OperatorSocketRegistry<WebSocket>
    let service: FakeService

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-sock-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        operator = new FakeOperator()
        operator.Extra.add('other-token')
        clock = { T: 1000 }
        const directory = new PlatformDirectory(new ClientRegistry(join(parent, 'clients.json')), new TenantRegistry(join(parent, 'tenants.json')), new HiveRegistry(join(parent, 'hives.json')), { List: () => [] })
        const factory = new HiveOrchestratorFactory()
        registry = new OperatorSocketRegistry<WebSocket>()
        service = new FakeService()
        const tickets = new EventsTicketStore({ ttlMs: TicketTtlMs, now: () => clock.T })
        host = new ControlPlaneHost(service, new FakeGraphService(), root, operator, false, directory, await RolloutFixture.Create(parent, directory, factory), new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent), new LoginThrottle(), false, tickets, registry, SweepMs)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('sweep closes sockets of an invalid token, keeps valid ones, and survives a throwing validator', async () =>
    {
        const dead = await Harness.OpenAs(host, FakeOperator.Token)
        const alive = await Harness.OpenAs(host, 'other-token')
        operator.Throwing.add('other-token')
        operator.Dead.add(FakeOperator.Token)
        await Harness.WaitFor(() => dead.readyState === WebSocket.CLOSED)
        assert.equal(dead.readyState, WebSocket.CLOSED)
        assert.equal(alive.readyState, WebSocket.OPEN)
        alive.terminate()
    })

    it('Close clears the revalidation timer', async () =>
    {
        const ws = await Harness.OpenAs(host, FakeOperator.Token)
        await host.Close()
        ws.terminate()
        const before = operator.ValidateCalls
        await new Promise(res => setTimeout(res, SweepMs * 5))
        assert.equal(operator.ValidateCalls, before)
    })

    it('rejects an upgrade with an expired ticket', async () =>
    {
        const ticket = await Harness.TicketFor(host, FakeOperator.Token)
        clock.T += TicketTtlMs + 1
        const ws = new WebSocket(`ws://127.0.0.1:${host.Address().port}/api/events`, [ticket])
        const opened = await new Promise<boolean>(res => { ws.once('open', () => res(true)); ws.once('error', () => res(false)); ws.once('close', () => res(false)) })
        assert.equal(opened, false)
        ws.terminate()
    })

    it('closes a socket whose session was revoked between redeem and admission', async () =>
    {
        const ticket = await Harness.TicketFor(host, FakeOperator.Token)
        operator.Dead.add(FakeOperator.Token)
        const ws = new WebSocket(`ws://127.0.0.1:${host.Address().port}/api/events`, [ticket])
        const opened = await new Promise<boolean>(res => { ws.once('open', () => res(true)); ws.once('error', () => res(false)); ws.once('close', () => res(false)) })
        assert.equal(opened, false)
        ws.terminate()
    })

    // Opens a socket whose admission ValidateToken is held, runs `during` while it is pending, then releases it.
    async function HeldAdmission(during: (ws: WebSocket) => Promise<void>): Promise<void>
    {
        const ticket = await Harness.TicketFor(host, FakeOperator.Token)
        operator.HoldCall = operator.ValidateCalls + 2
        const ws = new WebSocket(`ws://127.0.0.1:${host.Address().port}/api/events`, [ticket])
        await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
        await Harness.WaitFor(() => operator.Release !== undefined)
        await during(ws)
        operator.Release?.()
        await Harness.Settle()
    }

    it('a peer that closes while admission is pending is not registered and leaks no subscription', async () =>
    {
        await HeldAdmission(async ws =>
        {
            ws.terminate()
            await Harness.Settle()
        })
        assert.equal(registry.Size(), 0)
        assert.equal(service.ListenerCount, 0)
    })

    it('a peer that drops abruptly while admission is pending does not crash the host or register', async () =>
    {
        await HeldAdmission(async ws =>
        {
            const raw = (ws as unknown as { _socket: { resetAndDestroy?: () => void; destroy: () => void } })._socket
            raw.resetAndDestroy !== undefined ? raw.resetAndDestroy() : raw.destroy()
            await Harness.Settle()
        })
        assert.equal(registry.Size(), 0)
        assert.equal(service.ListenerCount, 0)
        assert.equal((await Harness.Send(host, 'GET', '/api/ping')).status, 200)
    })
})
