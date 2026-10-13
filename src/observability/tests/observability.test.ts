import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'
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
    await assert.doesNotReject(obs.Shutdown())
    assert.equal(span.spanContext().traceId.length, 32)
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

test('a base OTLP endpoint is expanded to per-signal URLs and an already-suffixed URL is not doubled', () =>
{
    assert.equal(Observability.TracesUrl('http://collector:4318'), 'http://collector:4318/v1/traces')
    assert.equal(Observability.TracesUrl('http://collector:4318/'), 'http://collector:4318/v1/traces')
    assert.equal(Observability.MetricsUrl('http://collector:4318'), 'http://collector:4318/v1/metrics')
    assert.equal(Observability.TracesUrl('http://collector:4318/v1/traces'), 'http://collector:4318/v1/traces')
    assert.equal(Observability.MetricsUrl('http://collector:4318/v1/metrics/'), 'http://collector:4318/v1/metrics')
})

test('the resource carries service name and role, and instance id only when a replica id is set', () =>
{
    const withReplica = Observability.ResourceOf({ role: ObservabilityRole.Gateway, serviceName: 'svc', replicaId: 'r9' }).attributes
    assert.equal(withReplica['service.name'], 'svc')
    assert.equal(withReplica['service.role'], 'gateway')
    assert.equal(withReplica['service.instance.id'], 'r9')
    const without = Observability.ResourceOf({ role: ObservabilityRole.Host }).attributes
    assert.equal(without['service.role'], 'host')
    assert.equal('service.instance.id' in without, false)
})

test('reader gating: no Prometheus reader without a port, no OTLP metric reader unless enabled with an endpoint', async () =>
{
    assert.equal(Observability.ProductionMetricReaders({ role: ObservabilityRole.Host }).length, 0)
    assert.equal(Observability.ProductionMetricReaders({ role: ObservabilityRole.Host, otlpEndpoint: 'http://collector:4318' }).length, 0)
    assert.equal(Observability.ProductionMetricReaders({ role: ObservabilityRole.Host, otlpEndpoint: 'http://collector:4318', otlpMetrics: false }).length, 0)
    assert.equal(Observability.ProductionMetricReaders({ role: ObservabilityRole.Host, otlpMetrics: true }).length, 0)
    const otlpOnly = Observability.ProductionMetricReaders({ role: ObservabilityRole.Host, otlpEndpoint: 'http://collector:4318', otlpMetrics: true })
    assert.equal(otlpOnly.length, 1)
    assert.ok(otlpOnly[0] instanceof PeriodicExportingMetricReader)
    const port = await Fixtures.GrabPort()
    const promOnly = Observability.ProductionMetricReaders({ role: ObservabilityRole.Host, metricsPort: port })
    assert.equal(promOnly.length, 1)
    assert.ok(promOnly[0] instanceof PrometheusExporter)
    for (const r of [...otlpOnly, ...promOnly])
    {
        await r.shutdown().catch(() => {})
    }
})
