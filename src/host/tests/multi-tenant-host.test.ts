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
import type { IdentityStoreSet } from '@pragmatic-tech-ai/todl-identity'
import { NodePlatform } from '../../platform/node-platform.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'

class RecordingPlatform extends NodePlatform
{
    public identityRoots: string[] = []

    public override CreateIdentityStores(identityRoot: string, masterKey: Buffer): Promise<IdentityStoreSet>
    {
        this.identityRoots.push(identityRoot)
        return super.CreateIdentityStores(identityRoot, masterKey)
    }
}

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
        const c1 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?environment=t1`, { bearerToken: token1 })
        const c2 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?environment=t2`, { bearerToken: token2 })
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

test('a token minted by tenant t1 presented with ?environment=t2 is rejected', async () =>
{
    const { baseDir } = MtFixture.Start('t1', 't2')
    const host = await PragmaticServerHost.StartAsync(MtFixture.Options(baseDir, MtFixture.Provisioning('t1', 't2')))
    const addr = host.Address()
    try
    {
        const token1 = await MtFixture.TokenFor(host, 't1')
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?environment=t2`, { bearerToken: token1 }))
        assert.equal(host.HandlerCountForTest(), 0)
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
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?environment=ghost`, { bearerToken: token1 }))
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/`, { bearerToken: token1 }))
        assert.equal(host.HandlerCountForTest(), 0)
    }
    finally
    {
        await host.DisposeAsync()
        MtFixture.Cleanup(baseDir)
    }
})

test('closing the only connection releases the tenant so an idle sweep evicts it', async () =>
{
    const { baseDir } = MtFixture.Start('t1')
    const host = await PragmaticServerHost.StartAsync(MtFixture.Options(baseDir, MtFixture.Provisioning('t1')))
    const addr = host.Address()
    try
    {
        const token1 = await MtFixture.TokenFor(host, 't1')
        const before = await host.RegistryForTest().ServerFor('t1')
        const c1 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?environment=t1`, { bearerToken: token1 })
        await c1.OpenSolution(join(baseDir, 't1', 'solution'))
        await ((await host.LanguageServiceForTest('t1')) as SolutionLanguageService).WhenIdle()
        await c1.DisposeAsync()
        await new Promise(resolve => setTimeout(resolve, 50))
        await host.RegistryForTest().EvictIdle(Date.now(), 0)
        const after = await host.RegistryForTest().ServerFor('t1')
        assert.notStrictEqual(after, before)
    }
    finally
    {
        await host.DisposeAsync()
        MtFixture.Cleanup(baseDir)
    }
})

test('a platform passed in the host options is forwarded into the per-tenant server', async () =>
{
    const { baseDir } = MtFixture.Start('t1')
    const platform = new RecordingPlatform()
    const host = await PragmaticServerHost.StartAsync({ ...MtFixture.Options(baseDir, MtFixture.Provisioning('t1')), platform })
    try
    {
        await host.IdentityPackForTest('t1')
        assert.equal(platform.identityRoots.length, 1)
        assert.ok(platform.identityRoots[0].includes('t1'))
    }
    finally
    {
        await host.DisposeAsync()
        MtFixture.Cleanup(baseDir)
    }
})

test('deploymentMode threads through the host: Cloud without a platform bundle fails closed', async () =>
{
    const { baseDir } = MtFixture.Start('t1')
    const host = await PragmaticServerHost.StartAsync({ ...MtFixture.Options(baseDir, MtFixture.Provisioning('t1')), deploymentMode: DeploymentMode.Cloud })
    try
    {
        await assert.rejects(() => host.IdentityPackForTest('t1'), /explicit platform bundle/)
    }
    finally
    {
        await host.DisposeAsync()
        MtFixture.Cleanup(baseDir)
    }
})
