import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'
import { AuditSinkKind } from '../audit-sink-kind.js'

class LoaderFixture
{
    public static Minimal(): Record<string, string | undefined>
    {
        return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_FILE: '/k', PRAGMATIC_TENANT_ID: 't1' }
    }

    public static NoRead(): string
    {
        throw new Error('unexpected read')
    }

    public static Gateway(extra: Record<string, string>): Record<string, string | undefined>
    {
        return { PRAGMATIC_TLS_CERT_FILE: '/c', PRAGMATIC_TLS_KEY_FILE: '/k', PRAGMATIC_TLS_CA_FILE: '/ca', PRAGMATIC_REDIS_URL: 'redis://x', ...extra }
    }
}

test('audit and rate-limit are absent by default', () =>
{
    const config = ServerConfigLoader.Load(LoaderFixture.Minimal(), LoaderFixture.NoRead)
    assert.equal(config.auditSink, undefined)
    assert.equal(config.auditFile, undefined)
    assert.equal(config.rateLimit, undefined)
})

test('auditSink=file requires auditFile, else fails closed', () =>
{
    const env = { ...LoaderFixture.Minimal(), PRAGMATIC_AUDIT_SINK: 'file' }
    assert.throws(() => ServerConfigLoader.Load(env, LoaderFixture.NoRead), /PRAGMATIC_AUDIT_FILE/)
    const ok = ServerConfigLoader.Load({ ...env, PRAGMATIC_AUDIT_FILE: '/var/log/audit.log' }, LoaderFixture.NoRead)
    assert.equal(ok.auditSink, AuditSinkKind.File)
    assert.equal(ok.auditFile, '/var/log/audit.log')
})

test('auditSink=sql is only valid in cloud mode', () =>
{
    const env = { ...LoaderFixture.Minimal(), PRAGMATIC_AUDIT_SINK: 'sql' }
    assert.throws(() => ServerConfigLoader.Load(env, LoaderFixture.NoRead), /cloud/)
    const gcp = {
        PRAGMATIC_CLOUD_PROVIDER: 'gcp',
        PRAGMATIC_GCS_BUCKET: 'bkt',
        PRAGMATIC_GCP_PROJECT: 'proj',
        PRAGMATIC_CLOUDSQL_INSTANCE: 'proj:region:inst',
        PRAGMATIC_CLOUDSQL_USER: 'svc',
        PRAGMATIC_CLOUDSQL_DB: 'db1',
        PRAGMATIC_CLOUD_MASTER_KEY_REF: 'cluster/master-key',
    }
    const ok = ServerConfigLoader.Load({ ...env, ...gcp, PRAGMATIC_DEPLOYMENT_MODE: 'cloud' }, LoaderFixture.NoRead)
    assert.equal(ok.auditSink, AuditSinkKind.Sql)
})

test('a bogus auditSink fails closed', () =>
{
    assert.throws(() => ServerConfigLoader.Load({ ...LoaderFixture.Minimal(), PRAGMATIC_AUDIT_SINK: 'syslog' }, LoaderFixture.NoRead), /PRAGMATIC_AUDIT_SINK/)
})

test('rate-limit env builds a per-tenant and per-principal config', () =>
{
    const env = { ...LoaderFixture.Minimal(), PRAGMATIC_RATELIMIT_TENANT_RPS: '50', PRAGMATIC_RATELIMIT_TENANT_BURST: '100', PRAGMATIC_RATELIMIT_PRINCIPAL_RPS: '10', PRAGMATIC_RATELIMIT_PRINCIPAL_BURST: '20' }
    const config = ServerConfigLoader.Load(env, LoaderFixture.NoRead)
    assert.deepEqual(config.rateLimit?.perTenant, { Rps: 50, Burst: 100 })
    assert.deepEqual(config.rateLimit?.perPrincipal, { Rps: 10, Burst: 20 })
})

test('invalid rate-limit values fail closed', () =>
{
    const bad = (rps: string, burst: string) => () => ServerConfigLoader.Load({ ...LoaderFixture.Minimal(), PRAGMATIC_RATELIMIT_TENANT_RPS: rps, PRAGMATIC_RATELIMIT_TENANT_BURST: burst }, LoaderFixture.NoRead)
    assert.throws(bad('-1', '5'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('abc', '5'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('0', '5'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('Infinity', '5'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('5', '0'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('5', '1.5'), /PRAGMATIC_RATELIMIT/)
})

test('a partial rate-limit scope (rps without burst) fails closed', () =>
{
    assert.throws(() => ServerConfigLoader.Load({ ...LoaderFixture.Minimal(), PRAGMATIC_RATELIMIT_TENANT_RPS: '10' }, LoaderFixture.NoRead), /PRAGMATIC_RATELIMIT/)
})

test('the gateway loader parses the security block too', () =>
{
    const env = { PRAGMATIC_TLS_CERT_FILE: '/c', PRAGMATIC_TLS_KEY_FILE: '/k', PRAGMATIC_TLS_CA_FILE: '/ca', PRAGMATIC_REDIS_URL: 'redis://x', PRAGMATIC_RATELIMIT_TENANT_RPS: '5', PRAGMATIC_RATELIMIT_TENANT_BURST: '10' }
    assert.deepEqual(ServerConfigLoader.LoadGateway(env).rateLimit?.perTenant, { Rps: 5, Burst: 10 })
})

test('the gateway rejects auditSink=sql early but accepts file and none', () =>
{
    assert.throws(() => ServerConfigLoader.LoadGateway(LoaderFixture.Gateway({ PRAGMATIC_AUDIT_SINK: 'sql' })), /gateway/)
    assert.equal(ServerConfigLoader.LoadGateway(LoaderFixture.Gateway({ PRAGMATIC_AUDIT_SINK: 'none' })).auditSink, AuditSinkKind.None)
    assert.equal(ServerConfigLoader.LoadGateway(LoaderFixture.Gateway({ PRAGMATIC_AUDIT_SINK: 'file', PRAGMATIC_AUDIT_FILE: '/a' })).auditSink, AuditSinkKind.File)
})
