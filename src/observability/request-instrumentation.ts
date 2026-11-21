import { context, SpanStatusCode, type Tracer, type Meter, type Counter, type Histogram, type UpDownCounter, type Context, type Span } from '@opentelemetry/api'
import { performance } from 'node:perf_hooks'
import type { Observability } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'

export enum RequestOutcome
{
    Ok = 'ok',
    Error = 'error',
}

/** The identifiers one request is observed under. principal rides the span only, never a metric label. */
export interface IRequestObservation
{
    method: string
    environment: string
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
    private static readonly EnvironmentLabel = 'environment'
    private static readonly OutcomeKey = 'outcome'
    private static readonly ClassKey = 'class'
    private static readonly PrincipalAttribute = 'principal'
    private static readonly ErrorAttribute = 'error'
    private static readonly CorrelationIdField = 'correlationId'
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
        const labels = { [RequestInstrumentation.MethodLabel]: request.method, [RequestInstrumentation.EnvironmentLabel]: request.environment }
        let log: ILogger = this.logger
        const start = performance.now()
        try
        {
            this.Safely(() =>
            {
                log = this.logger.Child({ [RequestInstrumentation.CorrelationIdField]: span.spanContext().traceId, [RequestInstrumentation.MethodLabel]: request.method, [RequestInstrumentation.EnvironmentLabel]: request.environment })
                span.setAttribute(RequestInstrumentation.MethodLabel, request.method)
                span.setAttribute(RequestInstrumentation.EnvironmentLabel, request.environment)
                if (request.principal.length > 0)
                {
                    span.setAttribute(RequestInstrumentation.PrincipalAttribute, request.principal)
                }
            })
            this.inFlight += 1
            this.Safely(() => this.inFlightCounter.add(1, { [RequestInstrumentation.EnvironmentLabel]: request.environment }))
            const result = await operation()
            this.Safely(() => this.RecordSuccess(span, labels, log))
            return result
        }
        catch (error)
        {
            this.Safely(() => this.RecordFailure(span, labels, log, error))
            throw error
        }
        finally
        {
            this.inFlight -= 1
            this.Safely(() => this.inFlightCounter.add(-1, { [RequestInstrumentation.EnvironmentLabel]: request.environment }))
            this.Safely(() => this.durationMs.record(performance.now() - start, labels))
            this.Safely(() => span.end())
        }
    }

    private RecordSuccess(span: Span, labels: Record<string, string>, log: ILogger): void
    {
        span.setAttribute(RequestInstrumentation.OutcomeKey, RequestOutcome.Ok)
        span.setStatus({ code: SpanStatusCode.OK })
        this.requestsTotal.add(1, { ...labels, [RequestInstrumentation.OutcomeKey]: RequestOutcome.Ok })
        log.Info(RequestInstrumentation.RequestCompleted, { [RequestInstrumentation.OutcomeKey]: RequestOutcome.Ok })
    }

    private RecordFailure(span: Span, labels: Record<string, string>, log: ILogger, error: unknown): void
    {
        const className = error instanceof Error ? error.constructor.name : RequestInstrumentation.UnknownClass
        span.setAttribute(RequestInstrumentation.OutcomeKey, RequestOutcome.Error)
        span.setAttribute(RequestInstrumentation.ErrorAttribute, className)
        span.setStatus({ code: SpanStatusCode.ERROR })
        this.requestsTotal.add(1, { ...labels, [RequestInstrumentation.OutcomeKey]: RequestOutcome.Error })
        this.errorsTotal.add(1, { ...labels, [RequestInstrumentation.ClassKey]: className })
        log.Error(RequestInstrumentation.RequestFailed, { [RequestInstrumentation.ClassKey]: className })
    }

    /** Observability must never alter a request's outcome: a throwing sink is swallowed. */
    private Safely(action: () => void): void
    {
        try
        {
            action()
        }
        catch
        {
            // degrade-safe: telemetry failure is not a request failure
        }
    }
}
