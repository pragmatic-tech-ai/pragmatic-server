import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'

class AnchorLoaderFixture
{
    // Load(env, readTextFile) - readTextFile is never called on these paths (master key is a reference).
    public static NoRead(): string
    {
        throw new Error('unexpected read')
    }

    public static Shared(provider: string): Record<string, string | undefined>
    {
        return {
            PRAGMATIC_BASE_DIR: '/data',
            PRAGMATIC_MASTER_KEY_FILE: '/k',
            PRAGMATIC_TENANT_ID: 't1',
            PRAGMATIC_DEPLOYMENT_MODE: 'cloud',
            PRAGMATIC_CLOUD_PROVIDER: provider,
            PRAGMATIC_CLOUD_MASTER_KEY_REF: 'cluster/master-key',
        }
    }

    public static CloudGcp(extra: Record<string, string>): Record<string, string | undefined>
    {
        return {
            ...AnchorLoaderFixture.Shared('gcp'),
            PRAGMATIC_GCS_BUCKET: 'b',
            PRAGMATIC_GCP_PROJECT: 'p',
            PRAGMATIC_CLOUDSQL_INSTANCE: 'i',
            PRAGMATIC_CLOUDSQL_USER: 'u',
            PRAGMATIC_CLOUDSQL_DB: 'd',
            ...extra,
        }
    }

    public static CloudAws(extra: Record<string, string>): Record<string, string | undefined>
    {
        return {
            ...AnchorLoaderFixture.Shared('aws'),
            PRAGMATIC_AWS_REGION: 'us-east-1',
            PRAGMATIC_S3_BUCKET: 'b',
            PRAGMATIC_RDS_HOST: 'h',
            PRAGMATIC_RDS_USER: 'u',
            PRAGMATIC_RDS_DB: 'd',
            ...extra,
        }
    }

    public static CloudAzure(extra: Record<string, string>): Record<string, string | undefined>
    {
        return {
            ...AnchorLoaderFixture.Shared('azure'),
            PRAGMATIC_AZURE_STORAGE_ACCOUNT: 'acct',
            PRAGMATIC_BLOB_CONTAINER: 'c',
            PRAGMATIC_AZURE_KEYVAULT_URL: 'https://v.vault.azure.net',
            PRAGMATIC_AZPG_HOST: 'h',
            PRAGMATIC_AZPG_USER: 'u',
            PRAGMATIC_AZPG_DB: 'd',
            ...extra,
        }
    }
}

test('anchor key ref and a valid interval populate the cloud config', () =>
{
    const cfg = ServerConfigLoader.Load(AnchorLoaderFixture.CloudGcp({ PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF: 'cluster/anchor-key', PRAGMATIC_CLOUD_AUDIT_ANCHOR_INTERVAL: '10' }), AnchorLoaderFixture.NoRead)
    assert.equal(cfg.cloudAuditAnchorKeyRef, 'cluster/anchor-key')
    assert.equal(cfg.cloudAuditAnchorInterval, 10)
})

test('absent anchor fields are undefined (anchoring off)', () =>
{
    const cfg = ServerConfigLoader.Load(AnchorLoaderFixture.CloudGcp({}), AnchorLoaderFixture.NoRead)
    assert.equal(cfg.cloudAuditAnchorKeyRef, undefined)
    assert.equal(cfg.cloudAuditAnchorInterval, undefined)
})

test('a malformed interval is rejected fail-closed', () =>
{
    for (const bad of ['0', '-1', '1.5', 'abc'])
    {
        assert.throws(() => ServerConfigLoader.Load(AnchorLoaderFixture.CloudGcp({ PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF: 'r', PRAGMATIC_CLOUD_AUDIT_ANCHOR_INTERVAL: bad }), AnchorLoaderFixture.NoRead), /ANCHOR_INTERVAL/)
    }
})

test('anchor fields are ignored in non-cloud (local) mode', () =>
{
    const cfg = ServerConfigLoader.Load({ PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_FILE: '/k', PRAGMATIC_TENANT_ID: 't1', PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF: 'r', PRAGMATIC_CLOUD_AUDIT_ANCHOR_INTERVAL: '5' }, AnchorLoaderFixture.NoRead)
    assert.equal(cfg.cloudAuditAnchorKeyRef, undefined)
    assert.equal(cfg.cloudAuditAnchorInterval, undefined)
})

test('anchor key ref reaches the AWS cloud config', () =>
{
    const cfg = ServerConfigLoader.Load(AnchorLoaderFixture.CloudAws({ PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF: 'cluster/anchor-key' }), AnchorLoaderFixture.NoRead)
    assert.equal(cfg.cloudAuditAnchorKeyRef, 'cluster/anchor-key')
})

test('anchor key ref reaches the Azure cloud config', () =>
{
    const cfg = ServerConfigLoader.Load(AnchorLoaderFixture.CloudAzure({ PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF: 'cluster/anchor-key' }), AnchorLoaderFixture.NoRead)
    assert.equal(cfg.cloudAuditAnchorKeyRef, 'cluster/anchor-key')
})
