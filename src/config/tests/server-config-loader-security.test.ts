import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'
import { AuditSinkKind } from '../audit-sink-kind.js'

function minimal(): Record<string, string | undefined>
{
    return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_FILE: '/k', PRAGMATIC_TENANT_ID: 't1' }
}

function noRead(): string
{
    throw new Error('unexpected read')
}

test('audit and rate-limit are absent by default', () =>
{
    const config = ServerConfigLoader.Load(minimal(), noRead)
    assert.equal(config.auditSink, undefined)
    assert.equal(config.auditFile, undefined)
    assert.equal(config.rateLimit, undefined)
})

test('auditSink=file requires auditFile, else fails closed', () =>
{
    const env = { ...minimal(), PRAGMATIC_AUDIT_SINK: 'file' }
    assert.throws(() => ServerConfigLoader.Load(env, noRead), /PRAGMATIC_AUDIT_FILE/)
    const ok = ServerConfigLoader.Load({ ...env, PRAGMATIC_AUDIT_FILE: '/var/log/audit.log' }, noRead)
    assert.equal(ok.auditSink, AuditSinkKind.File)
    assert.equal(ok.auditFile, '/var/log/audit.log')
})

test('auditSink=sql is only valid in cloud mode', () =>
{
    const env = { ...minimal(), PRAGMATIC_AUDIT_SINK: 'sql' }
    assert.throws(() => ServerConfigLoader.Load(env, noRead), /cloud/)
    const ok = ServerConfigLoader.Load({ ...env, PRAGMATIC_DEPLOYMENT_MODE: 'cloud' }, noRead)
    assert.equal(ok.auditSink, AuditSinkKind.Sql)
})

test('a bogus auditSink fails closed', () =>
{
    assert.throws(() => ServerConfigLoader.Load({ ...minimal(), PRAGMATIC_AUDIT_SINK: 'syslog' }, noRead), /PRAGMATIC_AUDIT_SINK/)
})

test('rate-limit env builds a per-tenant and per-principal config', () =>
{
    const env = { ...minimal(), PRAGMATIC_RATELIMIT_TENANT_RPS: '50', PRAGMATIC_RATELIMIT_TENANT_BURST: '100', PRAGMATIC_RATELIMIT_PRINCIPAL_RPS: '10', PRAGMATIC_RATELIMIT_PRINCIPAL_BURST: '20' }
    const config = ServerConfigLoader.Load(env, noRead)
    assert.deepEqual(config.rateLimit?.perTenant, { Rps: 50, Burst: 100 })
    assert.deepEqual(config.rateLimit?.perPrincipal, { Rps: 10, Burst: 20 })
})

test('invalid rate-limit values fail closed', () =>
{
    const bad = (rps: string, burst: string) => () => ServerConfigLoader.Load({ ...minimal(), PRAGMATIC_RATELIMIT_TENANT_RPS: rps, PRAGMATIC_RATELIMIT_TENANT_BURST: burst }, noRead)
    assert.throws(bad('-1', '5'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('abc', '5'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('0', '5'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('Infinity', '5'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('5', '0'), /PRAGMATIC_RATELIMIT/)
    assert.throws(bad('5', '1.5'), /PRAGMATIC_RATELIMIT/)
})

test('a partial rate-limit scope (rps without burst) fails closed', () =>
{
    assert.throws(() => ServerConfigLoader.Load({ ...minimal(), PRAGMATIC_RATELIMIT_TENANT_RPS: '10' }, noRead), /PRAGMATIC_RATELIMIT/)
})

test('the gateway loader parses the security block too', () =>
{
    const env = { PRAGMATIC_TLS_CERT_FILE: '/c', PRAGMATIC_TLS_KEY_FILE: '/k', PRAGMATIC_TLS_CA_FILE: '/ca', PRAGMATIC_REDIS_URL: 'redis://x', PRAGMATIC_RATELIMIT_TENANT_RPS: '5', PRAGMATIC_RATELIMIT_TENANT_BURST: '10' }
    assert.deepEqual(ServerConfigLoader.LoadGateway(env).rateLimit?.perTenant, { Rps: 5, Burst: 10 })
})
