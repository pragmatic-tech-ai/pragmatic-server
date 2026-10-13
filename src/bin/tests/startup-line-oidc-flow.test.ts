import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerBootstrap } from '../server-bootstrap.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import type { ServerConfig } from '../../config/server-config.js'

class Fixtures
{
    public static readonly SecretUrl = 'redis://user:hunter2@host:6379'

    public static Config(extra: Partial<ServerConfig>): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { base64Env: 'PRAGMATIC_MASTER_KEY' }, deploymentMode: DeploymentMode.Local, ...extra }
    }
}

test('StartupLine reports oidc-flow=redis without leaking the URL', () =>
{
    const line = ServerBootstrap.StartupLine(Fixtures.Config({ redisUrl: Fixtures.SecretUrl }), 1)
    assert.match(line, /oidc-flow=redis\b/)
    assert.doesNotMatch(line, /hunter2/)
    assert.doesNotMatch(line, /redis:\/\//)
})

test('StartupLine reports oidc-flow=in-memory when no redisUrl', () =>
{
    assert.match(ServerBootstrap.StartupLine(Fixtures.Config({}), 1), /oidc-flow=in-memory\b/)
})
