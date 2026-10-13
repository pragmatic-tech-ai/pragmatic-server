import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { Observability, ObservabilityRole } from '../observability.js'

class Fixtures
{
    public static Reader(): PeriodicExportingMetricReader
    {
        return new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 2_147_483_647 })
    }

    public static async GrabPort(): Promise<number>
    {
        const net = await import('node:net')
        return new Promise<number>(resolve =>
        {
            const server = net.createServer()
            server.listen(0, '127.0.0.1', () =>
            {
                const port = (server.address() as { port: number }).port
                server.close(() => resolve(port))
            })
        })
    }
}

test('builds providers with injected in-memory exporters and exposes a tracer and meter', () =>
{
    const obs = Observability.ForTest({ role: ObservabilityRole.Host, serviceName: 'svc', replicaId: 'r1' }, new InMemorySpanExporter(), Fixtures.Reader())
    assert.ok(obs.Tracer() !== undefined)
    assert.ok(obs.Meter() !== undefined)
})

test('a disabled config still builds a degrade-safe no-op and Shutdown resolves', async () =>
{
    const obs = Observability.Start({ role: ObservabilityRole.Worker })
    const span = obs.Tracer().startSpan('x')
    assert.equal(span.spanContext().traceId.length, 32)
    span.end()
    await obs.Shutdown()
    assert.ok(true)
})

test('a registered counter is collectable through an in-memory metric reader', async () =>
{
    const metricReader = Fixtures.Reader()
    const obs = Observability.ForTest({ role: ObservabilityRole.Host, serviceName: 'svc' }, new InMemorySpanExporter(), metricReader)
    obs.Meter().createCounter('probe_total').add(3, { outcome: 'ok' })
    const collected = await metricReader.collect()
    const names = collected!.resourceMetrics.scopeMetrics.flatMap(s => s.metrics.map(m => m.descriptor.name))
    assert.ok(names.includes('probe_total'))
    await obs.Shutdown()
})

test('a span recorded through an in-memory span exporter is exported', () =>
{
    const spanExporter = new InMemorySpanExporter()
    const obs = Observability.ForTest({ role: ObservabilityRole.Host }, spanExporter, Fixtures.Reader())
    obs.Tracer().startSpan('unit').end()
    assert.equal(spanExporter.getFinishedSpans().length, 1)
})

test('a Prometheus reader serves the registered instruments on the configured port', async () =>
{
    const port = await Fixtures.GrabPort()
    const obs = Observability.Start({ role: ObservabilityRole.Host, serviceName: 'svc', metricsPort: port })
    obs.Meter().createCounter('scrape_probe_total').add(1, { tenant: 't1' })
    await new Promise(resolve => setTimeout(resolve, 250))
    const response = await fetch(`http://127.0.0.1:${port}/metrics`)
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.ok(body.includes('scrape_probe_total'))
    await obs.Shutdown()
})
