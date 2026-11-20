import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryEnvironmentProvisioning } from '../../environments/environment-registry.js'
import type { EnvironmentProvisioning } from '../../environments/environment-provisioning.js'

class AuthzFixture
{
    public static readonly Host = '127.0.0.1'

    public static EnvironmentRoot(): ResourceRef
    {
        return new ResourceRef(ResourceKind.Realm, 't1', [])
    }

    public static Start(): { baseDir: string; solution: string; keyEnv: string }
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-base-'))
        const solution = join(baseDir, 't1', 'solution')
        mkdirSync(join(baseDir, 't1'), { recursive: true })
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        const keyEnv = 'PS_AUTHZ_KEY'
        process.env[keyEnv] = randomBytes(32).toString('base64')
        return { baseDir, solution, keyEnv }
    }

    public static Options(baseDir: string, keyEnv: string)
    {
        const entries = new Map<string, EnvironmentProvisioning>([['t1', { displayName: 'Environment One' }]])
        return { host: AuthzFixture.Host, port: 0, baseDir, masterKey: { base64Env: keyEnv }, provisioning: new InMemoryEnvironmentProvisioning(entries) }
    }

    public static Cleanup(...dirs: string[]): void
    {
        for (const dir of dirs)
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

test('the dispatch gate enforces the role ladder for open vs read', async () =>
{
    const { baseDir, solution, keyEnv } = AuthzFixture.Start()
    const host = await PragmaticServerHost.StartAsync(AuthzFixture.Options(baseDir, keyEnv))
    const url = `ws://${host.Address().host}:${host.Address().port}/?environment=t1`
    const pack = await host.IdentityPackForTest('t1')
    const environment = await host.RealmForTest('t1')
    await pack.Grants.Save(new Grant('admin', Role.Admin, AuthzFixture.EnvironmentRoot()))
    await pack.Grants.Save(new Grant('viewer', Role.Viewer, AuthzFixture.EnvironmentRoot()))
    const adminToken = (await pack.Tokens.Issue(environment, 'admin', [], null)).Token
    const viewerToken = (await pack.Tokens.Issue(environment, 'viewer', [], null)).Token
    const nograntToken = (await pack.Tokens.Issue(environment, 'nobody', [], null)).Token

    const admin = await PragmaticClient.ConnectAsync(url, { bearerToken: adminToken })
    const viewer = await PragmaticClient.ConnectAsync(url, { bearerToken: viewerToken })
    const nobody = await PragmaticClient.ConnectAsync(url, { bearerToken: nograntToken })
    try
    {
        const summary = await admin.OpenSolution(solution)
        assert.equal(summary.members.length, 1)
        await ((await host.LanguageServiceForTest('t1')) as SolutionLanguageService).WhenIdle()

        assert.ok((await viewer.ActiveSolution()) !== null)
        await assert.rejects(() => viewer.OpenSolution(solution))

        await assert.rejects(() => nobody.ActiveSolution())
    }
    finally
    {
        await admin.DisposeAsync()
        await viewer.DisposeAsync()
        await nobody.DisposeAsync()
        await host.DisposeAsync()
        AuthzFixture.Cleanup(baseDir)
        delete process.env[keyEnv]
    }
})

test('graph-change pushes reach a readable connection but not a no-grant one', async () =>
{
    const { baseDir, solution, keyEnv } = AuthzFixture.Start()
    const host = await PragmaticServerHost.StartAsync(AuthzFixture.Options(baseDir, keyEnv))
    const url = `ws://${host.Address().host}:${host.Address().port}/?environment=t1`
    const pack = await host.IdentityPackForTest('t1')
    const environment = await host.RealmForTest('t1')
    await pack.Grants.Save(new Grant('admin', Role.Admin, AuthzFixture.EnvironmentRoot()))
    const adminToken = (await pack.Tokens.Issue(environment, 'admin', [], null)).Token
    const nograntToken = (await pack.Tokens.Issue(environment, 'nobody', [], null)).Token

    const admin = await PragmaticClient.ConnectAsync(url, { bearerToken: adminToken })
    const nobody = await PragmaticClient.ConnectAsync(url, { bearerToken: nograntToken })
    let adminPushes = 0
    let nobodyPushes = 0
    admin.OnGraphChanged(() => { adminPushes += 1 })
    nobody.OnGraphChanged(() => { nobodyPushes += 1 })
    try
    {
        const languageService = await host.LanguageServiceForTest('t1')
        languageService.GraphChanged.emit({ memberIds: ['m'], fileIds: ['f'] })
        await new Promise(resolve => setTimeout(resolve, 50))
        assert.equal(adminPushes, 1)
        assert.equal(nobodyPushes, 0)
    }
    finally
    {
        await admin.DisposeAsync()
        await nobody.DisposeAsync()
        await host.DisposeAsync()
        AuthzFixture.Cleanup(baseDir)
        delete process.env[keyEnv]
    }
})
