import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'

// Load(env, readTextFile) — readTextFile is never called on these paths (master key is a reference).
function noRead(): string
{
    throw new Error('unexpected read')
}

function cloudEnv(extra: Record<string, string>): Record<string, string | undefined>
{
    return {
        PRAGMATIC_BASE_DIR: '/data',
        PRAGMATIC_MASTER_KEY_FILE: '/k',
        PRAGMATIC_TENANT_ID: 't1',
        PRAGMATIC_DEPLOYMENT_MODE: 'cloud',
        PRAGMATIC_CLOUD_PROVIDER: 'gcp',
        PRAGMATIC_CLOUD_MASTER_KEY_REF: 'cluster/master-key',
        PRAGMATIC_GCS_BUCKET: 'b',
        PRAGMATIC_GCP_PROJECT: 'p',
        PRAGMATIC_CLOUDSQL_INSTANCE: 'i',
        PRAGMATIC_CLOUDSQL_USER: 'u',
        PRAGMATIC_CLOUDSQL_DB: 'd',
        ...extra,
    }
}

test('anchor key ref and a valid interval populate the cloud config', () =>
{
    const cfg = ServerConfigLoader.Load(cloudEnv({ PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF: 'cluster/anchor-key', PRAGMATIC_CLOUD_AUDIT_ANCHOR_INTERVAL: '10' }), noRead)
    assert.equal(cfg.cloudAuditAnchorKeyRef, 'cluster/anchor-key')
    assert.equal(cfg.cloudAuditAnchorInterval, 10)
})

test('absent anchor fields are undefined (anchoring off)', () =>
{
    const cfg = ServerConfigLoader.Load(cloudEnv({}), noRead)
    assert.equal(cfg.cloudAuditAnchorKeyRef, undefined)
    assert.equal(cfg.cloudAuditAnchorInterval, undefined)
})

test('a malformed interval is rejected fail-closed', () =>
{
    for (const bad of ['0', '-1', '1.5', 'abc'])
    {
        assert.throws(() => ServerConfigLoader.Load(cloudEnv({ PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF: 'r', PRAGMATIC_CLOUD_AUDIT_ANCHOR_INTERVAL: bad }), noRead), /ANCHOR_INTERVAL/)
    }
})

test('anchor fields are ignored in non-cloud (local) mode', () =>
{
    const cfg = ServerConfigLoader.Load({ PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_FILE: '/k', PRAGMATIC_TENANT_ID: 't1', PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF: 'r', PRAGMATIC_CLOUD_AUDIT_ANCHOR_INTERVAL: '5' }, noRead)
    assert.equal(cfg.cloudAuditAnchorKeyRef, undefined)
    assert.equal(cfg.cloudAuditAnchorInterval, undefined)
})
