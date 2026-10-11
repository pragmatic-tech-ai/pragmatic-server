import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServerHost } from '../pragmatic-server-host.js'

class HostFixture
{
    private static readonly SolutionPrefix = 'ps-sol-'
    private static readonly PackagesPrefix = 'ps-pkgs-'
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
}

test('a loopback client opens the fixture solution over a real WebSocket', async () =>
{
    const packages = HostFixture.PackagesDir()
    const solution = HostFixture.SolutionDir()
    const host = await PragmaticServerHost.StartAsync({ host: HostFixture.Host, port: 0, packagesRoot: packages })
    const address = host.Address()
    const client = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}`)
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
    }
})

test('a graph change pushes to two connected clients', async () =>
{
    const packages = HostFixture.PackagesDir()
    const host = await PragmaticServerHost.StartAsync({ host: HostFixture.Host, port: 0, packagesRoot: packages })
    const address = host.Address()
    const first = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}`)
    const second = await PragmaticClient.ConnectAsync(`ws://${address.host}:${address.port}`)
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
    }
})
