export enum LogLevel
{
    Info = 'info',
    Warn = 'warn',
    Error = 'error',
}

export type LogFields = Record<string, unknown>

/** Structured application logger: JSON-line records with a central, recursive field-name deny-list. */
export interface ILogger
{
    Info(message: string, fields?: LogFields): void
    Warn(message: string, fields?: LogFields): void
    Error(message: string, fields?: LogFields): void
    Child(fields: LogFields): ILogger
}

/**
 * JSON-line logger to an injectable sink. Field names are normalized (lowercased, `_` and `-` removed) and
 * checked against a deny-list at every depth of plain objects, arrays and Error props, so secret-bearing
 * values never reach output. Reserved record keys cannot be spoofed by caller fields.
 */
export class StructuredLogger implements ILogger
{
    private static readonly LevelKey = 'level'
    private static readonly TimestampKey = 'timestamp'
    private static readonly MessageKey = 'message'
    private static readonly LogErrorKey = 'logError'
    private static readonly FallbackReason = 'unserializable fields'
    private static readonly CircularMarker = '[Circular]'
    private static readonly ToJsonKey = 'toJSON'
    private static readonly ErrorNameKey = 'name'
    private static readonly ErrorMessageKey = 'message'
    private static readonly ErrorStackKey = 'stack'
    private static readonly Newline = '\n'
    private static readonly ReservedKeys: ReadonlySet<string> = new Set<string>([
        StructuredLogger.LevelKey,
        StructuredLogger.TimestampKey,
        StructuredLogger.MessageKey,
    ])
    private static readonly SecretFragments: readonly string[] = ['password', 'secret', 'token']
    private static readonly Denied: ReadonlySet<string> = new Set<string>([
        'redisurl',
        'otlpendpoint',
        'authorization',
        'xauthorization',
        'password',
        'token',
        'code',
        'verifier',
        'clientsecret',
        'secret',
        'fingerprint',
        'sessionid',
        'bearer',
        'masterkey',
    ])

    private readonly sink: (line: string) => void
    private readonly bound: LogFields

    private constructor(sink: (line: string) => void, bound: LogFields)
    {
        this.sink = sink
        this.bound = bound
    }

    public static ToStdout(): StructuredLogger
    {
        return new StructuredLogger(line => process.stdout.write(line), {})
    }

    public static ToSink(sink: (line: string) => void): StructuredLogger
    {
        return new StructuredLogger(sink, {})
    }

    public Info(message: string, fields?: LogFields): void
    {
        this.Emit(LogLevel.Info, message, fields)
    }

    public Warn(message: string, fields?: LogFields): void
    {
        this.Emit(LogLevel.Warn, message, fields)
    }

    public Error(message: string, fields?: LogFields): void
    {
        this.Emit(LogLevel.Error, message, fields)
    }

    public Child(fields: LogFields): ILogger
    {
        return new StructuredLogger(this.sink, { ...this.bound, ...fields })
    }

    private Emit(level: LogLevel, message: string, fields?: LogFields): void
    {
        const timestamp = new Date().toISOString()
        let line: string
        try
        {
            const record: Record<string, unknown> = {
                [StructuredLogger.LevelKey]: level,
                [StructuredLogger.TimestampKey]: timestamp,
                [StructuredLogger.MessageKey]: message,
            }
            const ancestors = new WeakSet<object>()
            StructuredLogger.MergeInto(record, this.bound, ancestors)
            if (fields !== undefined)
            {
                StructuredLogger.MergeInto(record, fields, ancestors)
            }
            line = JSON.stringify(record)
        }
        catch
        {
            line = JSON.stringify({
                [StructuredLogger.LevelKey]: level,
                [StructuredLogger.TimestampKey]: timestamp,
                [StructuredLogger.MessageKey]: message,
                [StructuredLogger.LogErrorKey]: StructuredLogger.FallbackReason,
            })
        }
        this.sink(line + StructuredLogger.Newline)
    }

    private static MergeInto(target: Record<string, unknown>, source: LogFields, ancestors: WeakSet<object>): void
    {
        for (const key of Object.keys(source))
        {
            if (StructuredLogger.IsDenied(key) || StructuredLogger.IsReserved(key))
            {
                continue
            }
            target[key] = StructuredLogger.Sanitize(source[key], ancestors)
        }
    }

    private static IsDenied(key: string): boolean
    {
        const normalized = key.toLowerCase().replace(/[_-]/g, '')
        if (StructuredLogger.Denied.has(normalized))
        {
            return true
        }
        return StructuredLogger.SecretFragments.some(fragment => normalized.includes(fragment))
    }

    private static IsReserved(key: string): boolean
    {
        return StructuredLogger.ReservedKeys.has(key.toLowerCase())
    }

    private static Sanitize(value: unknown, ancestors: WeakSet<object>): unknown
    {
        if (value === null || typeof value !== 'object')
        {
            return value
        }
        if (ancestors.has(value))
        {
            return StructuredLogger.CircularMarker
        }
        ancestors.add(value)
        try
        {
            return StructuredLogger.SanitizeObject(value, ancestors)
        }
        finally
        {
            ancestors.delete(value)
        }
    }

    private static SanitizeObject(value: object, ancestors: WeakSet<object>): unknown
    {
        if (Array.isArray(value))
        {
            return value.map(item => StructuredLogger.Sanitize(item, ancestors))
        }
        const toJson: unknown = Reflect.get(value, StructuredLogger.ToJsonKey)
        if (typeof toJson === 'function')
        {
            return StructuredLogger.Sanitize(Reflect.apply(toJson, value, []), ancestors)
        }
        const source: LogFields = value instanceof Error
            ? {
                ...value,
                [StructuredLogger.ErrorNameKey]: value.name,
                [StructuredLogger.ErrorMessageKey]: value.message,
                [StructuredLogger.ErrorStackKey]: value.stack,
            }
            : value as LogFields
        const result: Record<string, unknown> = {}
        for (const key of Object.keys(source))
        {
            if (StructuredLogger.IsDenied(key))
            {
                continue
            }
            result[key] = StructuredLogger.Sanitize(source[key], ancestors)
        }
        return result
    }
}

/** Default logger: writes nothing, so composing without a logger is byte-safe. */
export class NullLogger implements ILogger
{
    public Info(): void
    {
    }

    public Warn(): void
    {
    }

    public Error(): void
    {
    }

    public Child(): ILogger
    {
        return this
    }
}
