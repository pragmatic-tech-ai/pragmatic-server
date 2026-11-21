import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { DeploymentMode, Observability, ObservabilityRole, type ServerConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { ServerBootstrap } from '../server-bootstrap.js'
import { InMemoryEnvironmentProvisioning } from '../../environments/environment-registry.js'
import type { EnvironmentProvisioning } from '../../environments/environment-provisioning.js'

class Fixtures
{
    private static readonly LoopbackHost = '127.0.0.1'

    public static Config(extra: Partial<ServerConfig> = {}): ServerConfig
    {
        return { host: '0.0.0.0', port: 8443, baseDir: '/data', masterKey: { keyFilePath: '/run/secrets/key' }, deploymentMode: DeploymentMode.Local, replicaId: 'pod-1', tls: { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' }, ...extra }
    }

    public static Provisioning(): InMemoryEnvironmentProvisioning
    {
        return new InMemoryEnvironmentProvisioning(new Map<string, EnvironmentProvisioning>())
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
