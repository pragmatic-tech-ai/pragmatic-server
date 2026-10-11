import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PresentedSecret, Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class LoginFixture
{
    public static readonly Host = '127.0.0.1'

    public static Start(): { baseDir: string; solution: string; keyEnv: string }
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-base-'))
        const solution = join(baseDir, 't1', 'solution')
        mkdirSync(join(baseDir, 't1'), { recursive: true })
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        const keyEnv = 'PS_LOGIN_KEY'
        process.env[keyEnv] = randomBytes(32).toString('base64')
        return { baseDir, solution, keyEnv }
    }

    public static Options(baseDir: string, keyEnv: string)
    {
        const entries = new Map<string, TenantProvisioning>([['t1', { displayName: 'Tenant One' }]])
        return { host: LoginFixture.Host, port: 0, baseDir, masterKey: { base64Env: keyEnv }, provisioning: new InMemoryTenantProvisioning(entries) }
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
    const { baseDir, solution, keyEnv } = LoginFixture.Start()
    const host = await PragmaticServerHost.StartAsync(LoginFixture.Options(baseDir, keyEnv))
    const base = `http://${host.Address().host}:${host.Address().port}`
    const pack = await host.IdentityPackForTest('t1')
    await pack.Registrar.Register(await host.TenantForTest('t1'), 'a@x.io', 'p1', new PresentedSecret('pw-123456'))
    await pack.Grants.Save(new Grant('p1', Role.Admin, new ResourceRef(ResourceKind.Tenant, 't1', [])))
    try
    {
        const response = await fetch(`${base}/auth/login?tenant=t1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@x.io', password: 'pw-123456' }) })
        assert.equal(response.status, 200)
        const payload = await response.json() as { token: string; expiresAt: string }
        assert.ok(payload.token.length > 0)

        const client = await PragmaticClient.ConnectAsync(`ws://${host.Address().host}:${host.Address().port}/?tenant=t1`, { bearerToken: payload.token })
        const summary = await client.OpenSolution(solution)
        assert.equal(summary.members.length, 1)
        await ((await host.LanguageServiceForTest('t1')) as SolutionLanguageService).WhenIdle()
        await client.DisposeAsync()
    }
    finally
    {
        await host.DisposeAsync()
        LoginFixture.Cleanup(baseDir)
        delete process.env[keyEnv]
    }
})

test('bad credentials return a generic 401', async () =>
{
    const { baseDir, solution, keyEnv } = LoginFixture.Start()
    const host = await PragmaticServerHost.StartAsync(LoginFixture.Options(baseDir, keyEnv))
    const base = `http://${host.Address().host}:${host.Address().port}`
    const pack = await host.IdentityPackForTest('t1')
    await pack.Registrar.Register(await host.TenantForTest('t1'), 'a@x.io', 'p1', new PresentedSecret('pw-123456'))
    try
    {
        const wrong = await fetch(`${base}/auth/login?tenant=t1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@x.io', password: 'WRONG' }) })
        assert.equal(wrong.status, 401)
        const unknown = await fetch(`${base}/auth/login?tenant=t1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ghost@x.io', password: 'whatever' }) })
        assert.equal(unknown.status, 401)
    }
    finally
    {
        await host.DisposeAsync()
        LoginFixture.Cleanup(baseDir)
        delete process.env[keyEnv]
    }
})

test('malformed body is 400; unknown route is 404; wrong method is 405', async () =>
{
    const { baseDir, solution, keyEnv } = LoginFixture.Start()
    const host = await PragmaticServerHost.StartAsync(LoginFixture.Options(baseDir, keyEnv))
    const base = `http://${host.Address().host}:${host.Address().port}`
    try
    {
        assert.equal((await fetch(`${base}/auth/login?tenant=t1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' })).status, 400)
        assert.equal((await fetch(`${base}/nope?tenant=t1`)).status, 404)
        assert.equal((await fetch(`${base}/auth/login?tenant=t1`, { method: 'GET' })).status, 405)
    }
    finally
    {
        await host.DisposeAsync()
        LoginFixture.Cleanup(baseDir)
        delete process.env[keyEnv]
    }
})

test('oversized body is 400; body missing password is 400', async () =>
{
    const { baseDir, solution, keyEnv } = LoginFixture.Start()
    const host = await PragmaticServerHost.StartAsync(LoginFixture.Options(baseDir, keyEnv))
    const base = `http://${host.Address().host}:${host.Address().port}`
    try
    {
        const oversized = JSON.stringify({ email: 'a@x.io', password: 'x'.repeat(5000) })
        assert.equal((await fetch(`${base}/auth/login?tenant=t1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: oversized })).status, 400)
        assert.equal((await fetch(`${base}/auth/login?tenant=t1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@x.io' }) })).status, 400)
    }
    finally
    {
        await host.DisposeAsync()
        LoginFixture.Cleanup(baseDir)
        delete process.env[keyEnv]
    }
})
