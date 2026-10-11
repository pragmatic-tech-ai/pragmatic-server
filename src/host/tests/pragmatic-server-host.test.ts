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
import type { PragmaticServerHostOptions } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class HostFixture
{
    private static readonly PackagesPrefix = 'ps-pkgs-'
    public static readonly KeyEnv = 'PS_HOST_KEY'
    private static readonly LoopbackHost = '127.0.0.1'

    public static readonly Host = HostFixture.LoopbackHost

    public static SolutionDir(baseDir: string): string
    {
        const dir = join(baseDir, 't1', 'solution')
        mkdirSync(join(baseDir, 't1'), { recursive: true })
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

    public static Options(baseDir: string): PragmaticServerHostOptions
    {
        process.env[HostFixture.KeyEnv] = randomBytes(32).toString('base64')
        const entries = new Map<string, TenantProvisioning>([['t1', { displayName: 'Tenant One' }]])
        return { host: HostFixture.Host, port: 0, baseDir, masterKey: { base64Env: HostFixture.KeyEnv }, provisioning: new InMemoryTenantProvisioning(entries) }
    }

    public static async Token(host: PragmaticServerHost): Promise<string>
    {
        const pack = await host.IdentityPackForTest('t1')
        await pack.Grants.Save(new Grant('svc1', Role.Admin, new ResourceRef(ResourceKind.Tenant, 't1', [])))
        const issued = await pack.Tokens.Issue(await host.TenantForTest('t1'), 'svc1', [], null)
        return issued.Token
    }
}

test('a loopback client opens the fixture solution over a real WebSocket', async () =>
{
    const baseDir = HostFixture.PackagesDir()
    const solution = HostFixture.SolutionDir(baseDir)
    const host = await PragmaticServerHost.StartAsync(HostFixture.Options(baseDir))
    const address = host.Address()
    const client = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}/?tenant=t1`, { bearerToken: await HostFixture.Token(host) })
    try
    {
        const summary = await client.OpenSolution(solution)
        assert.equal(summary.members.length, 1)
        await ((await host.LanguageServiceForTest('t1')) as SolutionLanguageService).WhenIdle()
    }
    finally
    {
        await client.DisposeAsync()
        await host.DisposeAsync()
        HostFixture.Cleanup(baseDir)
        delete process.env[HostFixture.KeyEnv]
    }
})

test('a graph change pushes to two connected clients', async () =>
{
    const baseDir = HostFixture.PackagesDir()
    const host = await PragmaticServerHost.StartAsync(HostFixture.Options(baseDir))
    const address = host.Address()
    const token = await HostFixture.Token(host)
    const first = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}/?tenant=t1`, { bearerToken: token })
    const second = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}/?tenant=t1`, { bearerToken: token })
    let firstPushes = 0
    let secondPushes = 0
    first.OnGraphChanged(() => { firstPushes += 1 })
    second.OnGraphChanged(() => { secondPushes += 1 })
    try
    {
        await first.ActiveSolution()
        await second.ActiveSolution()
        const languageService = await host.LanguageServiceForTest('t1')
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
        HostFixture.Cleanup(baseDir)
        delete process.env[HostFixture.KeyEnv]
    }
})
