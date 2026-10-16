import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ControlPlaneHost, type IEnvironmentService } from '../control-plane-host.js'
import { CreateFailedError, DockerUnavailableError, EnvironmentNotFoundError, ImageMissingError } from '../environment-service.js'
import { EnvStatus, Template, type EnvironmentRecord } from '../environment-record.js'
import { TemplateCatalog } from '../template-catalog.js'

type Reply = { status: number; body: string }

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

    public async Logs(name: string): Promise<string>
    {
        this.Calls.push(`logs:${name}`)
        return 'log-line'
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

    public static Send(host: ControlPlaneHost, method: string, path: string, body?: string): Promise<Reply>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers: { 'content-type': 'application/json' } }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end(body)
        })
    }
}

describe('ControlPlaneHost', () =>
{
    let fake: FakeService
    let host: ControlPlaneHost
    let root: string

    beforeEach(async () =>
    {
        root = mkdtempSync(join(tmpdir(), 'cp-static-'))
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        mkdirSync(join(root, 'assets'))
        writeFileSync(join(root, 'assets', 'app.js'), 'var a=1')
        fake = new FakeService()
        host = new ControlPlaneHost(fake, root)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(root, { recursive: true, force: true })
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
        assert.equal((await Harness.Send(host, 'GET', '/..%2f..%2fpackage.json')).status, 404)
        assert.equal((await Harness.Send(host, 'GET', '/%2e%2e/%2e%2e/package.json')).status, 404)
    })

    it('binds 127.0.0.1 only', () =>
    {
        assert.equal(host.Address().address, '127.0.0.1')
    })
})
