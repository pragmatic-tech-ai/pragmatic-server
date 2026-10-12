import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class HealthFixture
{
    public static Provisioning(): InMemoryTenantProvisioning
    {
        const entries = new Map<string, TenantProvisioning>()
        entries.set('t1', { displayName: 'Tenant One' })
        return new InMemoryTenantProvisioning(entries)
    }

    public static async Get(port: number, path: string): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
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

test('a started host answers /healthz and /readyz with 200', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'ph8-health-'))
    const keyPath = join(dir, 'key')
    writeFileSync(keyPath, randomBytes(32))
    const host = await PragmaticServerHost.StartAsync({ port: 0, baseDir: dir, masterKey: { keyFilePath: keyPath }, provisioning: HealthFixture.Provisioning() })
    try
    {
        const port = host.Address().port
        assert.equal(await HealthFixture.Get(port, '/healthz'), 200)
        assert.equal(await HealthFixture.Get(port, '/readyz'), 200)
    }
    finally
    {
        await host.DisposeAsync()
        rmSync(dir, { recursive: true, force: true })
    }
})

test('an unknown path without a tenant hint still 404s (health does not shadow it)', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'ph8-health-'))
    const keyPath = join(dir, 'key')
    writeFileSync(keyPath, randomBytes(32))
    const host = await PragmaticServerHost.StartAsync({ port: 0, baseDir: dir, masterKey: { keyFilePath: keyPath }, provisioning: HealthFixture.Provisioning() })
    try
    {
        assert.equal(await HealthFixture.Get(host.Address().port, '/nope'), 404)
    }
    finally
    {
        await host.DisposeAsync()
        rmSync(dir, { recursive: true, force: true })
    }
})
