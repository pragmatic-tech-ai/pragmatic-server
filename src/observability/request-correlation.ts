import { context, propagation, trace } from '@opentelemetry/api'
import type { Context, TextMapGetter, TextMapSetter } from '@opentelemetry/api'
import type { IncomingHttpHeaders } from 'node:http'

/** W3C traceparent in/out at the front doors and across the gateway->worker hop. */
export class RequestCorrelation
{
    private static readonly Getter: TextMapGetter<IncomingHttpHeaders> = {
        keys(carrier: IncomingHttpHeaders): string[]
        {
            return Object.keys(carrier)
        },
        get(carrier: IncomingHttpHeaders, key: string): string | undefined
        {
            const value = carrier[key]
            return Array.isArray(value) ? value[0] : value
        },
    }

    private static readonly Setter: TextMapSetter<Record<string, string>> = {
        set(carrier: Record<string, string>, key: string, value: string): void
        {
            carrier[key] = value
        },
    }

    /** Continues an inbound trace; a malformed or absent traceparent yields the active (root) context, never throws. */
    public static Extract(headers: IncomingHttpHeaders): Context
    {
        return propagation.extract(context.active(), headers, RequestCorrelation.Getter)
    }

    public static Inject(parent: Context, headers: Record<string, string>): void
    {
        propagation.inject(parent, headers, RequestCorrelation.Setter)
    }

    public static TraceIdOf(ctx: Context): string | undefined
    {
        const span = trace.getSpan(ctx)
        const traceId = span?.spanContext().traceId
        return traceId !== undefined && traceId.length > 0 ? traceId : undefined
    }
}
