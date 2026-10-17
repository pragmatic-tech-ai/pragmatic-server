import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { DeploymentProvider } from '../../platform/deployment-provider.js'
import { ServerConfigLoader } from '../server-config-loader.js'
import { PagingLimits } from '../paging-limits.js'

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
        PRAGMATIC_CLOUD_PROVIDER: 'gcp',
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

class AwsCloudEnv
{
    public static readonly Required: Record<string, string> = {
        PRAGMATIC_CLOUD_PROVIDER: 'aws',
        PRAGMATIC_AWS_REGION: 'us-east-1',
        PRAGMATIC_S3_BUCKET: 'bkt',
        PRAGMATIC_RDS_HOST: 'db.example',
        PRAGMATIC_RDS_USER: 'svc',
        PRAGMATIC_RDS_DB: 'db1',
        PRAGMATIC_CLOUD_MASTER_KEY_REF: 'cluster/master-key',
    }

    public static Cloud(extra: Record<string, string> = {}): Record<string, string | undefined>
    {
        return { ...Env.Minimal(), PRAGMATIC_DEPLOYMENT_MODE: 'cloud', ...AwsCloudEnv.Required, ...extra }
    }
}

test('cloud mode with provider aws and all aws vars populates the aws fields', () =>
{
    const config = ServerConfigLoader.Load(AwsCloudEnv.Cloud(), Env.NoRead)
    assert.equal(config.cloudProvider, DeploymentProvider.Aws)
    assert.equal(config.awsRegion, 'us-east-1')
    assert.equal(config.s3Bucket, 'bkt')
    assert.equal(config.rdsHost, 'db.example')
    assert.equal(config.rdsUser, 'svc')
    assert.equal(config.rdsDatabase, 'db1')
    assert.equal(config.cloudMasterKeyRef, 'cluster/master-key')
    assert.equal(config.gcsBucket, undefined)
})

for (const name of Object.keys(AwsCloudEnv.Required))
{
    test(`aws cloud mode missing ${name} throws naming only that var`, () =>
    {
        for (const blank of [undefined, ''])
        {
            const env = AwsCloudEnv.Cloud()
            env[name] = blank
            assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), (error: Error) =>
                error.message.startsWith(`${name} is required`) && !error.message.includes(AwsCloudEnv.Required[name]))
        }
    })
}

test('cloud mode with gcp provider resolves DeploymentProvider.Gcp', () =>
{
    assert.equal(ServerConfigLoader.Load(CloudEnv.Cloud(), Env.NoRead).cloudProvider, DeploymentProvider.Gcp)
})

test('cloud mode rejects an unknown provider', () =>
{
    assert.throws(() => ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_CLOUD_PROVIDER: 'oracle' }), Env.NoRead), /must be gcp, aws or azure/)
})

test('cloud mode requires PRAGMATIC_CLOUD_PROVIDER', () =>
{
    const env = AwsCloudEnv.Cloud()
    delete env.PRAGMATIC_CLOUD_PROVIDER
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /PRAGMATIC_CLOUD_PROVIDER is required/)
})

test('aws password auth requires a password ref', () =>
{
    assert.throws(() => ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_RDS_AUTH: 'password' }), Env.NoRead), /required when PRAGMATIC_RDS_AUTH=password/)
    const config = ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_RDS_AUTH: 'password', PRAGMATIC_RDS_PASSWORD_REF: 'db/pw' }), Env.NoRead)
    assert.equal(config.rdsPasswordRef, 'db/pw')
})

test('aws rejects an unknown rds auth mode', () =>
{
    assert.throws(() => ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_RDS_AUTH: 'bogus' }), Env.NoRead), /must be iam or password/)
})

test('aws rds port must be a positive integer', () =>
{
    for (const bad of ['abc', '0', '-1', '1.5', '5432abc', ' 5432', '65536', '99999', '1234567890123456789012345'])
    {
        assert.throws(() => ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_RDS_PORT: bad }), Env.NoRead), /between 1 and 65535/)
    }
    assert.equal(ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_RDS_PORT: '5432' }), Env.NoRead).rdsPort, 5432)
    assert.equal(ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_RDS_PORT: '65535' }), Env.NoRead).rdsPort, 65535)
})

test('provider value is case-insensitive', () =>
{
    for (const value of ['AWS', 'Aws'])
    {
        assert.equal(ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_CLOUD_PROVIDER: value }), Env.NoRead).cloudProvider, DeploymentProvider.Aws)
    }
    assert.equal(ServerConfigLoader.Load(CloudEnv.Cloud({ PRAGMATIC_CLOUD_PROVIDER: 'GCP' }), Env.NoRead).cloudProvider, DeploymentProvider.Gcp)
})

test('rds auth is case-insensitive', () =>
{
    assert.equal(ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_RDS_AUTH: 'IAM' }), Env.NoRead).rdsAuth, 'IAM')
    const config = ServerConfigLoader.Load(AwsCloudEnv.Cloud({ PRAGMATIC_RDS_AUTH: 'Password', PRAGMATIC_RDS_PASSWORD_REF: 'db/pw' }), Env.NoRead)
    assert.equal(config.rdsAuth, 'Password')
    assert.equal(config.rdsPasswordRef, 'db/pw')
})

test('the aws provider does not require the gcp vars', () =>
{
    const env = AwsCloudEnv.Cloud()
    assert.equal(env.PRAGMATIC_GCS_BUCKET, undefined)
    assert.equal(env.PRAGMATIC_CLOUDSQL_INSTANCE, undefined)
    const config = ServerConfigLoader.Load(env, Env.NoRead)
    assert.equal(config.gcsBucket, undefined)
    assert.equal(config.cloudSqlInstance, undefined)
})

test('local mode ignores gcp vars', () =>
{
    const config = ServerConfigLoader.Load({ ...Env.Minimal(), ...CloudEnv.Required, PRAGMATIC_CLOUDSQL_AUTH: 'password' }, Env.NoRead)
    assert.equal(config.gcsBucket, undefined)
    assert.equal(config.cloudMasterKeyRef, undefined)
    assert.equal('cloudSqlAuth' in config, false)
})

class AzureCloudEnv
{
    public static readonly Required: Record<string, string> = {
        PRAGMATIC_CLOUD_PROVIDER: 'azure',
        PRAGMATIC_AZURE_STORAGE_ACCOUNT: 'acct',
        PRAGMATIC_BLOB_CONTAINER: 'cont',
        PRAGMATIC_AZURE_KEYVAULT_URL: 'https://v.vault.azure.net',
        PRAGMATIC_AZPG_HOST: 'db.postgres.database.azure.com',
        PRAGMATIC_AZPG_USER: 'svc',
        PRAGMATIC_AZPG_DB: 'db1',
        PRAGMATIC_CLOUD_MASTER_KEY_REF: 'cluster/master-key',
    }

    public static Cloud(extra: Record<string, string> = {}): Record<string, string | undefined>
    {
        return { ...Env.Minimal(), PRAGMATIC_DEPLOYMENT_MODE: 'cloud', ...AzureCloudEnv.Required, ...extra }
    }
}

test('cloud mode with provider azure and all azure vars populates the azure fields', () =>
{
    const config = ServerConfigLoader.Load(AzureCloudEnv.Cloud({ PRAGMATIC_BLOB_PREFIX: 'p/' }), Env.NoRead)
    assert.equal(config.cloudProvider, DeploymentProvider.Azure)
    assert.equal(config.blobAccount, 'acct')
    assert.equal(config.blobContainer, 'cont')
    assert.equal(config.blobPrefix, 'p/')
    assert.equal(config.keyVaultUrl, 'https://v.vault.azure.net')
    assert.equal(config.azpgHost, 'db.postgres.database.azure.com')
    assert.equal(config.azpgUser, 'svc')
    assert.equal(config.azpgDatabase, 'db1')
    assert.equal(config.cloudMasterKeyRef, 'cluster/master-key')
})

for (const name of Object.keys(AzureCloudEnv.Required))
{
    test(`azure cloud mode missing ${name} throws naming only that var`, () =>
    {
        for (const blank of [undefined, ''])
        {
            const env = AzureCloudEnv.Cloud()
            env[name] = blank
            assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), (error: Error) =>
                error.message.startsWith(`${name} is required`) && !error.message.includes(AzureCloudEnv.Required[name]))
        }
    })
}

test('azure password auth requires a password ref', () =>
{
    assert.throws(() => ServerConfigLoader.Load(AzureCloudEnv.Cloud({ PRAGMATIC_AZPG_AUTH: 'password' }), Env.NoRead), /required when PRAGMATIC_AZPG_AUTH=password/)
    const config = ServerConfigLoader.Load(AzureCloudEnv.Cloud({ PRAGMATIC_AZPG_AUTH: 'password', PRAGMATIC_AZPG_PASSWORD_REF: 'db/pw' }), Env.NoRead)
    assert.equal(config.azpgPasswordRef, 'db/pw')
})

test('azure rejects an unknown azpg auth mode', () =>
{
    assert.throws(() => ServerConfigLoader.Load(AzureCloudEnv.Cloud({ PRAGMATIC_AZPG_AUTH: 'bogus' }), Env.NoRead), /must be entra or password/)
    assert.equal(ServerConfigLoader.Load(AzureCloudEnv.Cloud({ PRAGMATIC_AZPG_AUTH: 'Entra' }), Env.NoRead).azpgAuth, 'Entra')
})

test('azure azpg port must be a bounded positive integer', () =>
{
    for (const bad of ['abc', '0', '70000'])
    {
        assert.throws(() => ServerConfigLoader.Load(AzureCloudEnv.Cloud({ PRAGMATIC_AZPG_PORT: bad }), Env.NoRead), /between 1 and 65535/)
    }
    assert.equal(ServerConfigLoader.Load(AzureCloudEnv.Cloud({ PRAGMATIC_AZPG_PORT: '5432' }), Env.NoRead).azpgPort, 5432)
})

test('azure provider value is case-insensitive', () =>
{
    assert.equal(ServerConfigLoader.Load(AzureCloudEnv.Cloud({ PRAGMATIC_CLOUD_PROVIDER: 'AZURE' }), Env.NoRead).cloudProvider, DeploymentProvider.Azure)
})

test('the azure provider does not require the gcp or aws vars', () =>
{
    const config = ServerConfigLoader.Load(AzureCloudEnv.Cloud(), Env.NoRead)
    assert.equal(config.gcsBucket, undefined)
    assert.equal(config.s3Bucket, undefined)
})

test('ws resilience defaults when no env vars are set', () =>
{
    const config = ServerConfigLoader.Load(Env.Minimal(), Env.NoRead)
    assert.deepEqual(config.wsResilience, { heartbeatIntervalMs: 30000, readIdleMs: 60000, backpressureSoftBytes: 1048576, backpressureHardBytes: 8388608, backpressureGraceMs: 5000, maxInboundBytes: 16777216 })
})

test('ws resilience env overrides parse as positive integers', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_WS_HEARTBEAT_MS: '5000', PRAGMATIC_WS_MAX_INBOUND_BYTES: '2048' }
    const config = ServerConfigLoader.Load(env, Env.NoRead)
    assert.equal(config.wsResilience!.heartbeatIntervalMs, 5000)
    assert.equal(config.wsResilience!.maxInboundBytes, 2048)
})

test('a non-positive ws resilience value is rejected', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_WS_BP_HARD_BYTES: '0' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /PRAGMATIC_WS_/)
})

test('paging env vars parse as positive integers', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_PAGE_SIZE_DEFAULT: '250', PRAGMATIC_PAGE_SIZE_MAX: '2500' }
    const config = ServerConfigLoader.Load(env, Env.NoRead)
    assert.equal(config.pagingPageSize, 250)
    assert.equal(config.pagingMaxPageSize, 2500)
})

test('paging defaults apply when the env vars are unset', () =>
{
    const config = ServerConfigLoader.Load(Env.Minimal(), Env.NoRead)
    assert.equal(config.pagingPageSize, undefined)
    assert.equal(config.pagingMaxPageSize, undefined)
    const limits = new PagingLimits(config.pagingPageSize, config.pagingMaxPageSize)
    assert.equal(limits.PageSize, 500)
    assert.equal(limits.MaxPageSize, 5000)
})

for (const [name, value] of [['PRAGMATIC_PAGE_SIZE_DEFAULT', '0'], ['PRAGMATIC_PAGE_SIZE_DEFAULT', 'abc'], ['PRAGMATIC_PAGE_SIZE_MAX', '0'], ['PRAGMATIC_PAGE_SIZE_MAX', 'abc']])
{
    test(`a bad paging value ${name}=${value} is rejected`, () =>
    {
        const env = { ...Env.Minimal(), [name]: value }
        assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /PRAGMATIC_PAGE_SIZE_/)
    })
}

test('a paging max below the effective default fails at load naming both values', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_PAGE_SIZE_MAX: '100' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), (error: unknown) => error instanceof Error && error.message === 'PRAGMATIC_PAGE_SIZE_DEFAULT (500) exceeds PRAGMATIC_PAGE_SIZE_MAX (100)')
})

test('a paging default above the effective max fails at load naming both values', () =>
{
    const env = { ...Env.Minimal(), PRAGMATIC_PAGE_SIZE_DEFAULT: '6000' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoRead), /PRAGMATIC_PAGE_SIZE_DEFAULT \(6000\) exceeds PRAGMATIC_PAGE_SIZE_MAX \(5000\)/)
})
