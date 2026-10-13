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

test('drainTimeoutMs defaults to 25000 when unset', () =>
{
    const config = ServerConfigLoader.Load(Env.Minimal(), Env.NoRead)
    assert.equal(config.drainTimeoutMs, 25000)
})

test('drainTimeoutMs parses a positive integer from PRAGMATIC_DRAIN_TIMEOUT_MS', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_DRAIN_TIMEOUT_MS: '40000' }
    assert.equal(ServerConfigLoader.Load(env, Env.NoRead).drainTimeoutMs, 40000)
})

test('drainTimeoutMs fails closed on a non-integer value', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_DRAIN_TIMEOUT_MS: 'soon' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /PRAGMATIC_DRAIN_TIMEOUT_MS/)
})

test('drainTimeoutMs fails closed on a non-positive value', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_DRAIN_TIMEOUT_MS: '0' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /PRAGMATIC_DRAIN_TIMEOUT_MS/)
})

test('the gateway loader also defaults drainTimeoutMs to 25000', () =>
{
    const env = {
        PRAGMATIC_TLS_CERT_FILE: '/c', PRAGMATIC_TLS_KEY_FILE: '/k', PRAGMATIC_TLS_CA_FILE: '/a',
        PRAGMATIC_REDIS_URL: 'redis://127.0.0.1:6379',
    }
    assert.equal(ServerConfigLoader.LoadGateway(env).drainTimeoutMs, 25000)
})

test('the gateway loader fails closed on a non-integer drainTimeoutMs', () =>
{
    const env = {
        PRAGMATIC_TLS_CERT_FILE: '/c', PRAGMATIC_TLS_KEY_FILE: '/k', PRAGMATIC_TLS_CA_FILE: '/a',
        PRAGMATIC_REDIS_URL: 'redis://127.0.0.1:6379',
        PRAGMATIC_DRAIN_TIMEOUT_MS: 'soon',
    }
    assert.throws(() => ServerConfigLoader.LoadGateway(env), /PRAGMATIC_DRAIN_TIMEOUT_MS/)
})

class CloudEnv
{
    public static readonly Required: Record<string, string> = {
        PRAGMATIC_GCS_BUCKET: 'bkt',
        PRAGMATIC_GCP_PROJECT: 'proj',
        PRAGMATIC_CLOUDSQL_INSTANCE: 'proj:region:inst',
        PRAGMATIC_CLOUDSQL_USER: 'svc',
        PRAGMATIC_CLOUDSQL_DB: 'db1',
        PRAGMATIC_CLOUD_MASTER_KEY_REF: 'cluster/master-key',
    }

    public static Cloud(extra: Record<string, string> = {}): Record<string, string | undefined>
    {
        return { ...Env.Minimal(), PRAGMATIC_DEPLOYMENT_MODE: 'cloud', ...CloudEnv.Required, ...extra }
    }
}

test('cloud mode with all required gcp vars populates the cloud fields', () =>
{
    const config = ServerConfigLoader.Load(CloudEnv.Cloud({ PRAGMATIC_GCS_PREFIX: 'pre', PRAGMATIC_CLOUDSQL_IPTYPE: 'PRIVATE' }), Env.NoRead)
    assert.equal(config.gcsBucket, 'bkt')
    assert.equal(config.gcsPrefix, 'pre')
    assert.equal(config.gcpProject, 'proj')
    assert.equal(config.cloudSqlInstance, 'proj:region:inst')
    assert.equal(config.cloudSqlUser, 'svc')
    assert.equal(config.cloudSqlDatabase, 'db1')
    assert.equal(config.cloudSqlIpType, 'PRIVATE')
    assert.equal(config.cloudMasterKeyRef, 'cluster/master-key')
})

for (const name of Object.keys(CloudEnv.Required))
{
    test(`cloud mode missing ${name} throws naming only that var`, () =>
    {
        for (const blank of [undefined, ''])
        {
            const env = CloudEnv.Cloud()
            env[name] = blank
            assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), (error: Error) =>
                error.message.startsWith(`${name} is required`) && !error.message.includes(CloudEnv.Required[name]))
        }
    })
}

test('cloud mode rejects password auth and accepts iam in any case', () =>
{
    assert.throws(() => ServerConfigLoader.Load(CloudEnv.Cloud({ PRAGMATIC_CLOUDSQL_AUTH: 'password' }), Env.NoRead), /PRAGMATIC_CLOUDSQL_AUTH=password is not supported yet; use iam/)
    for (const auth of ['iam', 'IAM', 'Iam'])
    {
        assert.equal(ServerConfigLoader.Load(CloudEnv.Cloud({ PRAGMATIC_CLOUDSQL_AUTH: auth }), Env.NoRead).cloudSqlAuth, auth)
    }
})

test('local mode ignores gcp vars', () =>
{
    const config = ServerConfigLoader.Load({ ...Env.Minimal(), ...CloudEnv.Required, PRAGMATIC_CLOUDSQL_AUTH: 'password' }, Env.NoRead)
    assert.equal(config.gcsBucket, undefined)
    assert.equal(config.cloudMasterKeyRef, undefined)
    assert.equal('cloudSqlAuth' in config, false)
})
