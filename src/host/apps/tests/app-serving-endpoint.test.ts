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
import { PresentedSecret } from '@pragmatic-tech-ai/todl-identity'

interface Reply
{
    status: number
    type: string
    body: string
    location: string
    csp: string
}

class ServeFixture
{
    public static readonly Tenant = 't1'
    public static readonly App = 'shop'
    public static readonly Shell = '<html><head><title>x</title></head><body>shell</body></html>'
    public static readonly Script = 'console.log(1)'
    public static readonly Secret = 'TOP-SECRET'

    public static readonly Email = 'a@x.io'
    public static readonly Password = 'pw-123456'

    public readonly Dir = mkdtempSync(join(tmpdir(), 'serve-'))
    /** The browser session cookie of the signed-in test account (Start signs in); '' for an anonymous request. */
    public Cookie = ''

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
        const host = await PragmaticServerHost.StartAsync({ port: 0, baseDir: this.Dir, masterKey: { keyFilePath: keyPath }, provisioning: new InMemoryTenantProvisioning(entries) })
        this.Cookie = await ServeFixture.SignIn(host)
        return host
    }

    /** Registers the test account and signs it in the way the sign-in page does; answers the session cookie. */
    public static async SignIn(host: PragmaticServerHost): Promise<string>
    {
        const pack = await host.IdentityPackForTest(ServeFixture.Tenant)
        await pack.Registrar.Register(await host.TenantForTest(ServeFixture.Tenant), ServeFixture.Email, 'p1', new PresentedSecret(ServeFixture.Password))
        const response = await fetch(`http://127.0.0.1:${host.Address().port}/auth/browser-login?environment=${ServeFixture.Tenant}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: ServeFixture.Email, password: ServeFixture.Password }),
        })
        assert.equal(response.status, 200)
        return (response.headers.get('set-cookie') ?? '').split(';')[0]!
    }

    /** A request carrying this fixture's session cookie. */
    public Fetch(port: number, path: string, method = 'GET'): Promise<Reply>
    {
        return ServeFixture.Get(port, path, method, this.Cookie)
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }

    public static Get(port: number, path: string, method = 'GET', cookie = ''): Promise<Reply>
    {
        return new Promise<Reply>((resolve, reject) =>
        {
            const headers = cookie === '' ? {} : { cookie }
            const req = request({ host: '127.0.0.1', port, path, method, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8'), location: String(res.headers.location ?? ''), csp: String(res.headers['content-security-policy'] ?? '') }))
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
        const shell = await fixture.Fetch(port,base)
        assert.equal(shell.status, 200)
        assert.match(shell.type, /^text\/html/)
        assert.ok(shell.body.includes('shell'))
        assert.ok(shell.body.includes('<meta name="pragmatic-app" content="shop">'))
        assert.ok(!shell.body.includes('t1'), 'no tenant baked into the shell')

        const entry = await fixture.Fetch(port,base + 'index.html')
        assert.equal(entry.status, 200)
        assert.match(entry.type, /^text\/html/)

        const route = await fixture.Fetch(port,base + 'orders/42')
        assert.equal(route.status, 200)
        assert.match(route.type, /^text\/html/)

        const asset = await fixture.Fetch(port,base + 'assets/app.js')
        assert.equal(asset.status, 200)
        assert.match(asset.type, /^text\/javascript/)
        assert.equal(asset.body, ServeFixture.Script)

        assert.equal((await fixture.Fetch(port,'/app/t1/shop')).status, 308)
        assert.equal((await fixture.Fetch(port,base + 'assets/missing.js')).status, 404)
        assert.equal((await fixture.Fetch(port,'/app/t1/nope/')).status, 404)
        assert.equal((await fixture.Fetch(port,'/app/ghost/shop/')).status, 404)
        assert.equal((await fixture.Fetch(port,base, 'POST')).status, 405)

        for (const bad of ['/app/t1/shop/../../secret.txt', '/app/t1/shop/..%2f..%2fsecret.txt', '/app/t1/shop/%2e%2e/secret.txt', '/app/t1/shop/..%5csecret.txt', '/app/t1/shop/C:/x.js', '/app/t1/shop//etc/passwd', '/app/t1/shop/ui/../../secret.txt'])
        {
            const r = await fixture.Fetch(port,bad)
            assert.notEqual(r.status, 200, bad)
            assert.ok(!r.body.includes(ServeFixture.Secret), bad)
        }

        assert.equal((await fixture.Fetch(port,'/healthz')).status, 200)
        assert.equal((await fixture.Fetch(port,'/readyz')).status, 200)
        assert.equal((await fixture.Fetch(port,'/nope')).status, 404)
        assert.equal((await fixture.Fetch(port,'/auth/anything')).status, 404)
        // /auth/* with ?environment= routes to AuthHttpEndpoint (method-checked JSON), not the app route or the no-tenant 404.
        const login = await fixture.Fetch(port,'/auth/login?environment=t1')
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
        const shell = await fixture.Fetch(port,'/app/t1/shop/')
        assert.equal(shell.status, 200)
        assert.ok(shell.body.includes('shell-2.0.0'))
        const asset = await fixture.Fetch(port,'/app/t1/shop/assets/app.js')
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
        assert.ok((await fixture.Fetch(port,'/app/t1/shop/assets/app.js')).body.includes('2.0.0'))
        fixture.WriteLive('1.0.0')
        const shell = await fixture.Fetch(port,'/app/t1/shop/')
        assert.ok(shell.body.includes('shell-1.0.0'))
        assert.ok((await fixture.Fetch(port,'/app/t1/shop/assets/app.js')).body.includes('1.0.0'))
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
        const shell = await fixture.Fetch(port,'/app/t1/shop/')
        assert.equal(shell.status, 200)
        assert.ok(shell.body.includes('shell'))
        assert.equal((await fixture.Fetch(port,'/app/t1/shop/assets/app.js')).body, ServeFixture.Script)
    }
    finally
    {
        await host.DisposeAsync()
        fixture.Dispose()
    }
})

test('a live pointer that is not a safe segment answers 404 even when an unguarded read would succeed', async () =>
{
    const fixture = new ServeFixture()
    fixture.WriteVersion('2.0.0')
    const host = await fixture.Start(false)
    try
    {
        // Unguarded, `shop/../shop/2.0.0/application.json` normalises to a real, servable manifest.
        fixture.WriteLive('../shop/2.0.0')
        assert.equal((await fixture.Fetch(host.Address().port,'/app/t1/shop/')).status, 404)
        fixture.WriteLive('2.0.0')
        assert.equal((await fixture.Fetch(host.Address().port,'/app/t1/shop/')).status, 200)
    }
    finally
    {
        await host.DisposeAsync()
        fixture.Dispose()
    }
})

test('without a session the app page redirects to the environment sign-in page; its assets still load', async () =>
{
    const fixture = new ServeFixture()
    const host = await fixture.Start()
    try
    {
        const port = host.Address().port
        for (const cookie of ['', 'ps_session=t1.not-a-live-token', 'ps_session=other.' + fixture.Cookie.split('.')[1]])
        {
            const page = await ServeFixture.Get(port, '/app/t1/shop/orders/42', 'GET', cookie)
            assert.equal(page.status, 302, cookie)
            assert.equal(page.location, '/auth/sign-in?environment=t1&return=%2Fapp%2Ft1%2Fshop%2Forders%2F42', cookie)
            assert.ok(!page.body.includes('shell'), cookie)
        }
        assert.equal((await ServeFixture.Get(port, '/app/t1/shop/assets/app.js')).status, 200)
        assert.equal((await ServeFixture.Get(port, '/app/t1/nope/')).status, 404)
        assert.equal((await fixture.Fetch(port, '/app/t1/shop/orders/42')).status, 200)
    }
    finally
    {
        await host.DisposeAsync()
        fixture.Dispose()
    }
})

test('the sign-in page is a locked-down form that returns only to a same-origin path', async () =>
{
    const fixture = new ServeFixture()
    const host = await fixture.Start()
    try
    {
        const port = host.Address().port
        const page = await ServeFixture.Get(port, '/auth/sign-in?environment=t1&return=%2Fapp%2Ft1%2Fshop%2F')
        assert.equal(page.status, 200)
        assert.match(page.type, /^text\/html/)
        assert.match(page.csp, /default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'/)
        assert.ok(page.body.includes('data-login="/auth/browser-login?environment=t1"'))
        assert.ok(page.body.includes('data-return="/app/t1/shop/"'))
        assert.ok(page.body.includes('type="password"'))
        for (const bad of ['https%3A%2F%2Fevil.example%2F', '%2F%2Fevil.example', '%2F%5Cevil.example', 'app%2Ft1', '%2F%22%3E%3Cscript%3E'])
        {
            const other = await ServeFixture.Get(port, '/auth/sign-in?environment=t1&return=' + bad)
            assert.equal(other.status, 200, bad)
            assert.ok(!other.body.includes('evil.example'), bad)
            assert.ok(!other.body.includes('"><script>'), bad)
        }
        assert.equal((await ServeFixture.Get(port, '/auth/sign-in?environment=t1', 'POST')).status, 405)
    }
    finally
    {
        await host.DisposeAsync()
        fixture.Dispose()
    }
})
