import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:https'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkerHost } from '../worker-host.js'
import { MachineTls } from '../machine-tls.js'
import type { MachineTlsRef } from '../machine-tls.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

interface Reply
{
    status: number
    type: string
    body: string
}

class WorkerServeFixture
{
    public static readonly KeyEnv = 'PS_WHAS_KEY'
    private static readonly Dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tls')

    public static Server(): MachineTlsRef
    {
        return { certFile: join(WorkerServeFixture.Dir, 'server.pem'), keyFile: join(WorkerServeFixture.Dir, 'server.key'), caFile: join(WorkerServeFixture.Dir, 'ca.pem') }
    }

    public static Client(): MachineTlsRef
    {
        return { certFile: join(WorkerServeFixture.Dir, 'client.pem'), keyFile: join(WorkerServeFixture.Dir, 'client.key'), caFile: join(WorkerServeFixture.Dir, 'ca.pem') }
    }

    public static Get(port: number, path: string): Promise<Reply>
    {
        const client = MachineTls.Client(WorkerServeFixture.Client())
        return new Promise<Reply>((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path, method: 'GET', key: client.key, cert: client.cert, ca: client.ca, servername: '127.0.0.1' }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end()
        })
    }
}

test('a worker dispatches /app/<tenant>/<app>/ to AppServingEndpoint exactly like the main host', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-whas-'))
    process.env[WorkerServeFixture.KeyEnv] = randomBytes(32).toString('base64')
    const apps = join(baseDir, 't1', 'applications')
    mkdirSync(join(apps, 'shop', 'ui', 'assets'), { recursive: true })
    writeFileSync(join(apps, 'shop', 'ui', 'index.html'), '<html><head></head><body>shell</body></html>')
    writeFileSync(join(apps, 'shop', 'ui', 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(apps, 'secret.txt'), 'TOP-SECRET')
    writeFileSync(join(apps, 'shop', 'application.json'), JSON.stringify({ name: 'shop', version: '1.0.0', packages: [], ui: { entry: 'index.html', assets: ['assets/app.js'] } }))
    const provisioning = new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([['t1', { displayName: 'T1', purpose: TenantPurpose.Runtime }]]))
    const worker = await WorkerHost.StartAsync({ port: 0, baseDir, masterKey: { base64Env: WorkerServeFixture.KeyEnv }, provisioning, tls: WorkerServeFixture.Server() })
    try
    {
        const port = worker.Address().port
        const shell = await WorkerServeFixture.Get(port, '/app/t1/shop/')
        assert.equal(shell.status, 200)
        assert.match(shell.type, /^text\/html/)
        assert.ok(shell.body.includes('<meta name="pragmatic-app" content="shop">'))
        const asset = await WorkerServeFixture.Get(port, '/app/t1/shop/assets/app.js')
        assert.equal(asset.status, 200)
        assert.match(asset.type, /^text\/javascript/)
        assert.equal((await WorkerServeFixture.Get(port, '/app/t1/nope/')).status, 404)
        const traversal = await WorkerServeFixture.Get(port, '/app/t1/shop/..%2f..%2fsecret.txt')
        assert.notEqual(traversal.status, 200)
        assert.ok(!traversal.body.includes('TOP-SECRET'))
    }
    finally
    {
        await worker.DisposeAsync()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[WorkerServeFixture.KeyEnv]
    }
})
