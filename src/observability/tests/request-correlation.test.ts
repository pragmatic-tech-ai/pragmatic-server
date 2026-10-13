import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingHttpHeaders } from 'node:http'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { Observability, ObservabilityRole } from '../observability.js'
import { RequestInstrumentation } from '../request-instrumentation.js'
import { RequestCorrelation } from '../request-correlation.js'
import { NullLogger, StructuredLogger } from '../logger.js'

const KNOWN_TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const TRACEPARENT = `00-${KNOWN_TRACE_ID}-b7ad6b7169203331-01`

class CorrelationFixture
{
    public static Reader(): PeriodicExportingMetricReader
    {
        return new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 2_147_483_647 })
    }

    public static Tracing(spanExporter: InMemorySpanExporter): Observability
    {
        return Observability.ForTest({ role: ObservabilityRole.Host, otlpEndpoint: 'https://collector:4317', traceSampling: 1 }, spanExporter, CorrelationFixture.Reader())
    }
}

test('Extract then Inject round-trips the inbound traceparent into an outbound carrier', () =>
{
    Observability.ForTest({ role: ObservabilityRole.Host }, new InMemorySpanExporter(), CorrelationFixture.Reader())
    const inbound: IncomingHttpHeaders = { traceparent: TRACEPARENT }
    const ctx = RequestCorrelation.Extract(inbound)
    assert.equal(RequestCorrelation.TraceIdOf(ctx), KNOWN_TRACE_ID)
    const carrier: Record<string, string> = {}
    RequestCorrelation.Inject(ctx, carrier)
    assert.ok(typeof carrier.traceparent === 'string')
    assert.ok(carrier.traceparent.includes(KNOWN_TRACE_ID))
})

test('a request carrying an inbound traceparent continues the same trace id', async () =>
{
    const spanExporter = new InMemorySpanExporter()
    const obs = CorrelationFixture.Tracing(spanExporter)
    const instrumentation = RequestInstrumentation.FromObservability(obs, new NullLogger())
    await instrumentation.Run({ method: 'm', tenant: 't1', principal: 'p1' }, () => undefined, RequestCorrelation.Extract({ traceparent: TRACEPARENT }))
    const spans = spanExporter.getFinishedSpans()
    assert.equal(spans.length, 1)
    assert.equal(spans[0]!.spanContext().traceId, KNOWN_TRACE_ID)
    await obs.Shutdown()
})

test('a malformed inbound traceparent does not reject the request and yields a fresh valid trace id', async () =>
{
    const spanExporter = new InMemorySpanExporter()
    const obs = CorrelationFixture.Tracing(spanExporter)
    const instrumentation = RequestInstrumentation.FromObservability(obs, new NullLogger())
    const result = await instrumentation.Run({ method: 'm', tenant: 't1', principal: 'p1' }, () => 7, RequestCorrelation.Extract({ traceparent: 'garbage-not-a-traceparent' }))
    assert.equal(result, 7)
    const spans = spanExporter.getFinishedSpans()
    assert.equal(spans[0]!.spanContext().traceId.length, 32)
    assert.notEqual(spans[0]!.spanContext().traceId, KNOWN_TRACE_ID)
    await obs.Shutdown()
})

test('a request without an inbound traceparent gets a fresh root trace id', async () =>
{
    const spanExporter = new InMemorySpanExporter()
    const obs = CorrelationFixture.Tracing(spanExporter)
    const instrumentation = RequestInstrumentation.FromObservability(obs, new NullLogger())
    await instrumentation.Run({ method: 'm', tenant: 't1', principal: 'p1' }, () => undefined, RequestCorrelation.Extract({}))
    assert.equal(spanExporter.getFinishedSpans()[0]!.spanContext().traceId.length, 32)
    await obs.Shutdown()
})

test('every log line within a request carries the correlation id equal to the span trace id', async () =>
{
    const lines: Array<Record<string, unknown>> = []
    const logger = StructuredLogger.ToSink(line => lines.push(JSON.parse(line) as Record<string, unknown>))
    const spanExporter = new InMemorySpanExporter()
    const obs = CorrelationFixture.Tracing(spanExporter)
    const instrumentation = RequestInstrumentation.FromObservability(obs, logger)
    await instrumentation.Run({ method: 'm', tenant: 't1', principal: 'p1' }, () => undefined, RequestCorrelation.Extract({ traceparent: TRACEPARENT }))
    assert.ok(lines.length >= 1)
    assert.equal(lines[lines.length - 1]!.correlationId, KNOWN_TRACE_ID)
    await obs.Shutdown()
})
