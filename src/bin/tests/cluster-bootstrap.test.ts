import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode, type ServerConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { ServerBootstrap } from '../server-bootstrap.js'
import { InMemoryEnvironmentProvisioning } from '../../environments/environment-registry.js'
import type { EnvironmentProvisioning } from '../../environments/environment-provisioning.js'
import type { PlatformServices } from '../../platform/platform-services.js'

class Fixture
{
    public static Config(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8443, baseDir: '/data', masterKey: { keyFilePath: '/run/secrets/key' }, deploymentMode: DeploymentMode.Local, redisUrl: 'redis://user:secret@r:6379', replicaId: 'pod-1', tls: { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' }, workerAdvertiseHost: 'w.internal', workerAdvertisePort: 8443, healthPort: 8081 }
    }

    public static Provisioning(): InMemoryEnvironmentProvisioning
    {
        return new InMemoryEnvironmentProvisioning(new Map<string, EnvironmentProvisioning>())
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

test('the worker startup line never leaks the redis URL or TLS key path', () =>
{
    const w = ServerBootstrap.WorkerStartupLine(Fixture.Config())
    assert.ok(!w.includes('secret'))
    assert.ok(!w.includes('/k.pem'))
    assert.ok(w.includes('8443'))
})

test('ComposeWorkerOptions fails closed in cloud mode without a platform, and threads one through when given', () =>
{
    const config: ServerConfig = { ...Fixture.Config(), deploymentMode: DeploymentMode.Cloud }
    assert.throws(() => ServerBootstrap.ComposeWorkerOptions(config, Fixture.Provisioning()), /cloud/i)
    const platform = {} as PlatformServices
    assert.equal(ServerBootstrap.ComposeWorkerOptions(config, Fixture.Provisioning(), platform).platform, platform)
})
