import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServerHost } from '../pragmatic-server-host.js'

class AuthFixture
{
    public static readonly Host = '127.0.0.1'

    public static Start(): { identityRoot: string; packagesRoot: string; solution: string; keyEnv: string }
    {
        const identityRoot = mkdtempSync(join(tmpdir(), 'ps-id-'))
        const packagesRoot = mkdtempSync(join(tmpdir(), 'ps-pkg-'))
        const solution = mkdtempSync(join(tmpdir(), 'ps-sol-'))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        const keyEnv = 'PS_AUTH_KEY'
        process.env[keyEnv] = randomBytes(32).toString('base64')
        return { identityRoot, packagesRoot, solution, keyEnv }
    }

    public static Options(identityRoot: string, packagesRoot: string, keyEnv: string)
    {
        return {
            host: AuthFixture.Host,
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

test('a client presenting a valid service token opens the solution', async () =>
{
    const { identityRoot, packagesRoot, solution, keyEnv } = AuthFixture.Start()
    const host = await PragmaticServerHost.StartAsync(AuthFixture.Options(identityRoot, packagesRoot, keyEnv))
    const address = host.Address()
    const pack = await host.IdentityPackForTest()
    const { Token } = await pack.Tokens.Issue(host.TenantForTest(), 'svc1', [], null)
    const client = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}`, { bearerToken: Token })
    try
    {
        const summary = await client.OpenSolution(solution)
        assert.equal(summary.members.length, 1)
        await ((await host.LanguageServiceForTest()) as SolutionLanguageService).WhenIdle()
    }
    finally
    {
        await client.DisposeAsync()
        await host.DisposeAsync()
        AuthFixture.Cleanup(identityRoot, packagesRoot, solution)
        delete process.env[keyEnv]
    }
})

test('a client with no bearer is rejected at the upgrade (no connection)', async () =>
{
    const { identityRoot, packagesRoot, solution, keyEnv } = AuthFixture.Start()
    const host = await PragmaticServerHost.StartAsync(AuthFixture.Options(identityRoot, packagesRoot, keyEnv))
    const address = host.Address()
    try
    {
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}`))
    }
    finally
    {
        await host.DisposeAsync()
        AuthFixture.Cleanup(identityRoot, packagesRoot, solution)
        delete process.env[keyEnv]
    }
})

test('a client with an invalid bearer is rejected at the upgrade', async () =>
{
    const { identityRoot, packagesRoot, solution, keyEnv } = AuthFixture.Start()
    const host = await PragmaticServerHost.StartAsync(AuthFixture.Options(identityRoot, packagesRoot, keyEnv))
    const address = host.Address()
    try
    {
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}`, { bearerToken: 'not-a-real-token' }))
    }
    finally
    {
        await host.DisposeAsync()
        AuthFixture.Cleanup(identityRoot, packagesRoot, solution)
        delete process.env[keyEnv]
    }
})
