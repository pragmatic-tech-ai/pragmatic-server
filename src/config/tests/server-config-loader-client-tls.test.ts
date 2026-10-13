import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'
import { ServerBootstrap } from '../../bin/server-bootstrap.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import type { MachineTlsRef } from '../../cluster/machine-tls.js'
import type { GatewayConfig, ServerConfig } from '../server-config.js'

class Env
{
    public static Base(): Record<string, string | undefined>
    {
        return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_B64_ENV: 'PRAGMATIC_MASTER_KEY', PRAGMATIC_TENANT_ID: 'acme' }
    }

    public static NoFile(_p: string): string
    {
        throw new Error('no file')
    }
}

test('client TLS absent -> clientTls undefined', () =>
{
    const config = ServerConfigLoader.Load(Env.Base(), Env.NoFile)
    assert.equal(config.clientTls, undefined)
})

test('client TLS complete -> clientTls populated', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_CLIENT_TLS_CERT_FILE: '/c', PRAGMATIC_CLIENT_TLS_KEY_FILE: '/k', PRAGMATIC_CLIENT_TLS_CA_FILE: '/ca' }
    const config = ServerConfigLoader.Load(env, Env.NoFile)
    assert.deepEqual(config.clientTls, { certFile: '/c', keyFile: '/k', caFile: '/ca' })
})

test('client TLS partial (cert without key) fails closed naming the missing piece', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_CLIENT_TLS_CERT_FILE: '/c', PRAGMATIC_CLIENT_TLS_CA_FILE: '/ca' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoFile), /client TLS key/)
})

class Fixtures
{
    public static readonly Secret: MachineTlsRef = { certFile: '/secret/cert.pem', keyFile: '/secret/key.pem', caFile: '/secret/ca.pem' }

    public static Server(clientTls: MachineTlsRef | undefined): ServerConfig
    {
        return { host: '127.0.0.1', port: 1, baseDir: '/data', masterKey: { keyFilePath: '/k' }, deploymentMode: DeploymentMode.Local, clientTls }
    }

    public static Gateway(clientTls: MachineTlsRef | undefined): GatewayConfig
    {
        return { host: '127.0.0.1', port: 1, tls: Fixtures.Secret, redisUrl: 'redis://x', clientTls }
    }

    public static GatewayEnv(): Record<string, string | undefined>
    {
        return { PRAGMATIC_TLS_CERT_FILE: '/c', PRAGMATIC_TLS_KEY_FILE: '/k', PRAGMATIC_TLS_CA_FILE: '/ca', PRAGMATIC_REDIS_URL: 'redis://x' }
    }
}

test('StartupLine reports client-mtls=on without leaking paths', () =>
{
    const line = ServerBootstrap.StartupLine(Fixtures.Server(Fixtures.Secret), 1)
    assert.match(line, /client-mtls=on\b/)
    assert.ok(!line.includes('/secret/'))
    assert.doesNotMatch(line, /cert\.pem|key\.pem|ca\.pem/)
})

test('StartupLine reports client-mtls=off when unset', () =>
{
    assert.match(ServerBootstrap.StartupLine(Fixtures.Server(undefined), 1), /client-mtls=off\b/)
})

test('GatewayStartupLine reports on/off without leaking paths', () =>
{
    const on = ServerBootstrap.GatewayStartupLine(Fixtures.Gateway(Fixtures.Secret))
    assert.match(on, /client-mtls=on\b/)
    assert.ok(!on.includes('/secret/'))
    assert.doesNotMatch(on, /cert\.pem|key\.pem|ca\.pem/)
    assert.match(ServerBootstrap.GatewayStartupLine(Fixtures.Gateway(undefined)), /client-mtls=off\b/)
})

test('LoadGateway threads clientTls when present and leaves it undefined when absent', () =>
{
    const env = { ...Fixtures.GatewayEnv(), PRAGMATIC_CLIENT_TLS_CERT_FILE: '/cc', PRAGMATIC_CLIENT_TLS_KEY_FILE: '/ck', PRAGMATIC_CLIENT_TLS_CA_FILE: '/cca' }
    assert.deepEqual(ServerConfigLoader.LoadGateway(env).clientTls, { certFile: '/cc', keyFile: '/ck', caFile: '/cca' })
    assert.equal(ServerConfigLoader.LoadGateway(Fixtures.GatewayEnv()).clientTls, undefined)
})
