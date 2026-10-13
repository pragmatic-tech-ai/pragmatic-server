import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { ServerBootstrap } from '../server-bootstrap.js'
import type { ServerConfig } from '../../config/server-config.js'

class Fixtures
{
    public static Base(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { keyFilePath: '/run/secrets/key' }, deploymentMode: DeploymentMode.Local, singleTenant: { id: 't1', displayName: 'Tenant One' } }
    }
}

test('otel=off when nothing observability is configured', () =>
{
    assert.match(ServerBootstrap.StartupLine(Fixtures.Base(), 1), / otel=off/)
})

test('otel=on when a metrics port is set, and the endpoint is never echoed', () =>
{
    const config = { ...Fixtures.Base(), metricsPort: 9464, otlpEndpoint: 'https://collector:4317' }
    const line = ServerBootstrap.StartupLine(config, 1)
    assert.match(line, / otel=on/)
    assert.ok(!line.includes('https://collector:4317'))
})

test('otel=on when only an otlp endpoint is set (tracing enabled)', () =>
{
    assert.match(ServerBootstrap.StartupLine({ ...Fixtures.Base(), otlpEndpoint: 'https://collector:4317' }, 1), / otel=on/)
})

test('worker and gateway startup lines carry the otel token without the endpoint', () =>
{
    const worker = ServerBootstrap.WorkerStartupLine({ ...Fixtures.Base(), otlpMetrics: true, otlpEndpoint: 'https://collector:4317' })
    assert.match(worker, / otel=on/)
    assert.ok(!worker.includes('https://collector:4317'))
    const gw = ServerBootstrap.GatewayStartupLine({ host: '0.0.0.0', port: 8080, tls: { certFile: '/c', keyFile: '/k', caFile: '/a' }, redisUrl: 'redis://x' })
    assert.match(gw, / otel=off/)
})

test('gateway startup line is otel=on without echoing the endpoint', () =>
{
    const gw = ServerBootstrap.GatewayStartupLine({ host: '0.0.0.0', port: 8080, tls: { certFile: '/c', keyFile: '/k', caFile: '/a' }, redisUrl: 'redis://x', metricsPort: 9464, otlpEndpoint: 'https://collector:4317' })
    assert.match(gw, / otel=on/)
    assert.ok(!gw.includes('https://collector:4317'))
})
