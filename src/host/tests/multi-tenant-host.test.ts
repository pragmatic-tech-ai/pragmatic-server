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

class MtFixture
{
    public static readonly Host = '127.0.0.1'
    public static readonly KeyEnv = 'PS_MT_KEY'

    public static Start(...tenantIds: string[]): { baseDir: string }
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-mt-'))
        const fixture = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution')
        for (const id of tenantIds)
        {
            mkdirSync(join(baseDir, id), { recursive: true })
            cpSync(fixture, join(baseDir, id, 'solution'), { recursive: true })
        }
        process.env[MtFixture.KeyEnv] = randomBytes(32).toString('base64')
        return { baseDir }
    }

    public static Provisioning(...tenantIds: string[]): InMemoryTenantProvisioning
    {
        const entries = new Map<string, TenantProvisioning>()
        for (const id of tenantIds)
        {
            entries.set(id, { displayName: id })
        }
        return new InMemoryTenantProvisioning(entries)
    }

    public static Options(baseDir: string, provisioning: InMemoryTenantProvisioning)
    {
        return { host: MtFixture.Host, port: 0, baseDir, masterKey: { base64Env: MtFixture.KeyEnv }, provisioning }
    }

    public static async TokenFor(host: PragmaticServerHost, tenantId: string): Promise<string>
    {
        const pack = await host.IdentityPackForTest(tenantId)
        await pack.Grants.Save(new Grant(tenantId, Role.Admin, new ResourceRef(ResourceKind.Tenant, tenantId, [])))
        const tenant = await host.TenantForTest(tenantId)
        return (await pack.Tokens.Issue(tenant, tenantId, [], null)).Token
    }

    public static Cleanup(baseDir: string): void
    {
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[MtFixture.KeyEnv]
    }
}

test('two tenants connect by hint and each opens only its own solution', async () =>
{
    const { baseDir } = MtFixture.Start('t1', 't2')
    const host = await PragmaticServerHost.StartAsync(MtFixture.Options(baseDir, MtFixture.Provisioning('t1', 't2')))
    const addr = host.Address()
    try
    {
        const token1 = await MtFixture.TokenFor(host, 't1')
        const token2 = await MtFixture.TokenFor(host, 't2')
        const c1 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=t1`, { bearerToken: token1 })
        const c2 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=t2`, { bearerToken: token2 })
        try
        {
            const sum1 = await c1.OpenSolution(join(baseDir, 't1', 'solution'))
            const sum2 = await c2.OpenSolution(join(baseDir, 't2', 'solution'))
            assert.equal(sum1.members.length, 1)
            assert.equal(sum2.members.length, 1)
            await ((await host.LanguageServiceForTest('t1')) as SolutionLanguageService).WhenIdle()
            await ((await host.LanguageServiceForTest('t2')) as SolutionLanguageService).WhenIdle()
        }
        finally
        {
            await c1.DisposeAsync()
            await c2.DisposeAsync()
        }
    }
    finally
    {
        await host.DisposeAsync()
        MtFixture.Cleanup(baseDir)
    }
})

test('a token minted by tenant t1 presented with ?tenant=t2 is rejected', async () =>
{
    const { baseDir } = MtFixture.Start('t1', 't2')
    const host = await PragmaticServerHost.StartAsync(MtFixture.Options(baseDir, MtFixture.Provisioning('t1', 't2')))
    const addr = host.Address()
    try
    {
        const token1 = await MtFixture.TokenFor(host, 't1')
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=t2`, { bearerToken: token1 }))
    }
    finally
    {
        await host.DisposeAsync()
        MtFixture.Cleanup(baseDir)
    }
})

test('an unprovisioned or missing tenant hint is rejected', async () =>
{
    const { baseDir } = MtFixture.Start('t1')
    const host = await PragmaticServerHost.StartAsync(MtFixture.Options(baseDir, MtFixture.Provisioning('t1')))
    const addr = host.Address()
    try
    {
        const token1 = await MtFixture.TokenFor(host, 't1')
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=ghost`, { bearerToken: token1 }))
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/`, { bearerToken: token1 }))
    }
    finally
    {
        await host.DisposeAsync()
        MtFixture.Cleanup(baseDir)
    }
})
