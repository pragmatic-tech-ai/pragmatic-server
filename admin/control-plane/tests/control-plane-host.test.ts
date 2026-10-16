import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ControlPlaneHost, type IEnvironmentService } from '../control-plane-host.js'
import { CreateFailedError, DockerUnavailableError, EnvironmentExistsError, EnvironmentNotFoundError, ImageMissingError } from '../environment-service.js'
import { PortUnavailableError } from '../port-allocator.js'
import { InvalidEnvironmentNameError } from '../template-catalog.js'
import { WebSocket } from 'ws'
import type { AdminSnapshot } from '../admin-proxy.js'
import type { CreateAccountParams, GrantMutationDto, IdentityConfigDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EnvStatus, Template, type EnvironmentRecord } from '../environment-record.js'
import { TemplateCatalog } from '../template-catalog.js'

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
        tenantId: 'dev',
        hostPort: 8101,
        containerName: 'ctr-secret-name',
        volumeName: 'vol-secret-name',
        bundleDir: '/secret/bundle',
        createdAt: '2026-10-16T00:00:00.000Z',
        status: EnvStatus.Running
    }

    public async Create(name: string, template: Template, hostPort?: number): Promise<EnvironmentRecord>
    {
        this.Calls.push(`create:${name}:${template}:${String(hostPort)}`)
        this.MaybeThrow()
        return { ...this.Record, name, template }
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

    public async Logs(name: string): Promise<string>
    {
        this.Calls.push(`logs:${name}`)
        return 'log-line'
    }

    public async AdminSnapshot(name: string): Promise<AdminSnapshot>
    {
        this.Calls.push(`adminSnapshot:${name}`)
        return { accounts: [], grants: [], config: {} as IdentityConfigDto }
    }

    public async AdminCreateAccount(name: string, params: CreateAccountParams): Promise<void>
    {
        this.Calls.push(`adminCreateAccount:${name}:${JSON.stringify(params)}`)
    }

    public async AdminDisableAccount(name: string, principalId: string): Promise<void>
    {
        this.Calls.push(`adminDisableAccount:${name}:${principalId}`)
    }

    public async AdminGrantRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        this.Calls.push(`adminGrantRole:${name}:${JSON.stringify(mutation)}`)
    }

    public async AdminRevokeRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        this.Calls.push(`adminRevokeRole:${name}:${JSON.stringify(mutation)}`)
    }

    public async AdminGetConfig(name: string): Promise<IdentityConfigDto>
    {
        this.Calls.push(`adminGetConfig:${name}`)
        return {} as IdentityConfigDto
    }

    public async AdminSetConfig(name: string, config: IdentityConfigDto): Promise<void>
    {
        this.Calls.push(`adminSetConfig:${name}:${JSON.stringify(config)}`)
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
    public static readonly DtoKeys = ['createdAt', 'hostPort', 'httpUrl', 'name', 'status', 'template', 'tenantId', 'wsUrl']
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
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
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
        operator = new FakeOperator()
        host = new ControlPlaneHost(fake, root, operator, false)
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
        assert.equal(arr[0].wsUrl, 'ws://localhost:8101/?tenant=dev')
    })

    it('creates, validates input', async () =>
    {
        const ok = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e1', template: 'dev-blank' }))
        assert.equal(ok.status, 201)
        assert.deepEqual(fake.Calls, ['create:e1:dev-blank:undefined'])
        assert.equal(JSON.parse(ok.body).name, 'e1')
        const noName = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ template: 'dev-blank' }))
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

    it('never leaks secret or internal fields', async () =>
    {
        const list = await Harness.Send(host, 'GET', '/api/environments')
        const created = await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e1', template: 'dev-blank' }))
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
        await Harness.Send(host, 'POST', '/api/environments', JSON.stringify({ name: 'e1', template: 'dev-blank' }))
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
        const body = JSON.stringify({ name: 'e1', template: 'dev-blank' })
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
})
