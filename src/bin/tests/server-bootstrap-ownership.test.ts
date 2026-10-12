import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerBootstrap } from '../server-bootstrap.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import type { ServerConfig } from '../../config/server-config.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class Fixtures
{
    public static Config(extra: Partial<ServerConfig>): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { base64Env: 'PRAGMATIC_MASTER_KEY' }, deploymentMode: DeploymentMode.Local, ...extra }
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>())
    }
}

test('ComposeOptions carries redisUrl and replicaId through', () =>
{
    const options = ServerBootstrap.ComposeOptions(Fixtures.Config({ redisUrl: 'redis://host:6379', replicaId: 'pod-1' }), Fixtures.Provisioning())
    assert.equal(options.redisUrl, 'redis://host:6379')
    assert.equal(options.replicaId, 'pod-1')
})

test('StartupLine reports ownership mode without leaking the URL', () =>
{
    const redis = ServerBootstrap.StartupLine(Fixtures.Config({ redisUrl: 'redis://user:secret@host:6379' }), 3)
    assert.match(redis, /ownership=redis/)
    assert.doesNotMatch(redis, /secret/)
    assert.doesNotMatch(redis, /redis:\/\//)
    const local = ServerBootstrap.StartupLine(Fixtures.Config({}), 1)
    assert.match(local, /ownership=in-memory/)
})
