import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { Gateway } from '../gateway.js'
import { Observability, ObservabilityRole } from '../../observability/observability.js'
import { MachineFingerprintHeader } from '../machine-headers.js'

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'

test('Gateway.OutboundHeaders forwards the inbound trace id and never echoes an inbound fingerprint or baggage', () =>
{
    const reader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 2_147_483_647 })
    Observability.ForTest({ role: ObservabilityRole.Gateway }, new InMemorySpanExporter(), reader)
    const req = {
        headers: { traceparent: `00-${TRACE_ID}-b7ad6b7169203331-01`, baggage: 'k=v', [MachineFingerprintHeader]: 'spoofed' },
        socket: { authorized: false },
    } as unknown as IncomingMessage
    const headers = Gateway.OutboundHeaders(req, 't1', null, false)
    assert.ok(headers.traceparent?.includes(TRACE_ID))
    assert.equal(headers[MachineFingerprintHeader], undefined)
    assert.equal(headers.baggage, undefined)
})
