import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticCluster } from '../pragmatic-cluster.js'
import type { WorkerHost } from '../worker-host.js'
import type { MachineTlsRef } from '../machine-tls.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class ClusterFixture
{
    public static readonly Host = '127.0.0.1'
    public static readonly KeyEnv = 'PS_CLUSTER_KEY'

    public static TlsRef(): MachineTlsRef
    {
        const dir = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'tls')
        return { certFile: join(dir, 'server.pem'), keyFile: join(dir, 'server.key'), caFile: join(dir, 'ca.pem') }
    }

    public static Start(...tenantIds: string[]): { baseDir: string }
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-cl-'))
        const fixture = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution')
        for (const id of tenantIds)
        {
            mkdirSync(join(baseDir, id), { recursive: true })
            cpSync(fixture, join(baseDir, id, 'solution'), { recursive: true })
        }
        process.env[ClusterFixture.KeyEnv] = randomBytes(32).toString('base64')
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
        return { host: ClusterFixture.Host, port: 0, baseDir, masterKey: { base64Env: ClusterFixture.KeyEnv }, provisioning, tls: ClusterFixture.TlsRef() }
    }

    public static async TokenFor(worker: WorkerHost, tenantId: string): Promise<string>
    {
        const server = await worker.RegistryForTest().ServerFor(tenantId)
        const pack = await server.Pack()
        await pack.Grants.Save(new Grant(tenantId, Role.Admin, new ResourceRef(ResourceKind.Tenant, tenantId, [])))
        return (await pack.Tokens.Issue(server.Tenant(), tenantId, [], null)).Token
    }

    public static Cleanup(baseDir: string): void
    {
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[ClusterFixture.KeyEnv]
    }
}

test('two tenants through the gateway each open only their own solution', async () =>
{
    const { baseDir } = ClusterFixture.Start('t1', 't2')
    const cluster = await PragmaticCluster.StartAsync(ClusterFixture.Options(baseDir, ClusterFixture.Provisioning('t1', 't2')))
    const addr = cluster.Address()
    try
    {
        const token1 = await ClusterFixture.TokenFor(cluster.WorkerForTest(), 't1')
        const token2 = await ClusterFixture.TokenFor(cluster.WorkerForTest(), 't2')
        const c1 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=t1`, { bearerToken: token1 })
        const c2 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=t2`, { bearerToken: token2 })
        try
        {
            const sum1 = await c1.OpenSolution(join(baseDir, 't1', 'solution'))
            const sum2 = await c2.OpenSolution(join(baseDir, 't2', 'solution'))
            assert.equal(sum1.members.length, 1)
            assert.equal(sum2.members.length, 1)
            await ((await (await cluster.WorkerForTest().RegistryForTest().ServerFor('t1')).LanguageService()) as SolutionLanguageService).WhenIdle()
            await ((await (await cluster.WorkerForTest().RegistryForTest().ServerFor('t2')).LanguageService()) as SolutionLanguageService).WhenIdle()
        }
        finally
        {
            await c1.DisposeAsync()
            await c2.DisposeAsync()
        }
    }
    finally
    {
        await cluster.DisposeAsync()
        ClusterFixture.Cleanup(baseDir)
    }
})

test('a GraphChanged push on t1 reaches t1 client and not t2 (relay + isolation)', async () =>
{
    const { baseDir } = ClusterFixture.Start('t1', 't2')
    const cluster = await PragmaticCluster.StartAsync(ClusterFixture.Options(baseDir, ClusterFixture.Provisioning('t1', 't2')))
    const addr = cluster.Address()
    try
    {
        const token1 = await ClusterFixture.TokenFor(cluster.WorkerForTest(), 't1')
        const token2 = await ClusterFixture.TokenFor(cluster.WorkerForTest(), 't2')
        const c1 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=t1`, { bearerToken: token1 })
        const c2 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=t2`, { bearerToken: token2 })
        let t1Pushes = 0
        let t2Pushes = 0
        c1.OnGraphChanged(() => { t1Pushes += 1 })
        c2.OnGraphChanged(() => { t2Pushes += 1 })
        try
        {
            await c1.OpenSolution(join(baseDir, 't1', 'solution'))
            await c2.OpenSolution(join(baseDir, 't2', 'solution'))
            const ls1 = (await (await cluster.WorkerForTest().RegistryForTest().ServerFor('t1')).LanguageService()) as SolutionLanguageService
            const ls2 = (await (await cluster.WorkerForTest().RegistryForTest().ServerFor('t2')).LanguageService()) as SolutionLanguageService
            await ls1.WhenIdle()
            await ls2.WhenIdle()
            await new Promise(resolve => setTimeout(resolve, 100))
            t1Pushes = 0
            t2Pushes = 0
            ls1.GraphChanged.emit({ memberIds: ['m'], fileIds: ['f'] })
            await new Promise(resolve => setTimeout(resolve, 100))
            assert.ok(t1Pushes >= 1)
            assert.equal(t2Pushes, 0)
        }
        finally
        {
            await c1.DisposeAsync()
            await c2.DisposeAsync()
        }
    }
    finally
    {
        await cluster.DisposeAsync()
        ClusterFixture.Cleanup(baseDir)
    }
})

test('a t1 token presented with ?tenant=t2 is rejected at the gateway', async () =>
{
    const { baseDir } = ClusterFixture.Start('t1', 't2')
    const cluster = await PragmaticCluster.StartAsync(ClusterFixture.Options(baseDir, ClusterFixture.Provisioning('t1', 't2')))
    const addr = cluster.Address()
    try
    {
        const token1 = await ClusterFixture.TokenFor(cluster.WorkerForTest(), 't1')
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=t2`, { bearerToken: token1 }))
    }
    finally
    {
        await cluster.DisposeAsync()
        ClusterFixture.Cleanup(baseDir)
    }
})

test('a missing tenant hint is rejected at the gateway', async () =>
{
    const { baseDir } = ClusterFixture.Start('t1')
    const cluster = await PragmaticCluster.StartAsync(ClusterFixture.Options(baseDir, ClusterFixture.Provisioning('t1')))
    const addr = cluster.Address()
    try
    {
        const token1 = await ClusterFixture.TokenFor(cluster.WorkerForTest(), 't1')
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/`, { bearerToken: token1 }))
    }
    finally
    {
        await cluster.DisposeAsync()
        ClusterFixture.Cleanup(baseDir)
    }
})

test('a CRLF-injected tenant hint is rejected and the gateway keeps serving valid tenants', async () =>
{
    const { baseDir } = ClusterFixture.Start('t1')
    const cluster = await PragmaticCluster.StartAsync(ClusterFixture.Options(baseDir, ClusterFixture.Provisioning('t1')))
    const addr = cluster.Address()
    try
    {
        const token1 = await ClusterFixture.TokenFor(cluster.WorkerForTest(), 't1')
        await assert.rejects(() => PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=a%0d%0ab`, { bearerToken: token1 }))
        const c1 = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=t1`, { bearerToken: token1 })
        try
        {
            const sum = await c1.OpenSolution(join(baseDir, 't1', 'solution'))
            assert.equal(sum.members.length, 1)
            await ((await (await cluster.WorkerForTest().RegistryForTest().ServerFor('t1')).LanguageService()) as SolutionLanguageService).WhenIdle()
        }
        finally
        {
            await c1.DisposeAsync()
        }
    }
    finally
    {
        await cluster.DisposeAsync()
        ClusterFixture.Cleanup(baseDir)
    }
})
