import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { BatchSpanProcessor, SimpleSpanProcessor, AlwaysOffSampler, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'
import type { SpanProcessor, SpanExporter, Sampler } from '@opentelemetry/sdk-trace-base'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import type { MetricReader } from '@opentelemetry/sdk-metrics'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import type { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'
import type { Tracer, Meter } from '@opentelemetry/api'
import { OtlpProtocol } from './otlp-protocol.js'

export enum ObservabilityRole
{
    Host = 'host',
    Worker = 'worker',
    Gateway = 'gateway',
}

export interface IObservabilityOptions
{
    role: ObservabilityRole
    serviceName?: string
    replicaId?: string
    metricsPort?: number
    otlpEndpoint?: string
    otlpProtocol?: OtlpProtocol
    otlpMetrics?: boolean
    traceSampling?: number
}

/** Owns the OTel TracerProvider + MeterProvider for one process. Built in each bin root; degrade-safe when nothing is configured (providers still register so trace ids exist for correlation). */
export class Observability
{
    private static readonly TracerName = 'pragmatic-server'
    private static readonly MeterName = 'pragmatic-server'
    private static readonly RoleAttribute = 'service.role'
    private static readonly InstanceAttribute = 'service.instance.id'
    private static readonly DefaultServiceName = 'pragmatic-server'
    private static readonly MetricsEndpoint = '/metrics'
    private static readonly MetricsHost = '0.0.0.0'
    private static readonly FullSampling = 1

    private readonly tracerProvider: NodeTracerProvider
    private readonly meterProvider: MeterProvider

    private constructor(tracerProvider: NodeTracerProvider, meterProvider: MeterProvider)
    {
        this.tracerProvider = tracerProvider
        this.meterProvider = meterProvider
    }

    public static Start(options: IObservabilityOptions): Observability
    {
        return Observability.Build(options, Observability.ProductionSpanProcessors(options), Observability.ProductionMetricReaders(options))
    }

    public static ForTest(options: IObservabilityOptions, spanExporter: SpanExporter, metricReader: MetricReader): Observability
    {
        return Observability.Build(options, [new SimpleSpanProcessor(spanExporter)], [metricReader])
    }

    public Tracer(): Tracer
    {
        return this.tracerProvider.getTracer(Observability.TracerName)
    }

    public Meter(): Meter
    {
        return this.meterProvider.getMeter(Observability.MeterName)
    }

    public async Shutdown(): Promise<void>
    {
        await this.tracerProvider.shutdown().catch(() => {})
        await this.meterProvider.shutdown().catch(() => {})
    }

    private static Build(options: IObservabilityOptions, spanProcessors: SpanProcessor[], readers: MetricReader[]): Observability
    {
        const resource = Observability.ResourceOf(options)
        const tracerProvider = new NodeTracerProvider({ resource, sampler: Observability.SamplerOf(options, spanProcessors), spanProcessors })
        tracerProvider.register()
        const meterProvider = new MeterProvider({ resource, readers })
        return new Observability(tracerProvider, meterProvider)
    }

    private static ResourceOf(options: IObservabilityOptions): Resource
    {
        return defaultResource().merge(resourceFromAttributes({
            [ATTR_SERVICE_NAME]: options.serviceName ?? Observability.DefaultServiceName,
            [Observability.InstanceAttribute]: options.replicaId ?? '',
            [Observability.RoleAttribute]: options.role,
        }))
    }

    private static SamplerOf(options: IObservabilityOptions, spanProcessors: SpanProcessor[]): Sampler
    {
        if (spanProcessors.length === 0)
        {
            return new AlwaysOffSampler()
        }
        return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.traceSampling ?? Observability.FullSampling) })
    }

    private static HasEndpoint(options: IObservabilityOptions): boolean
    {
        return options.otlpEndpoint !== undefined && options.otlpEndpoint.length > 0
    }

    private static ProductionSpanProcessors(options: IObservabilityOptions): SpanProcessor[]
    {
        if (!Observability.HasEndpoint(options))
        {
            return []
        }
        const exporter: SpanExporter = options.otlpProtocol === OtlpProtocol.Grpc
            ? new OTLPTraceExporterGrpc({ url: options.otlpEndpoint })
            : new OTLPTraceExporter({ url: options.otlpEndpoint })
        return [new BatchSpanProcessor(exporter)]
    }

    private static ProductionMetricReaders(options: IObservabilityOptions): MetricReader[]
    {
        const readers: MetricReader[] = []
        if (options.metricsPort !== undefined)
        {
            readers.push(new PrometheusExporter({ host: Observability.MetricsHost, port: options.metricsPort, endpoint: Observability.MetricsEndpoint }))
        }
        if (options.otlpMetrics === true && Observability.HasEndpoint(options))
        {
            readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: options.otlpEndpoint }) }))
        }
        return readers
    }
}
