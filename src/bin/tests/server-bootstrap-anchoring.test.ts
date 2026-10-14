import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerBootstrap } from '../server-bootstrap.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import type { ServerConfig } from '../../config/server-config.js'

class AnchorStartupFixture
{
    public static CloudConfig(extra: Partial<ServerConfig>): ServerConfig
    {
        return { host: '127.0.0.1', port: 8080, baseDir: '/tmp', masterKey: { keyFilePath: 'k' }, deploymentMode: DeploymentMode.Cloud, ...extra } as ServerConfig
    }
}

test('startup line shows audit-anchor=on when a ref is set, never the ref value', () =>
{
    const line = ServerBootstrap.StartupLine(AnchorStartupFixture.CloudConfig({ cloudAuditAnchorKeyRef: 'cluster/anchor-key' }), 1)
    assert.match(line, /audit-anchor=on/)
    assert.ok(!line.includes('cluster/anchor-key'))
})

test('startup line shows audit-anchor=off when no ref is set', () =>
{
    const line = ServerBootstrap.StartupLine(AnchorStartupFixture.CloudConfig({}), 0)
    assert.match(line, /audit-anchor=off/)
})
