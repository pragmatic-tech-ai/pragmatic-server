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
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { TemplateCatalog } from '../template-catalog.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'

import { EnvironmentNotDevelopmentError, EnvironmentNotRuntimeError } from '../environment-service.js'
import { GraphExistsError, GraphNotFoundError } from '../graph-service.js'
import type { IOperatorIdentity, OperatorPrincipal, OperatorSession } from '../operator-identity.js'

type Reply = { status: number; body: string; setCookie?: string[] | undefined }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Email = 'op@example.com'
    public static readonly Password = 'correct-horse'
    public static readonly Token = 'valid-token'
    public Revoked: string[] = []

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
        return token === FakeOperator.Token ? { email: FakeOperator.Email, principalId: 'p1' } : null
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
        return this.List()
    }

    public LogStream(): ILogProcess
    {
        return { OnData() {}, OnClose() {}, Kill() {} }
    }

    public OnChanged(): () => void
    {
        return () => {}
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

    it('create passes hiveId through and the DTO carries hiveId and platform tenantId', async () =>
    {
        const ok = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e1', template: 'dev-blank', type: 'development', hiveId: 'h1' }))
        assert.equal(ok.status, 201)
        assert.deepEqual(fake.Calls, ['create:e1:dev-blank:development:undefined:h1'])
        const dto = JSON.parse(ok.body)
        assert.equal(dto.hiveId, 'h1')
        assert.equal(dto.tenantId, 'plat-t1')
        assert.equal(dto.environmentId, 'dev')
        const bad = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e2', template: 'dev-blank', type: 'development', hiveId: 5 }))
        assert.equal(bad.status, 400)
    })

    it('creates, validates input', async () =>
    {
        const ok = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e1', template: 'dev-blank', type: 'development' }))
        assert.equal(ok.status, 201)
        assert.deepEqual(fake.Calls, ['create:e1:dev-blank:development:undefined'])
        assert.equal(JSON.parse(ok.body).name, 'e1')
        const noName = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ template: 'dev-blank', type: 'development' }))
        assert.equal(noName.status, 400)
        assert.ok(JSON.parse(noName.body).error.length > 0)
        const badTpl = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e', template: 'nope' }))
        assert.equal(badTpl.status, 400)
        assert.equal(fake.Calls.length, 1)
        const big = await Harness.Send(host, 'POST', '/api/environments', 'x'.repeat(100000))
        assert.equal(big.status, 413)
    })

    it('start/stop/delete/logs and error mapping', async () =>
    {
        const s = await Harness.Send(host, 'POST', '/api/environments/x/start')
        assert.equal(s.status, 200)
        assert.deepEqual(fake.Calls, ['start:x'])
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/stop')).status, 200)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/environments/x')).status, 200)
        const logs = await Harness.Send(host, 'GET', '/api/environments/x/logs')
        assert.equal(JSON.parse(logs.body).logs, 'log-line')

        fake.Throw = new EnvironmentNotFoundError('x')
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/start')).status, 404)

        fake.Throw = new ImageMissingError('docker build -t foo .')
        const img = await Harness.Send(host, 'POST', '/api/environments/x/start')
        assert.equal(img.status, 409)
        assert.equal(JSON.parse(img.body).buildCommand, 'docker build -t foo .')

        fake.Throw = new DockerUnavailableError()
        const dk = await Harness.Send(host, 'POST', '/api/environments/x/start')
        assert.equal(dk.status, 503)
        assert.match(JSON.parse(dk.body).error, /Start Docker/)

        fake.Throw = new CreateFailedError('boom')
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/start')).status, 500)
        fake.Throw = new Error('weird')
        const gen = await Harness.Send(host, 'POST', '/api/environments/x/start')
        assert.equal(gen.status, 500)
        assert.ok(!gen.body.includes('weird'))
    })

    it('creates with a valid type and carries it in the DTO', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e2', template: 'dev-blank', type: 'runtime' }))
        assert.equal(r.status, 201)
        assert.equal(JSON.parse(r.body).type, 'runtime')
        assert.deepEqual(fake.Calls, ['create:e2:dev-blank:runtime:undefined'])
    })

    it('rejects an unknown or missing type with 400 listing valid types', async () =>
    {
        const bad = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e', template: 'dev-blank', type: 'bogus' }))
        assert.equal(bad.status, 400)
        assert.ok(JSON.parse(bad.body).error.includes(Object.values(EnvType).join(', ')))
        const missing = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e', template: 'dev-blank' }))
        assert.equal(missing.status, 400)
        const nonString = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e', template: 'dev-blank', type: 123 }))
        assert.equal(nonString.status, 400)
        assert.equal(fake.Calls.length, 0)
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

    it('unauthenticated create is 401 before validation', async () =>
    {
        const r = await Harness.Anon(host, 'POST', '/api/environments', JSON.stringify({ name: 'e', template: 'dev-blank', type: 'bogus' }))
        assert.equal(r.status, 401)
        assert.equal(fake.Calls.length, 0)
    })

    it('never leaks secret or internal fields', async () =>
    {
        const list = await Harness.Send(host, 'GET', '/api/environments')
        const created = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e1', template: 'dev-blank', type: 'development' }))
        const started = await Harness.Send(host, 'POST', '/api/environments/x/start')
        assert.deepEqual(Object.keys(JSON.parse(created.body)).sort(), Harness.DtoKeys)
        assert.deepEqual(Object.keys(JSON.parse(started.body)).sort(), Harness.DtoKeys)
        for (const r of [list, created, started])
        {
            for (const f of Harness.Forbidden)
            {
                assert.ok(!r.body.includes(f), `body leaked ${f}`)
            }
        }
    })

    it('serves the template catalog', async () =>
    {
        const r = await Harness.Send(host, 'GET', '/api/templates')
        assert.equal(r.status, 200)
        assert.deepEqual(JSON.parse(r.body), JSON.parse(JSON.stringify(TemplateCatalog.All())))
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
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/start')).status, 409)
        fake.Throw = new EnvironmentExistsError('x')
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/start')).status, 409)
        fake.Throw = new InvalidEnvironmentNameError('X!', '^a$')
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/start')).status, 400)
    })

    it('hides internal detail on 500-class errors', async () =>
    {
        const orig = console.error
        console.error = () => undefined
        try
        {
            fake.Throw = new CreateFailedError('docker stderr C:\secret\path')
            const a = await Harness.Send(host, 'POST', '/api/environments/x/start')
            assert.equal(a.status, 500)
            assert.ok(!a.body.includes('secret'))
            fake.Throw = new Error('fs /etc/leak')
            const b = await Harness.Send(host, 'POST', '/api/environments/x/start')
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
        const text = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e', template: 'dev-blank' }), { 'content-type': 'text/plain' })
        assert.equal(text.status, 415)
        assert.equal(fake.Calls.length, 0)
    })

    it('returns 400 for a malformed percent-encoded name', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/%zz/start')).status, 400)
    })

    it('broadcasts environments-changed to ws clients', async () =>
    {
        const addr = host.Address()
        const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/events`, { headers: { Cookie: Harness.AuthCookie } })
        await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
        const msg = new Promise<string>(res => ws.once('message', d => res(d.toString())))
        await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e1', template: 'dev-blank', type: 'development' }))
        assert.deepEqual(JSON.parse(await msg), { type: 'environments-changed' })
        ws.close()
    })

    it('gates API routes behind the operator session', async () =>
    {
        assert.equal((await Harness.Anon(host, 'GET', '/api/environments')).status, 401)
        assert.equal((await Harness.Anon(host, 'GET', '/api/templates')).status, 401)
        assert.equal((await Harness.Anon(host, 'POST', '/api/environments/x/start')).status, 401)
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
        const body = JSON.stringify({ name: 'e1', template: 'dev-blank', type: 'development' })
        const evil = await Harness.Send(host, 'POST', '/api/environments', body, { origin: 'http://evil.example' })
        assert.equal(evil.status, 403)
        assert.equal(fake.Calls.length, 0)
        const none = await Harness.Send(host, 'POST', '/api/environments', body)
        assert.equal(none.status, 201)
        const addr = host.Address()
        const same = await Harness.Send(host, 'POST', '/api/environments', body, { host: `localhost:${addr.port}`, origin: `http://localhost:${addr.port}` })
        assert.equal(same.status, 201)
        const evilLogin = await Harness.Anon(host, 'POST', '/api/login', JSON.stringify({ email: FakeOperator.Email, password: FakeOperator.Password }), { origin: 'http://evil.example' })
        assert.equal(evilLogin.status, 403)
    })

    it('enforces same-origin on the ws upgrade', async () =>
    {
        const addr = host.Address()
        const evil = new WebSocket(`ws://127.0.0.1:${addr.port}/api/events`, { headers: { Cookie: Harness.AuthCookie, Origin: 'http://evil.example' } })
        const evilOpened = await new Promise<boolean>(res => { evil.once('open', () => res(true)); evil.once('error', () => res(false)); evil.once('close', () => res(false)) })
        assert.equal(evilOpened, false)
        evil.terminate()
        const same = new WebSocket(`ws://127.0.0.1:${addr.port}/api/events`, { headers: { Cookie: Harness.AuthCookie, Origin: `http://127.0.0.1:${addr.port}` } })
        const sameOpened = await new Promise<boolean>(res => { same.once('open', () => res(true)); same.once('error', () => res(false)); same.once('close', () => res(false)) })
        assert.equal(sameOpened, true)
        same.close()
    })

    it('admin routes require a session (401) and a same origin (403) before reaching the service', async () =>
    {
        const anon = await Harness.Anon(host, 'GET', '/api/environments/x/admin/snapshot')
        assert.equal(anon.status, 401)
        const cross = await Harness.Send(host, 'POST', '/api/environments/x/admin/accounts', JSON.stringify({ email: 'a@b.c', principalId: 'p', password: 'pw' }), { origin: 'http://evil.example' })
        assert.equal(cross.status, 403)
        const crossPut = await Harness.Send(host, 'PUT', '/api/environments/x/admin/config', JSON.stringify({ packId: 'a', delegationDepth: 'b' }), { origin: 'http://evil.example' })
        assert.equal(crossPut.status, 403)
        assert.deepEqual(fake.Calls, [])
    })

    it('admin routes delegate with decoded name and args', async () =>
    {
        const origin = { origin: `http://127.0.0.1:${host.Address().port}`, host: `127.0.0.1:${host.Address().port}` }
        const snap = await Harness.Send(host, 'GET', '/api/environments/my%20env/admin/snapshot', undefined, origin)
        assert.equal(snap.status, 200)
        assert.deepEqual(JSON.parse(snap.body).accounts, [])
        const acct = { email: 'a@b.c', principalId: 'p1', password: 'pw' }
        const create = await Harness.Send(host, 'POST', '/api/environments/x/admin/accounts', JSON.stringify(acct), origin)
        assert.equal(create.status, 201)
        assert.deepEqual(JSON.parse(create.body), { ok: true })
        const dis = await Harness.Send(host, 'DELETE', '/api/environments/x/admin/accounts/user%2F1', undefined, origin)
        assert.equal(dis.status, 200)
        const grant = { subject: 's', role: 'r', resourceKind: 'k', resourcePath: 'p' }
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/admin/grants', JSON.stringify(grant), origin)).status, 200)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/environments/x/admin/grants', JSON.stringify(grant), origin)).status, 200)
        assert.equal((await Harness.Send(host, 'GET', '/api/environments/x/admin/config', undefined, origin)).status, 200)
        const cfg = { packId: 'pk', delegationDepth: 'd' }
        assert.equal((await Harness.Send(host, 'PUT', '/api/environments/x/admin/config', JSON.stringify(cfg), origin)).status, 200)
        assert.deepEqual(fake.Calls, [
            'adminSnapshot:my env',
            `adminCreateAccount:x:${JSON.stringify(acct)}`,
            'adminDisableAccount:x:user/1',
            `adminGrantRole:x:${JSON.stringify(grant)}`,
            `adminRevokeRole:x:${JSON.stringify(grant)}`,
            'adminGetConfig:x',
            `adminSetConfig:x:${JSON.stringify(cfg)}`
        ])
    })

    it('security-model routes delegate and map an absent model to JSON null', async () =>
    {
        const origin = { origin: `http://127.0.0.1:${host.Address().port}`, host: `127.0.0.1:${host.Address().port}` }
        const got = await Harness.Send(host, 'GET', '/api/environments/x/admin/security-model', undefined, origin)
        assert.equal(got.status, 200)
        assert.equal(JSON.parse(got.body), null)
        const model = { roles: [{ id: 'r', name: 'R', privileges: [] }] }
        assert.equal((await Harness.Send(host, 'PUT', '/api/environments/x/admin/security-model', JSON.stringify({ securityModel: model }), origin)).status, 200)
        assert.equal((await Harness.Send(host, 'PUT', '/api/environments/x/admin/security-model', JSON.stringify({ securityModel: 1 }), origin)).status, 400)
        assert.deepEqual(fake.Calls, ['adminGetSecurityModel:x', `adminSetSecurityModel:x:${JSON.stringify(model)}`])
    })

    it('admin routes validate bodies and unknown sub-routes', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/admin/accounts', JSON.stringify({ email: 'a' }))).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/admin/grants', '{bad')).status, 400)
        assert.equal((await Harness.Send(host, 'PUT', '/api/environments/x/admin/config', JSON.stringify({ packId: 1 }))).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/environments/x/admin/snapshot')).status, 404)
        assert.deepEqual(fake.Calls, [])
    })

    it('maps AdminProxyError kinds and unknown environments to statuses', async () =>
    {
        fake.Throw = new AdminProxyError(AdminProxyErrorKind.Connect, 'ECONNREFUSED 10.0.0.5:8101 login failed')
        const conn = await Harness.Send(host, 'GET', '/api/environments/x/admin/snapshot')
        assert.equal(conn.status, 503)
        assert.equal(JSON.parse(conn.body).error, 'Environment is not reachable')
        assert.ok(!conn.body.includes('ECONNREFUSED'))
        fake.Throw = new AdminProxyError(AdminProxyErrorKind.Rbac, 'last admin cannot be removed')
        const rbac = await Harness.Send(host, 'DELETE', '/api/environments/x/admin/grants', JSON.stringify({ subject: 's', role: 'r' }))
        assert.equal(rbac.status, 409)
        assert.equal(JSON.parse(rbac.body).error, 'last admin cannot be removed')
        fake.Throw = new AdminProxyError(AdminProxyErrorKind.Invalid, 'bad principal')
        const inv = await Harness.Send(host, 'POST', '/api/environments/x/admin/accounts', JSON.stringify({ email: 'a', principalId: 'p', password: 'w' }))
        assert.equal(inv.status, 400)
        assert.equal(JSON.parse(inv.body).error, 'bad principal')
        fake.Throw = new AdminProxyError(AdminProxyErrorKind.Protocol, 'internal detail')
        const proto = await Harness.Send(host, 'GET', '/api/environments/x/admin/config')
        assert.equal(proto.status, 500)
        assert.ok(!proto.body.includes('internal detail'))
        fake.Throw = new EnvironmentNotFoundError('x')
        assert.equal((await Harness.Send(host, 'GET', '/api/environments/x/admin/snapshot')).status, 404)
    })

    it('maps a non-AdminProxyError thrown on an admin route to a generic 500', async () =>
    {
        fake.Throw = new Error('secret internal detail 10.0.0.5')
        const res = await Harness.Send(host, 'GET', '/api/environments/x/admin/snapshot')
        assert.equal(res.status, 500)
        assert.ok(!res.body.includes('secret internal detail'))
    })

    it('rejects an undecodable principalId or environment name in admin paths with 400', async () =>
    {
        assert.equal((await Harness.Send(host, 'DELETE', '/api/environments/x/admin/accounts/%E0%A4%A')).status, 400)
        assert.equal((await Harness.Send(host, 'GET', '/api/environments/%E0%A4%A/admin/snapshot')).status, 400)
        assert.deepEqual(fake.Calls, [])
    })

    it('rejects ws upgrades without a valid session cookie', async () =>
    {
        const addr = host.Address()
        for (const headers of [{}, { Cookie: 'cp_session=bogus' }])
        {
            const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/events`, { headers })
            const opened = await new Promise<boolean>(res => { ws.once('open', () => res(true)); ws.once('error', () => res(false)); ws.once('close', () => res(false)) })
            assert.equal(opened, false)
            ws.terminate()
        }
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

    it('POST maker-token returns 201 with only token, principalId, expiresAt', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/environments/dev1/maker-token')
        assert.equal(r.status, 201)
        const dto = JSON.parse(r.body)
        assert.deepEqual(dto, { token: 'SECRET-MAKER-TOKEN-123', principalId: 'maker-1', expiresAt: '2027-01-01T00:00:00.000Z' })
        assert.equal((await Harness.Send(host, 'GET', '/api/environments/dev1/maker-token')).status, 404)
    })

    it('maker-token requires a session (401) and a same origin (403)', async () =>
    {
        assert.equal((await Harness.Anon(host, 'POST', '/api/environments/dev1/maker-token')).status, 401)
        const cross = await Harness.Send(host, 'POST', '/api/environments/dev1/maker-token', undefined, { origin: 'http://evil.example.com' })
        assert.equal(cross.status, 403)
        assert.ok(!fake.Calls.some(c => c.startsWith('adminIssueMakerToken')))
    })

    it('maps maker-token service errors to statuses', async () =>
    {
        const path = '/api/environments/dev1/maker-token'
        fake.Throw = new EnvironmentNotDevelopmentError('dev1')
        assert.equal((await Harness.Send(host, 'POST', path)).status, 400)
        fake.Throw = new EnvironmentNotFoundError('dev1')
        assert.equal((await Harness.Send(host, 'POST', path)).status, 404)
        fake.Throw = new AdminProxyError(AdminProxyErrorKind.Rbac, 'denied')
        assert.equal((await Harness.Send(host, 'POST', path)).status, 409)
        fake.Throw = new AdminProxyError(AdminProxyErrorKind.Invalid, 'bad')
        assert.equal((await Harness.Send(host, 'POST', path)).status, 400)
    })

    it('POST app-reader-grant provisions the read grant and returns no secret', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/environments/rt1/app-reader-grant')
        assert.equal(r.status, 200)
        assert.deepEqual(JSON.parse(r.body), { ok: true })
        assert.deepEqual(fake.Calls, ['adminGrantAppReader:rt1'])
        assert.equal((await Harness.Send(host, 'GET', '/api/environments/rt1/app-reader-grant')).status, 404)
    })

    it('app-reader-grant requires a session (401) and a same origin (403)', async () =>
    {
        assert.equal((await Harness.Anon(host, 'POST', '/api/environments/rt1/app-reader-grant')).status, 401)
        const cross = await Harness.Send(host, 'POST', '/api/environments/rt1/app-reader-grant', undefined, { origin: 'http://evil.example.com' })
        assert.equal(cross.status, 403)
        assert.ok(!fake.Calls.some(c => c.startsWith('adminGrantAppReader')))
    })

    it('maps app-reader-grant service errors to statuses', async () =>
    {
        const path = '/api/environments/rt1/app-reader-grant'
        fake.Throw = new EnvironmentNotRuntimeError('rt1')
        assert.equal((await Harness.Send(host, 'POST', path)).status, 400)
        fake.Throw = new EnvironmentNotFoundError('rt1')
        assert.equal((await Harness.Send(host, 'POST', path)).status, 404)
        fake.Throw = new AdminProxyError(AdminProxyErrorKind.Rbac, 'denied')
        assert.equal((await Harness.Send(host, 'POST', path)).status, 409)
    })

    it('never logs the maker token, even when the service fails', async () =>
    {
        const lines: string[] = []
        const orig = { e: console.error, l: console.log, w: console.warn, i: console.info }
        const capture = (...a: unknown[]): void => { lines.push(a.map(x => String(x)).join(' ')) }
        console.error = capture
        console.log = capture
        console.warn = capture
        console.info = capture
        try
        {
            const ok = await Harness.Send(host, 'POST', '/api/environments/dev1/maker-token')
            assert.ok(ok.body.includes('SECRET-MAKER-TOKEN-123'))
            fake.Throw = new Error('boom')
            await Harness.Send(host, 'POST', '/api/environments/dev1/maker-token')
        }
        finally
        {
            console.error = orig.e
            console.log = orig.l
            console.warn = orig.w
            console.info = orig.i
        }
        assert.ok(lines.length > 0)
        assert.ok(!lines.some(l => l.includes('SECRET-MAKER-TOKEN-123')))
    })
})
