import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkerHost } from '../worker-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import type { MachineTlsRef } from '../machine-tls.js'
import type { IInFlightSource } from '../../observability/drain-controller.js'

class Fixture
{
    private static readonly Dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tls')
    public static readonly KeyEnv = 'PS_WHD_KEY'

    public static Tls(): MachineTlsRef
    {
        return { certFile: join(Fixture.Dir, 'server.pem'), keyFile: join(Fixture.Dir, 'server.key'), caFile: join(Fixture.Dir, 'ca.pem') }
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([['t1', { displayName: 'T1' }]]))
    }

    public static Get(port: number, path: string): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, res =>
            {
                res.resume()
                resolve(res.statusCode ?? 0)
            })
            req.on('error', reject)
            req.end()
        })
    }
}

test('worker /readyz flips to 503 before close while in-flight is held, and the drain is bounded', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-whd-'))
    process.env[Fixture.KeyEnv] = randomBytes(32).toString('base64')
    const worker = await WorkerHost.StartAsync({ port: 0, baseDir, masterKey: { base64Env: Fixture.KeyEnv }, provisioning: Fixture.Provisioning(), tls: Fixture.Tls(), healthPort: 0, drainTimeoutMs: 80 })
    const held: IInFlightSource = { InFlight: () => 1 }
    worker.SetDrainSourceForTest(held)
    const healthPort = worker.HealthAddressForTest().port
    try
    {
        assert.equal(await Fixture.Get(healthPort, '/readyz'), 200)
        const disposing = worker.DisposeAsync()
        await new Promise<void>(resolve => setTimeout(resolve, 30))
        assert.equal(await Fixture.Get(healthPort, '/readyz'), 503)
        await disposing
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[Fixture.KeyEnv]
    }
})

test('worker DisposeAsync is idempotent: concurrent calls share one promise', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-whd-'))
    process.env[Fixture.KeyEnv] = randomBytes(32).toString('base64')
    const worker = await WorkerHost.StartAsync({ port: 0, baseDir, masterKey: { base64Env: Fixture.KeyEnv }, provisioning: Fixture.Provisioning(), tls: Fixture.Tls() })
    try
    {
        const first = worker.DisposeAsync()
        const second = worker.DisposeAsync()
        assert.equal(first, second)
        await first
    }
    finally
    {
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[Fixture.KeyEnv]
    }
})
