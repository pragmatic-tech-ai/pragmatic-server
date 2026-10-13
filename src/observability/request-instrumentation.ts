import { context, SpanStatusCode } from '@opentelemetry/api'
import type { Tracer, Meter, Counter, Histogram, UpDownCounter, Context, Span } from '@opentelemetry/api'
import { performance } from 'node:perf_hooks'
import type { Observability } from './observability.js'
import type { ILogger } from './logger.js'

export enum RequestOutcome
{
    Ok = 'ok',
    Error = 'error',
}

/** The identifiers one request is observed under. principal rides the span only, never a metric label. */
export interface IRequestObservation
{
    method: string
    tenant: string
    principal: string
}

/** Wraps a request at the dispatch seam: one span + requests_total / request_duration_ms / requests_in_flight / request_errors_total. */
export class RequestInstrumentation
{
    private static readonly RequestsTotal = 'requests_total'
    private static readonly RequestDurationMs = 'request_duration_ms'
    private static readonly RequestsInFlight = 'requests_in_flight'
    private static readonly RequestErrorsTotal = 'request_errors_total'
    private static readonly MethodLabel = 'method'
    private static readonly TenantLabel = 'tenant'
    private static readonly OutcomeLabel = 'outcome'
    private static readonly ClassLabel = 'class'
    private static readonly PrincipalAttribute = 'principal'
    private static readonly ErrorAttribute = 'error'
    private static readonly CorrelationIdField = 'correlationId'
    private static readonly OutcomeField = 'outcome'
    private static readonly ClassField = 'class'
    private static readonly RequestCompleted = 'request completed'
    private static readonly RequestFailed = 'request failed'
    private static readonly UnknownClass = 'Error'

    private readonly tracer: Tracer
    private readonly logger: ILogger
    private readonly requestsTotal: Counter
    private readonly durationMs: Histogram
    private readonly inFlightCounter: UpDownCounter
    private readonly errorsTotal: Counter
    private inFlight = 0

    public constructor(tracer: Tracer, meter: Meter, logger: ILogger)
    {
        this.tracer = tracer
        this.logger = logger
        this.requestsTotal = meter.createCounter(RequestInstrumentation.RequestsTotal)
        this.durationMs = meter.createHistogram(RequestInstrumentation.RequestDurationMs)
        this.inFlightCounter = meter.createUpDownCounter(RequestInstrumentation.RequestsInFlight)
        this.errorsTotal = meter.createCounter(RequestInstrumentation.RequestErrorsTotal)
    }

    public static FromObservability(observability: Observability, logger: ILogger): RequestInstrumentation
    {
        return new RequestInstrumentation(observability.Tracer(), observability.Meter(), logger)
    }

    public InFlight(): number
    {
        return this.inFlight
    }

    public Run<T>(request: IRequestObservation, operation: () => T | Promise<T>, parent?: Context): Promise<T>
    {
        const active = parent ?? context.active()
        return context.with(active, () => this.tracer.startActiveSpan(request.method, span => this.Observe(span, request, operation)))
    }
    private async Observe<T>(span: Span, request: IRequestObservation, operation: () => T | Promise<T>): Promise<T>
    {
        const labels = { [RequestInstrumentation.MethodLabel]: request.method, [RequestInstrumentation.TenantLabel]: request.tenant }
        const log = this.logger.Child({ [RequestInstrumentation.CorrelationIdField]: span.spanContext().traceId, [RequestInstrumentation.MethodLabel]: request.method, [RequestInstrumentation.TenantLabel]: request.tenant })
        span.setAttribute(RequestInstrumentation.MethodLabel, request.method)
        span.setAttribute(RequestInstrumentation.TenantLabel, request.tenant)
        if (request.principal.length > 0)
        {
            span.setAttribute(RequestInstrumentation.PrincipalAttribute, request.principal)
        }
        this.inFlight += 1
        this.inFlightCounter.add(1, { [RequestInstrumentation.TenantLabel]: request.tenant })
        const start = performance.now()
        try
        {
            const result = await operation()
            span.setAttribute(RequestInstrumentation.OutcomeLabel, RequestOutcome.Ok)
            span.setStatus({ code: SpanStatusCode.OK })
            this.requestsTotal.add(1, { ...labels, [RequestInstrumentation.OutcomeLabel]: RequestOutcome.Ok })
            log.Info(RequestInstrumentation.RequestCompleted, { [RequestInstrumentation.OutcomeField]: RequestOutcome.Ok })
            return result
        }
        catch (error)
        {
            const className = error instanceof Error ? error.constructor.name : RequestInstrumentation.UnknownClass
            span.setAttribute(RequestInstrumentation.OutcomeLabel, RequestOutcome.Error)
            span.setAttribute(RequestInstrumentation.ErrorAttribute, className)
            span.recordException(error instanceof Error ? error : new Error(RequestInstrumentation.UnknownClass))
            span.setStatus({ code: SpanStatusCode.ERROR })
            this.requestsTotal.add(1, { ...labels, [RequestInstrumentation.OutcomeLabel]: RequestOutcome.Error })
            this.errorsTotal.add(1, { ...labels, [RequestInstrumentation.ClassLabel]: className })
            log.Error(RequestInstrumentation.RequestFailed, { [RequestInstrumentation.ClassField]: className })
            throw error
        }
        finally
        {
            this.inFlight -= 1
            this.inFlightCounter.add(-1, { [RequestInstrumentation.TenantLabel]: request.tenant })
            this.durationMs.record(performance.now() - start, labels)
            span.end()
        }
    }
}
