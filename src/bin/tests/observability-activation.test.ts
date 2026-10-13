import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { ServerBootstrap } from '../server-bootstrap.js'
import { Observability, ObservabilityRole } from '../../observability/observability.js'
import { OtlpProtocol } from '../../observability/otlp-protocol.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { ServerConfig } from '../../config/server-config.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class Fixtures
{
    private static readonly LoopbackHost = '127.0.0.1'

    public static Config(extra: Partial<ServerConfig> = {}): ServerConfig
    {
        return { host: '0.0.0.0', port: 8443, baseDir: '/data', masterKey: { keyFilePath: '/run/secrets/key' }, deploymentMode: DeploymentMode.Local, replicaId: 'pod-1', tls: { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' }, ...extra }
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>())
    }

    public static async FreePort(): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const server = createServer()
            server.once('error', reject)
            server.listen(0, Fixtures.LoopbackHost, () =>
            {
                const port = (server.address() as { port: number }).port
                server.close(() => resolve(port))
            })
        })
    }
}

test('ObservabilityOptions is undefined when otel is off', () =>
{
    assert.equal(ServerBootstrap.ObservabilityOptions(Fixtures.Config(), ObservabilityRole.Host), undefined)
})

test('ObservabilityOptions maps fields and role when enabled', () =>
{
    const config = Fixtures.Config({ serviceName: 'svc', metricsPort: 9100, otlpEndpoint: 'http://collector:4318', otlpProtocol: OtlpProtocol.HttpProtobuf, otlpMetrics: true, traceSampling: 0.5 })
    const o = ServerBootstrap.ObservabilityOptions(config, ObservabilityRole.Worker)
    assert.deepEqual(o, { role: ObservabilityRole.Worker, serviceName: 'svc', replicaId: 'pod-1', metricsPort: 9100, otlpEndpoint: 'http://collector:4318', otlpProtocol: OtlpProtocol.HttpProtobuf, otlpMetrics: true, traceSampling: 0.5 })
})

test('ObservabilityOptions replicaId argument overrides config', () =>
{
    const o = ServerBootstrap.ObservabilityOptions(Fixtures.Config({ metricsPort: 9100 }), ObservabilityRole.Host, 'other')
    assert.equal(o?.replicaId, 'other')
})

test('ComposeOptions and ComposeWorkerOptions thread observability through', async () =>
{
    const port = await Fixtures.FreePort()
    const obs = Observability.Start({ role: ObservabilityRole.Host, metricsPort: port })
    try
    {
        assert.equal(ServerBootstrap.ComposeOptions(Fixtures.Config(), Fixtures.Provisioning(), undefined, undefined, undefined, obs).observability, obs)
        assert.equal(ServerBootstrap.ComposeWorkerOptions(Fixtures.Config(), Fixtures.Provisioning(), undefined, undefined, undefined, obs).observability, obs)
    }
    finally
    {
        await obs.Shutdown()
    }
})

test('Compose* leave observability undefined when not passed', () =>
{
    assert.equal(ServerBootstrap.ComposeOptions(Fixtures.Config(), Fixtures.Provisioning()).observability, undefined)
    assert.equal(ServerBootstrap.ComposeWorkerOptions(Fixtures.Config(), Fixtures.Provisioning()).observability, undefined)
})

test('Observability started from mapped options shuts down cleanly', async () =>
{
    const port = await Fixtures.FreePort()
    const opts = ServerBootstrap.ObservabilityOptions(Fixtures.Config({ metricsPort: port }), ObservabilityRole.Host)
    assert.ok(opts)
    await Observability.Start(opts).Shutdown()
})
