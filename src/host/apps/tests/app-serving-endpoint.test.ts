import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PragmaticServerHost } from '../../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../../tenancy/tenant-registry.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import type { TenantProvisioning } from '../../../tenancy/tenant-provisioning.js'
import { PragmaticAppManifestParser } from '../pragmatic-app-manifest.js'

interface Reply
{
    status: number
    type: string
    body: string
}

class ServeFixture
{
    public static readonly Tenant = 't1'
    public static readonly App = 'shop'
    public static readonly Shell = '<html><head><title>x</title></head><body>shell</body></html>'
    public static readonly Script = 'console.log(1)'
    public static readonly Secret = 'TOP-SECRET'

    public readonly Dir = mkdtempSync(join(tmpdir(), 'serve-'))

    /** Writes a version-scoped tree `<app>/<version>/{application.json,ui/...}` whose shell names the version. */
    public WriteVersion(version: string): void
    {
        const root = join(this.Dir, ServeFixture.Tenant, 'applications', ServeFixture.App, version)
        mkdirSync(join(root, 'ui', 'assets'), { recursive: true })
        writeFileSync(join(root, 'ui', 'index.html'), '<html><head></head><body>shell-' + version + '</body></html>')
        writeFileSync(join(root, 'ui', 'assets', 'app.js'), 'console.log("' + version + '")')
        writeFileSync(join(root, 'application.json'), JSON.stringify({ name: ServeFixture.App, version, packages: [], ui: { entry: 'index.html', assets: ['assets/app.js'] } }))
    }

    public WriteLive(version: string): void
    {
        writeFileSync(join(this.Dir, ServeFixture.Tenant, 'applications', ServeFixture.App, 'live'), version)
    }

    public async Start(legacy = true): Promise<PragmaticServerHost>
    {
        const keyPath = join(this.Dir, 'key')
        writeFileSync(keyPath, randomBytes(32))
        const entries = new Map<string, TenantProvisioning>()
        entries.set(ServeFixture.Tenant, { displayName: 'Tenant One', purpose: TenantPurpose.Runtime })
        const apps = join(this.Dir, ServeFixture.Tenant, 'applications')
        if (legacy)
        {
            const ui = join(apps, ServeFixture.App, 'ui')
            mkdirSync(join(ui, 'assets'), { recursive: true })
            writeFileSync(join(ui, 'index.html'), ServeFixture.Shell)
            writeFileSync(join(ui, 'assets', 'app.js'), ServeFixture.Script)
            writeFileSync(join(apps, ServeFixture.App, 'application.json'), JSON.stringify({ name: ServeFixture.App, version: '1.0.0', packages: [], ui: { entry: 'index.html', assets: ['assets/app.js'] } }))
        }
        writeFileSync(join(apps, 'secret.txt'), ServeFixture.Secret)
        return PragmaticServerHost.StartAsync({ port: 0, baseDir: this.Dir, masterKey: { keyFilePath: keyPath }, provisioning: new InMemoryTenantProvisioning(entries) })
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }

    public static Get(port: number, path: string, method = 'GET'): Promise<Reply>
    {
        return new Promise<Reply>((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path, method }, res =>
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

test('app routes serve the shell, assets, client routes; refuse unknown and traversal; keep healthz and auth', async () =>
{
    const fixture = new ServeFixture()
    const host = await fixture.Start()
    try
    {
        const port = host.Address().port
        const base = '/app/t1/shop/'
        const shell = await ServeFixture.Get(port, base)
        assert.equal(shell.status, 200)
        assert.match(shell.type, /^text\/html/)
        assert.ok(shell.body.includes('shell'))
        assert.ok(shell.body.includes('<meta name="pragmatic-app" content="shop">'))
        assert.ok(!shell.body.includes('t1'), 'no tenant baked into the shell')

        const entry = await ServeFixture.Get(port, base + 'index.html')
        assert.equal(entry.status, 200)
        assert.match(entry.type, /^text\/html/)

        const route = await ServeFixture.Get(port, base + 'orders/42')
        assert.equal(route.status, 200)
        assert.match(route.type, /^text\/html/)

        const asset = await ServeFixture.Get(port, base + 'assets/app.js')
        assert.equal(asset.status, 200)
        assert.match(asset.type, /^text\/javascript/)
        assert.equal(asset.body, ServeFixture.Script)

        assert.equal((await ServeFixture.Get(port, '/app/t1/shop')).status, 308)
        assert.equal((await ServeFixture.Get(port, base + 'assets/missing.js')).status, 404)
        assert.equal((await ServeFixture.Get(port, '/app/t1/nope/')).status, 404)
        assert.equal((await ServeFixture.Get(port, '/app/ghost/shop/')).status, 404)
        assert.equal((await ServeFixture.Get(port, base, 'POST')).status, 405)

        for (const bad of ['/app/t1/shop/../../secret.txt', '/app/t1/shop/..%2f..%2fsecret.txt', '/app/t1/shop/%2e%2e/secret.txt', '/app/t1/shop/..%5csecret.txt', '/app/t1/shop/C:/x.js', '/app/t1/shop//etc/passwd', '/app/t1/shop/ui/../../secret.txt'])
        {
            const r = await ServeFixture.Get(port, bad)
            assert.notEqual(r.status, 200, bad)
            assert.ok(!r.body.includes(ServeFixture.Secret), bad)
        }

        assert.equal((await ServeFixture.Get(port, '/healthz')).status, 200)
        assert.equal((await ServeFixture.Get(port, '/readyz')).status, 200)
        assert.equal((await ServeFixture.Get(port, '/nope')).status, 404)
        assert.equal((await ServeFixture.Get(port, '/auth/anything')).status, 404)
        // /auth/* with ?environment= routes to AuthHttpEndpoint (method-checked JSON), not the app route or the no-tenant 404.
        const login = await ServeFixture.Get(port, '/auth/login?environment=t1')
        assert.equal(login.status, 405)
        assert.match(login.type, /^application\/json/)
    }
    finally
    {
        await host.DisposeAsync()
        fixture.Dispose()
    }
})

test('the manifest parser reads a validated ui and rejects unsafe paths', () =>
{
    const base = { name: 'a', version: '1', packages: [] }
    const ok = PragmaticAppManifestParser.Parse(JSON.stringify({ ...base, ui: { entry: 'index.html', assets: ['assets/a.js'] } }))
    assert.deepEqual(ok.ui, { entry: 'index.html', assets: ['assets/a.js'] })
    assert.equal(PragmaticAppManifestParser.Parse(JSON.stringify(base)).ui, undefined)
    for (const ui of [{ entry: '../x', assets: [] }, { entry: 'index.html', assets: ['../../s'] }, { entry: '/abs', assets: [] }, { entry: 'index.html', assets: ['C:/x'] }, { entry: 'index.html', assets: 'no' }, 'str'])
    {
        assert.throws(() => PragmaticAppManifestParser.Parse(JSON.stringify({ ...base, ui })))
    }
})

test('serving reads <app>/live then serves <app>/<version>/ui/<file> and the version manifest', async () =>
{
    const fixture = new ServeFixture()
    fixture.WriteVersion('2.0.0')
    fixture.WriteLive('2.0.0')
    const host = await fixture.Start(false)
    try
    {
        const port = host.Address().port
        const shell = await ServeFixture.Get(port, '/app/t1/shop/')
        assert.equal(shell.status, 200)
        assert.ok(shell.body.includes('shell-2.0.0'))
        const asset = await ServeFixture.Get(port, '/app/t1/shop/assets/app.js')
        assert.equal(asset.status, 200)
        assert.ok(asset.body.includes('2.0.0'))
    }
    finally
    {
        await host.DisposeAsync()
        fixture.Dispose()
    }
})

test("after re-pointing <app>/live to an earlier version, serving returns that earlier version's assets", async () =>
{
    const fixture = new ServeFixture()
    fixture.WriteVersion('1.0.0')
    fixture.WriteVersion('2.0.0')
    fixture.WriteLive('2.0.0')
    const host = await fixture.Start(false)
    try
    {
        const port = host.Address().port
        assert.ok((await ServeFixture.Get(port, '/app/t1/shop/assets/app.js')).body.includes('2.0.0'))
        fixture.WriteLive('1.0.0')
        const shell = await ServeFixture.Get(port, '/app/t1/shop/')
        assert.ok(shell.body.includes('shell-1.0.0'))
        assert.ok((await ServeFixture.Get(port, '/app/t1/shop/assets/app.js')).body.includes('1.0.0'))
    }
    finally
    {
        await host.DisposeAsync()
        fixture.Dispose()
    }
})

test('serving falls back to the legacy <app>/ui + <app>/application.json when <app>/live is absent', async () =>
{
    const fixture = new ServeFixture()
    const host = await fixture.Start()
    try
    {
        const port = host.Address().port
        const shell = await ServeFixture.Get(port, '/app/t1/shop/')
        assert.equal(shell.status, 200)
        assert.ok(shell.body.includes('shell'))
        assert.equal((await ServeFixture.Get(port, '/app/t1/shop/assets/app.js')).body, ServeFixture.Script)
    }
    finally
    {
        await host.DisposeAsync()
        fixture.Dispose()
    }
})

test('a live pointer that is not a safe segment answers 404', async () =>
{
    const fixture = new ServeFixture()
    const host = await fixture.Start()
    try
    {
        fixture.WriteLive('../x')
        assert.equal((await ServeFixture.Get(host.Address().port, '/app/t1/shop/')).status, 404)
    }
    finally
    {
        await host.DisposeAsync()
        fixture.Dispose()
    }
})
