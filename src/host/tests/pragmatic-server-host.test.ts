import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import type { PragmaticServerHostOptions } from '../pragmatic-server-host.js'

class HostFixture
{
    private static readonly SolutionPrefix = 'ps-sol-'
    private static readonly PackagesPrefix = 'ps-pkgs-'
    public static readonly KeyEnv = 'PS_HOST_KEY'
    private static readonly LoopbackHost = '127.0.0.1'

    public static readonly Host = HostFixture.LoopbackHost

    public static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), HostFixture.SolutionPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), dir, { recursive: true })
        return dir
    }

    public static PackagesDir(): string
    {
        return mkdtempSync(join(tmpdir(), HostFixture.PackagesPrefix))
    }

    public static Cleanup(dir: string): void
    {
        rmSync(dir, { recursive: true, force: true })
    }

    public static Options(packages: string, identityRoot: string): PragmaticServerHostOptions
    {
        process.env[HostFixture.KeyEnv] = randomBytes(32).toString('base64')
        return {
            host: HostFixture.Host,
            port: 0,
            packagesRoot: packages,
            identity: { identityRoot, masterKey: { base64Env: HostFixture.KeyEnv }, tenant: { id: 't1', displayName: 'Tenant One' } },
        }
    }

    public static async Token(host: PragmaticServerHost): Promise<string>
    {
        const pack = await host.IdentityPackForTest()
        const issued = await pack.Tokens.Issue(host.TenantForTest(), 'svc1', [], null)
        return issued.Token
    }
}

test('a loopback client opens the fixture solution over a real WebSocket', async () =>
{
    const packages = HostFixture.PackagesDir()
    const solution = HostFixture.SolutionDir()
    const identity = HostFixture.PackagesDir()
    const host = await PragmaticServerHost.StartAsync(HostFixture.Options(packages, identity))
    const address = host.Address()
    const client = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}`, { bearerToken: await HostFixture.Token(host) })
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
        HostFixture.Cleanup(solution)
        HostFixture.Cleanup(packages)
        HostFixture.Cleanup(identity)
        delete process.env[HostFixture.KeyEnv]
    }
})

test('a graph change pushes to two connected clients', async () =>
{
    const packages = HostFixture.PackagesDir()
    const identity = HostFixture.PackagesDir()
    const host = await PragmaticServerHost.StartAsync(HostFixture.Options(packages, identity))
    const address = host.Address()
    const token = await HostFixture.Token(host)
    const first = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}`, { bearerToken: token })
    const second = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}`, { bearerToken: token })
    let firstPushes = 0
    let secondPushes = 0
    first.OnGraphChanged(() => { firstPushes += 1 })
    second.OnGraphChanged(() => { secondPushes += 1 })
    try
    {
        await first.ActiveSolution()
        await second.ActiveSolution()
        const languageService = await host.LanguageServiceForTest()
        languageService.GraphChanged.emit({ memberIds: ['m'], fileIds: ['f'] })
        await new Promise(resolve => setTimeout(resolve, 50))
        assert.equal(firstPushes, 1)
        assert.equal(secondPushes, 1)
    }
    finally
    {
        await first.DisposeAsync()
        await second.DisposeAsync()
        await host.DisposeAsync()
        HostFixture.Cleanup(packages)
        HostFixture.Cleanup(identity)
        delete process.env[HostFixture.KeyEnv]
    }
})
