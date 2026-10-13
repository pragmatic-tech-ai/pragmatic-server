import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'
import { OtlpProtocol } from '../../observability/otlp-protocol.js'

class Fixtures
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

test('defaults every observability field to undefined when unset', () =>
{
    const config = ServerConfigLoader.Load(Fixtures.Minimal(), Fixtures.NoRead)
    assert.equal(config.serviceName, undefined)
    assert.equal(config.metricsPort, undefined)
    assert.equal(config.otlpEndpoint, undefined)
    assert.equal(config.otlpProtocol, undefined)
    assert.equal(config.otlpMetrics, undefined)
    assert.equal(config.traceSampling, undefined)
})

test('parses each observability field from env', () =>
{
    const env = { ...Fixtures.Minimal(), PRAGMATIC_SERVICE_NAME: 'svc', PRAGMATIC_METRICS_PORT: '9464', PRAGMATIC_OTLP_ENDPOINT: 'https://collector:4317', PRAGMATIC_OTLP_PROTOCOL: 'grpc', PRAGMATIC_OTLP_METRICS: 'true', PRAGMATIC_TRACE_SAMPLING: '0.25' }
    const config = ServerConfigLoader.Load(env, Fixtures.NoRead)
    assert.equal(config.serviceName, 'svc')
    assert.equal(config.metricsPort, 9464)
    assert.equal(config.otlpEndpoint, 'https://collector:4317')
    assert.equal(config.otlpProtocol, OtlpProtocol.Grpc)
    assert.equal(config.otlpMetrics, true)
    assert.equal(config.traceSampling, 0.25)
})

test('fails closed on a malformed metrics port', () =>
{
    assert.throws(() => ServerConfigLoader.Load({ ...Fixtures.Minimal(), PRAGMATIC_METRICS_PORT: 'not-a-port' }, Fixtures.NoRead), /PRAGMATIC_METRICS_PORT/)
})

test('fails closed on an out-of-range sampling ratio', () =>
{
    assert.throws(() => ServerConfigLoader.Load({ ...Fixtures.Minimal(), PRAGMATIC_TRACE_SAMPLING: '1.5' }, Fixtures.NoRead), /PRAGMATIC_TRACE_SAMPLING/)
})

test('fails closed on an unknown otlp protocol', () =>
{
    assert.throws(() => ServerConfigLoader.Load({ ...Fixtures.Minimal(), PRAGMATIC_OTLP_PROTOCOL: 'thrift' }, Fixtures.NoRead), /PRAGMATIC_OTLP_PROTOCOL/)
})

test('the gateway loader parses observability fields too', () =>
{
    const env = { PRAGMATIC_TLS_CERT_FILE: '/c', PRAGMATIC_TLS_KEY_FILE: '/k', PRAGMATIC_TLS_CA_FILE: '/a', PRAGMATIC_REDIS_URL: 'redis://localhost:6379', PRAGMATIC_METRICS_PORT: '9464', PRAGMATIC_OTLP_ENDPOINT: 'https://collector:4317' }
    const gw = ServerConfigLoader.LoadGateway(env)
    assert.equal(gw.metricsPort, 9464)
    assert.equal(gw.otlpEndpoint, 'https://collector:4317')
})
