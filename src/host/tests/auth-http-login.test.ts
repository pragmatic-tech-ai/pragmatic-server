import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PresentedSecret } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServerHost } from '../pragmatic-server-host.js'

class LoginFixture
{
    public static readonly Host = '127.0.0.1'

    public static Start(): { identityRoot: string; packagesRoot: string; solution: string; keyEnv: string }
    {
        const identityRoot = mkdtempSync(join(tmpdir(), 'ps-id-'))
        const packagesRoot = mkdtempSync(join(tmpdir(), 'ps-pkg-'))
        const solution = mkdtempSync(join(tmpdir(), 'ps-sol-'))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        const keyEnv = 'PS_LOGIN_KEY'
        process.env[keyEnv] = randomBytes(32).toString('base64')
        return { identityRoot, packagesRoot, solution, keyEnv }
    }

    public static Options(identityRoot: string, packagesRoot: string, keyEnv: string)
    {
        return {
            host: LoginFixture.Host,
            port: 0,
            packagesRoot,
            identity: { identityRoot, masterKey: { base64Env: keyEnv }, tenant: { id: 't1', displayName: 'Tenant One' } },
        }
    }

    public static Cleanup(...dirs: string[]): void
    {
        for (const dir of dirs)
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

test('login mints a session token usable as a WebSocket bearer', async () =>
{
    const { identityRoot, packagesRoot, solution, keyEnv } = LoginFixture.Start()
    const host = await PragmaticServerHost.StartAsync(LoginFixture.Options(identityRoot, packagesRoot, keyEnv))
    const base = `http://${host.Address().host}:${host.Address().port}`
    const pack = await host.IdentityPackForTest()
    await pack.Registrar.Register(host.TenantForTest(), 'a@x.io', 'p1', new PresentedSecret('pw-123456'))
    try
    {
        const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@x.io', password: 'pw-123456' }) })
        assert.equal(response.status, 200)
        const payload = await response.json() as { token: string; expiresAt: string }
        assert.ok(payload.token.length > 0)

        const client = await PragmaticClient.ConnectAsync(`ws://${host.Address().host}:${host.Address().port}`, { bearerToken: payload.token })
        const summary = await client.OpenSolution(solution)
        assert.equal(summary.members.length, 1)
        await ((await host.LanguageServiceForTest()) as SolutionLanguageService).WhenIdle()
        await client.DisposeAsync()
    }
    finally
    {
        await host.DisposeAsync()
        LoginFixture.Cleanup(identityRoot, packagesRoot, solution)
        delete process.env[keyEnv]
    }
})

test('bad credentials return a generic 401', async () =>
{
    const { identityRoot, packagesRoot, solution, keyEnv } = LoginFixture.Start()
    const host = await PragmaticServerHost.StartAsync(LoginFixture.Options(identityRoot, packagesRoot, keyEnv))
    const base = `http://${host.Address().host}:${host.Address().port}`
    const pack = await host.IdentityPackForTest()
    await pack.Registrar.Register(host.TenantForTest(), 'a@x.io', 'p1', new PresentedSecret('pw-123456'))
    try
    {
        const wrong = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@x.io', password: 'WRONG' }) })
        assert.equal(wrong.status, 401)
        const unknown = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ghost@x.io', password: 'whatever' }) })
        assert.equal(unknown.status, 401)
    }
    finally
    {
        await host.DisposeAsync()
        LoginFixture.Cleanup(identityRoot, packagesRoot, solution)
        delete process.env[keyEnv]
    }
})

test('malformed body is 400; unknown route is 404; wrong method is 405', async () =>
{
    const { identityRoot, packagesRoot, solution, keyEnv } = LoginFixture.Start()
    const host = await PragmaticServerHost.StartAsync(LoginFixture.Options(identityRoot, packagesRoot, keyEnv))
    const base = `http://${host.Address().host}:${host.Address().port}`
    try
    {
        assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' })).status, 400)
        assert.equal((await fetch(`${base}/nope`)).status, 404)
        assert.equal((await fetch(`${base}/auth/login`, { method: 'GET' })).status, 405)
    }
    finally
    {
        await host.DisposeAsync()
        LoginFixture.Cleanup(identityRoot, packagesRoot, solution)
        delete process.env[keyEnv]
    }
})
