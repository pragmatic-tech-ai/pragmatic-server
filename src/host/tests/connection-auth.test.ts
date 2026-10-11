import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class AuthFixture
{
    public static readonly Host = '127.0.0.1'

    public static Start(): { baseDir: string; solution: string; keyEnv: string }
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-base-'))
        const solution = join(baseDir, 't1', 'solution')
        mkdirSync(join(baseDir, 't1'), { recursive: true })
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        const keyEnv = 'PS_AUTH_KEY'
        process.env[keyEnv] = randomBytes(32).toString('base64')
        return { baseDir, solution, keyEnv }
    }

    public static Options(baseDir: string, keyEnv: string)
    {
        const entries = new Map<string, TenantProvisioning>([['t1', { displayName: 'Tenant One' }]])
        return { host: AuthFixture.Host, port: 0, baseDir, masterKey: { base64Env: keyEnv }, provisioning: new InMemoryTenantProvisioning(entries) }
    }

    public static Cleanup(...dirs: string[]): void
    {
        for (const dir of dirs)
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

test('a client presenting a valid service token opens the solution', async () =>
{
    const { baseDir, solution, keyEnv } = AuthFixture.Start()
    const host = await PragmaticServerHost.StartAsync(AuthFixture.Options(baseDir, keyEnv))
    const address = host.Address()
    const pack = await host.IdentityPackForTest('t1')
    await pack.Grants.Save(new Grant('svc1', Role.Admin, new ResourceRef(ResourceKind.Tenant, 't1', [])))
    const { Token } = await pack.Tokens.Issue(await host.TenantForTest('t1'), 'svc1', [], null)
    let client: PragmaticClient | undefined
    try
    {
        client = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}/?tenant=t1`, { bearerToken: Token })
        const summary = await client.OpenSolution(solution)
        assert.equal(summary.members.length, 1)
        await ((await host.LanguageServiceForTest('t1')) as SolutionLanguageService).WhenIdle()
    }
    finally
    {
        await client?.DisposeAsync()
        await host.DisposeAsync()
        AuthFixture.Cleanup(baseDir)
        delete process.env[keyEnv]
    }
})

test('a client with no bearer is rejected at the upgrade (no connection)', async () =>
{
    const { baseDir, solution, keyEnv } = AuthFixture.Start()
    const host = await PragmaticServerHost.StartAsync(AuthFixture.Options(baseDir, keyEnv))
    const address = host.Address()
    try
    {
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}/?tenant=t1`))
        assert.equal(host.HandlerCountForTest(), 0)
    }
    finally
    {
        await host.DisposeAsync()
        AuthFixture.Cleanup(baseDir)
        delete process.env[keyEnv]
    }
})

test('a client with an invalid bearer is rejected at the upgrade', async () =>
{
    const { baseDir, solution, keyEnv } = AuthFixture.Start()
    const host = await PragmaticServerHost.StartAsync(AuthFixture.Options(baseDir, keyEnv))
    const address = host.Address()
    try
    {
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}/?tenant=t1`, { bearerToken: 'not-a-real-token' }))
        assert.equal(host.HandlerCountForTest(), 0)
    }
    finally
    {
        await host.DisposeAsync()
        AuthFixture.Cleanup(baseDir)
        delete process.env[keyEnv]
    }
})
