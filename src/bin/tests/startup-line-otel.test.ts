import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode, type ServerConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { ServerBootstrap } from '../server-bootstrap.js'

class Fixtures
{
    public static Base(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { keyFilePath: '/run/secrets/key' }, deploymentMode: DeploymentMode.Local, singleEnvironment: { id: 't1', displayName: 'Environment One' } }
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

test('the worker startup line carries the otel token without the endpoint', () =>
{
    const worker = ServerBootstrap.WorkerStartupLine({ ...Fixtures.Base(), otlpMetrics: true, otlpEndpoint: 'https://collector:4317' })
    assert.match(worker, / otel=on/)
    assert.ok(!worker.includes('https://collector:4317'))
})
