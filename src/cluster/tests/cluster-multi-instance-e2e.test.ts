import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { WorkerHost } from '../worker-host.js'
import { Gateway } from '../gateway.js'
import { RedisWorkerRouter } from '../redis-worker-router.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import type { MachineTlsRef } from '../machine-tls.js'

class Fixture
{
    public static readonly Host = '127.0.0.1'
    public static readonly KeyEnv = 'PS_CL_MI_KEY'
    public static readonly RedisEnv = 'PRAGMATIC_TEST_REDIS_URL'
    public static readonly PortA = 17101
    public static readonly PortB = 17102

    private static Dir(): string
    {
        return join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'tls')
    }

    public static ServerTls(): MachineTlsRef
    {
        const dir = Fixture.Dir()
        return { certFile: join(dir, 'server.pem'), keyFile: join(dir, 'server.key'), caFile: join(dir, 'ca.pem') }
    }

    public static ClientTls(): MachineTlsRef
    {
        const dir = Fixture.Dir()
        return { certFile: join(dir, 'client.pem'), keyFile: join(dir, 'client.key'), caFile: join(dir, 'ca.pem') }
    }

    public static Seed(tenant: string): string
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-clmi-'))
        const solution = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution')
        mkdirSync(join(baseDir, tenant), { recursive: true })
        cpSync(solution, join(baseDir, tenant, 'solution'), { recursive: true })
        process.env[Fixture.KeyEnv] = randomBytes(32).toString('base64')
        return baseDir
    }

    public static Provisioning(tenant: string): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([[tenant, { displayName: tenant }]]))
    }

    public static async Worker(baseDir: string, port: number, url: string, tenant: string): Promise<WorkerHost>
    {
        return WorkerHost.StartAsync({ host: Fixture.Host, port, baseDir, masterKey: { base64Env: Fixture.KeyEnv }, provisioning: Fixture.Provisioning(tenant), tls: Fixture.ServerTls(), redisUrl: url, advertise: { host: Fixture.Host, port } })
    }

    public static async Token(worker: WorkerHost, tenant: string): Promise<string>
    {
        const server = await worker.RegistryForTest().ServerFor(tenant)
        const pack = await server.Pack()
        await pack.Grants.Save(new Grant(tenant, Role.Admin, new ResourceRef(ResourceKind.Tenant, tenant, [])))
        return (await pack.Tokens.Issue(server.Tenant(), tenant, [], null)).Token
    }

    public static async OpenAndCheck(addr: { host: string, port: number }, baseDir: string, token: string, tenant: string): Promise<void>
    {
        const client = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=${tenant}`, { bearerToken: token })
        try
        {
            const sum = await client.OpenSolution(join(baseDir, tenant, 'solution'))
            assert.equal(sum.members.length, 1)
        }
        finally
        {
            await client.DisposeAsync()
        }
    }
}

test('gated-live: the gateway routes a tenant to a live worker over mTLS, and re-homes when that worker stops', async t =>
{
    const url = process.env[Fixture.RedisEnv]
    if (url === undefined)
    {
        t.skip('PRAGMATIC_TEST_REDIS_URL not set')
        return
    }
    const tenant = 't-' + randomBytes(6).toString('hex')
    const baseDir = Fixture.Seed(tenant)
    let router: RedisWorkerRouter | null = null
    let workerA: WorkerHost | null = null
    let workerB: WorkerHost | null = null
    let gateway: Gateway | null = null
    try
    {
        router = new RedisWorkerRouter(url)
        workerA = await Fixture.Worker(baseDir, Fixture.PortA, url, tenant)
        gateway = await Gateway.StartAsync({ host: Fixture.Host, port: 0, router, tls: Fixture.ClientTls(), serverName: Fixture.Host })
        const addr = gateway.Address()
        const token = await Fixture.Token(workerA, tenant)
        // 1) Only A is live: the client is served through the gateway + real redis router.
        await Fixture.OpenAndCheck(addr, baseDir, token, tenant)
        // 2) Bring up B, stop A: A unregisters + releases its ownership lease.
        workerB = await Fixture.Worker(baseDir, Fixture.PortB, url, tenant)
        await workerA.DisposeAsync()
        // 3) Reconnect: the router re-homes the tenant to B (A no longer live), B acquires ownership and serves.
        await Fixture.OpenAndCheck(addr, baseDir, token, tenant)
    }
    finally
    {
        await gateway?.DisposeAsync().catch(() => {})
        await router?.Drain().catch(() => {})
        await workerA?.DisposeAsync().catch(() => {})
        await workerB?.DisposeAsync().catch(() => {})
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[Fixture.KeyEnv]
    }
})
