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

class AuthzFixture
{
    public static readonly Host = '127.0.0.1'

    public static TenantRoot(): ResourceRef
    {
        return new ResourceRef(ResourceKind.Tenant, 't1', [])
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
        const entries = new Map<string, TenantProvisioning>([['t1', { displayName: 'Tenant One' }]])
        return { host: AuthzFixture.Host, port: 0, baseDir, masterKey: { base64Env: keyEnv }, provisioning: new InMemoryTenantProvisioning(entries) }
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
    const url = `ws://${host.Address().host}:${host.Address().port}/?tenant=t1`
    const pack = await host.IdentityPackForTest('t1')
    const tenant = await host.TenantForTest('t1')
    await pack.Grants.Save(new Grant('admin', Role.Admin, AuthzFixture.TenantRoot()))
    await pack.Grants.Save(new Grant('viewer', Role.Viewer, AuthzFixture.TenantRoot()))
    const adminToken = (await pack.Tokens.Issue(tenant, 'admin', [], null)).Token
    const viewerToken = (await pack.Tokens.Issue(tenant, 'viewer', [], null)).Token
    const nograntToken = (await pack.Tokens.Issue(tenant, 'nobody', [], null)).Token

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
    const url = `ws://${host.Address().host}:${host.Address().port}/?tenant=t1`
    const pack = await host.IdentityPackForTest('t1')
    const tenant = await host.TenantForTest('t1')
    await pack.Grants.Save(new Grant('admin', Role.Admin, AuthzFixture.TenantRoot()))
    const adminToken = (await pack.Tokens.Issue(tenant, 'admin', [], null)).Token
    const nograntToken = (await pack.Tokens.Issue(tenant, 'nobody', [], null)).Token

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
