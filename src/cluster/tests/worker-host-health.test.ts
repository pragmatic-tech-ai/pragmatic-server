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

class Fixture
{
    private static readonly Dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tls')
    public static readonly KeyEnv = 'PS_WHH_KEY'

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

test('a worker serves /healthz + /readyz on its dedicated plain-HTTP health port (Review Focus 5)', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-whh-'))
    process.env[Fixture.KeyEnv] = randomBytes(32).toString('base64')
    const worker = await WorkerHost.StartAsync({ port: 0, baseDir, masterKey: { base64Env: Fixture.KeyEnv }, provisioning: Fixture.Provisioning(), tls: Fixture.Tls(), healthPort: 0 })
    try
    {
        assert.equal(await Fixture.Get(worker.HealthAddressForTest().port, '/healthz'), 200)
        assert.equal(await Fixture.Get(worker.HealthAddressForTest().port, '/readyz'), 200)
    }
    finally
    {
        await worker.DisposeAsync()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[Fixture.KeyEnv]
    }
})
