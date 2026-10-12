import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { ServerConfigLoader } from '../server-config-loader.js'

class Env
{
    public static Minimal(): Record<string, string | undefined>
    {
        return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_FILE: '/run/secrets/key', PRAGMATIC_TENANT_ID: 't1' }
    }

    public static NoRead(path: string): string
    {
        throw new Error(`unexpected read: ${path}`)
    }
}

test('loads defaults for host/port/mode when only required values are present', () =>
{
    const config = ServerConfigLoader.Load(Env.Minimal(), Env.NoRead)
    assert.equal(config.host, '0.0.0.0')
    assert.equal(config.port, 8080)
    assert.equal(config.deploymentMode, DeploymentMode.Local)
    assert.equal(config.baseDir, '/data')
    assert.deepEqual(config.masterKey, { keyFilePath: '/run/secrets/key' })
    assert.deepEqual(config.singleTenant, { id: 't1', displayName: 't1' })
    assert.equal(config.tenantsFile, undefined)
})

test('prefers a tenants file over single-tenant env when both present', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_TENANTS_FILE: '/cfg/tenants.json' }
    const config = ServerConfigLoader.Load(env, Env.NoRead)
    assert.equal(config.tenantsFile, '/cfg/tenants.json')
})

test('reads base64 env master key ref', () =>
{
    const env = { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_B64_ENV: 'PRAGMATIC_KEY', PRAGMATIC_TENANT_ID: 't1' }
    const config = ServerConfigLoader.Load(env, Env.NoRead)
    assert.deepEqual(config.masterKey, { base64Env: 'PRAGMATIC_KEY' })
})

test('fails closed when baseDir is missing', () =>
{
    const env = { PRAGMATIC_MASTER_KEY_FILE: '/k', PRAGMATIC_TENANT_ID: 't1' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /PRAGMATIC_BASE_DIR/)
})

test('fails closed when no master key ref is given', () =>
{
    const env = { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_TENANT_ID: 't1' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /master key/)
})

test('fails closed when neither tenants file nor tenant id is given', () =>
{
    const env = { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_FILE: '/k' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /tenant/)
})

test('a thrown error never echoes a secret-looking env value', () =>
{
    const env = { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_B64_ENV: 'K', K: 'SUPER_SECRET_VALUE' }
    try
    {
        ServerConfigLoader.Load(env, Env.NoRead)
        assert.fail('expected throw')
    }
    catch (error)
    {
        assert.ok(!String(error).includes('SUPER_SECRET_VALUE'))
    }
})

test('merges an optional JSON config file, with env overriding file', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_CONFIG_FILE: '/cfg/server.json', PRAGMATIC_PORT: '9000' }
    const read = (path: string): string => path === '/cfg/server.json' ? JSON.stringify({ port: 7000, idleTtlMs: 123 }) : Env.NoRead(path)
    const config = ServerConfigLoader.Load(env, read)
    assert.equal(config.port, 9000)
    assert.equal(config.idleTtlMs, 123)
})

test('fails closed on an invalid deployment mode', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_DEPLOYMENT_MODE: 'staging' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /local or cloud/)
})
