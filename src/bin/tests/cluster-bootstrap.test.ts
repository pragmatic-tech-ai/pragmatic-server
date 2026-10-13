import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { ServerBootstrap } from '../server-bootstrap.js'
import { InMemoryWorkerRouter } from '../../cluster/worker-router.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { ServerConfig, GatewayConfig } from '../../config/server-config.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import type { PlatformServices } from '../../platform/platform-services.js'

class Fixture
{
    public static Config(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8443, baseDir: '/data', masterKey: { keyFilePath: '/run/secrets/key' }, deploymentMode: DeploymentMode.Local, redisUrl: 'redis://user:secret@r:6379', replicaId: 'pod-1', tls: { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' }, workerAdvertiseHost: 'w.internal', workerAdvertisePort: 8443, healthPort: 8081 }
    }

    public static Gateway(): GatewayConfig
    {
        return { host: '0.0.0.0', port: 8080, tls: { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' }, redisUrl: 'redis://user:secret@r:6379', workerServerName: 'pragmatic-worker', healthPort: 8081 }
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>())
    }
}

test('ComposeWorkerOptions maps TLS, redis, advertise and health through', () =>
{
    const o = ServerBootstrap.ComposeWorkerOptions(Fixture.Config(), Fixture.Provisioning())
    assert.deepEqual(o.tls, { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' })
    assert.equal(o.redisUrl, 'redis://user:secret@r:6379')
    assert.equal(o.replicaId, 'pod-1')
    assert.deepEqual(o.advertise, { host: 'w.internal', port: 8443 })
    assert.equal(o.healthPort, 8081)
    assert.equal(o.port, 8443)
})

test('ComposeWorkerOptions throws when TLS is absent (a worker requires mTLS)', () =>
{
    const config = { ...Fixture.Config() }
    delete (config as { tls?: unknown }).tls
    assert.throws(() => ServerBootstrap.ComposeWorkerOptions(config, Fixture.Provisioning()), /tls/i)
})

test('ComposeGatewayOptions maps the gateway config + router + server name', () =>
{
    const router = new InMemoryWorkerRouter({ host: 'x', port: 1 })
    const o = ServerBootstrap.ComposeGatewayOptions(Fixture.Gateway(), router)
    assert.equal(o.port, 8080)
    assert.equal(o.serverName, 'pragmatic-worker')
    assert.equal(o.router, router)
    assert.deepEqual(o.tls, { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' })
})

test('the worker and gateway startup lines never leak the redis URL or TLS key path', () =>
{
    const w = ServerBootstrap.WorkerStartupLine(Fixture.Config())
    assert.ok(!w.includes('secret'))
    assert.ok(!w.includes('/k.pem'))
    assert.ok(w.includes('8443'))
    const g = ServerBootstrap.GatewayStartupLine(Fixture.Gateway())
    assert.ok(!g.includes('secret'))
    assert.ok(!g.includes('/k.pem'))
    assert.ok(!g.includes('redis://'))
    assert.ok(g.includes('8080'))
})

test('ComposeWorkerOptions fails closed in cloud mode without a platform, and threads one through when given', () =>
{
    const config: ServerConfig = { ...Fixture.Config(), deploymentMode: DeploymentMode.Cloud }
    assert.throws(() => ServerBootstrap.ComposeWorkerOptions(config, Fixture.Provisioning()), /cloud/i)
    const platform = {} as PlatformServices
    assert.equal(ServerBootstrap.ComposeWorkerOptions(config, Fixture.Provisioning(), platform).platform, platform)
})
