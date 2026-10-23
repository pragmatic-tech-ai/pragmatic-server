import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class Probe
{
    public static Get(port: number, path: string): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path }, res =>
            {
                res.resume()
                resolve(res.statusCode ?? 0)
            })
            req.on('error', reject)
            req.end()
        })
    }

    public static Upgrade(port: number, path: string): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })
            req.on('response', res =>
            {
                res.resume()
                resolve(res.statusCode ?? 0)
            })
            req.on('upgrade', res =>
            {
                res.socket.destroy()
                resolve(res.statusCode ?? 0)
            })
            req.on('error', reject)
            req.end()
        })
    }
}

test('readyz is 200 after a clean start and healthz is 200', async () =>
{
    const provisioning = new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>())
    const host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir: 'C:/tmp/ro-test', masterKey: { base64Env: 'PRAGMATIC_MASTER_KEY' }, provisioning })
    try
    {
        assert.equal(await Probe.Get(host.Address().port, '/readyz'), 200)
        assert.equal(await Probe.Get(host.Address().port, '/healthz'), 200)
    }
    finally
    {
        await host.DisposeAsync()
    }
})

test('an upgrade for an owned-elsewhere tenant is rejected with a retryable 503', async () =>
{
    const provisioning = new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([['acme', { displayName: 'Acme' }]]))
    const host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir: 'C:/tmp/ro-test', masterKey: { base64Env: 'PRAGMATIC_MASTER_KEY' }, provisioning })
    try
    {
        host.RegistryForTest().SetOwnershipForTest(false)
        assert.equal(await Probe.Upgrade(host.Address().port, '/?environment=acme'), 503)
    }
    finally
    {
        await host.DisposeAsync()
    }
})

test('readyz is 503 when ownership is unhealthy (Redis-down fail-closed)', async () =>
{
    const provisioning = new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>())
    const host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir: 'C:/tmp/ro-test', masterKey: { base64Env: 'PRAGMATIC_MASTER_KEY' }, provisioning })
    try
    {
        host.RegistryForTest().SetOwnershipForTest(true, false)
        assert.equal(await Probe.Get(host.Address().port, '/readyz'), 503)
        assert.equal(await Probe.Get(host.Address().port, '/healthz'), 200)
    }
    finally
    {
        await host.DisposeAsync()
    }
})

test('an HTTP request for an owned-elsewhere tenant returns a retryable 503', async () =>
{
    const provisioning = new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([['acme', { displayName: 'Acme' }]]))
    const host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir: 'C:/tmp/ro-test', masterKey: { base64Env: 'PRAGMATIC_MASTER_KEY' }, provisioning })
    try
    {
        host.RegistryForTest().SetOwnershipForTest(false)
        assert.equal(await Probe.Get(host.Address().port, '/auth?environment=acme'), 503)
    }
    finally
    {
        await host.DisposeAsync()
    }
})
