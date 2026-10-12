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
    public static readonly Tenant = 't1'

    public static ServerTls(): MachineTlsRef
    {
        const dir = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'tls')
        return { certFile: join(dir, 'server.pem'), keyFile: join(dir, 'server.key'), caFile: join(dir, 'ca.pem') }
    }

    public static ClientTls(): MachineTlsRef
    {
        const dir = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'tls')
        return { certFile: join(dir, 'client.pem'), keyFile: join(dir, 'client.key'), caFile: join(dir, 'ca.pem') }
    }

    public static Seed(): string
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-clmi-'))
        const solution = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution')
        mkdirSync(join(baseDir, Fixture.Tenant), { recursive: true })
        cpSync(solution, join(baseDir, Fixture.Tenant, 'solution'), { recursive: true })
        process.env[Fixture.KeyEnv] = randomBytes(32).toString('base64')
        return baseDir
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([[Fixture.Tenant, { displayName: Fixture.Tenant }]]))
    }

    public static async Worker(baseDir: string, port: number, url: string): Promise<WorkerHost>
    {
        return WorkerHost.StartAsync({ host: Fixture.Host, port, baseDir, masterKey: { base64Env: Fixture.KeyEnv }, provisioning: Fixture.Provisioning(), tls: Fixture.ServerTls(), redisUrl: url, advertise: { host: Fixture.Host, port } })
    }

    public static async Token(worker: WorkerHost): Promise<string>
    {
        const server = await worker.RegistryForTest().ServerFor(Fixture.Tenant)
        const pack = await server.Pack()
        await pack.Grants.Save(new Grant(Fixture.Tenant, Role.Admin, new ResourceRef(ResourceKind.Tenant, Fixture.Tenant, [])))
        return (await pack.Tokens.Issue(server.Tenant(), Fixture.Tenant, [], null)).Token
    }

    public static async OpenAndCheck(addr: { host: string, port: number }, baseDir: string, token: string): Promise<void>
    {
        const client = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=${Fixture.Tenant}`, { bearerToken: token })
        try
        {
            const sum = await client.OpenSolution(join(baseDir, Fixture.Tenant, 'solution'))
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
    const baseDir = Fixture.Seed()
    const router = new RedisWorkerRouter(url)
    const workerA = await Fixture.Worker(baseDir, Fixture.PortA, url)
    const gateway = await Gateway.StartAsync({ host: Fixture.Host, port: 0, router, tls: Fixture.ClientTls(), serverName: Fixture.Host })
    const addr = gateway.Address()
    let workerB: WorkerHost | null = null
    try
    {
        const token = await Fixture.Token(workerA)
        // 1) Only A is live: the client is served through the gateway + real redis router.
        await Fixture.OpenAndCheck(addr, baseDir, token)
        // 2) Bring up B, stop A: A unregisters + releases its ownership lease.
        workerB = await Fixture.Worker(baseDir, Fixture.PortB, url)
        await workerA.DisposeAsync()
        // 3) Reconnect: the router re-homes t1 to B (A no longer live), B acquires ownership and serves.
        await Fixture.OpenAndCheck(addr, baseDir, token)
    }
    finally
    {
        await gateway.DisposeAsync()
        await router.Drain()
        await workerA.DisposeAsync().catch(() => {})
        if (workerB !== null)
        {
            await workerB.DisposeAsync()
        }
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[Fixture.KeyEnv]
    }
})
