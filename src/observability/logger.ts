export enum LogLevel
{
    Info = 'info',
    Warn = 'warn',
    Error = 'error',
}

export type LogFields = Record<string, unknown>

/** Structured application logger: JSON-line records with a central field-name deny-list. */
export interface ILogger
{
    Info(message: string, fields?: LogFields): void
    Warn(message: string, fields?: LogFields): void
    Error(message: string, fields?: LogFields): void
    Child(fields: LogFields): ILogger
}

/** JSON-line logger to an injectable sink. A hoisted deny-list of field names is dropped before serialization so secret-bearing values never reach output. */
export class StructuredLogger implements ILogger
{
    private static readonly LevelKey = 'level'
    private static readonly TimestampKey = 'timestamp'
    private static readonly MessageKey = 'message'
    private static readonly Newline = '\n'
    private static readonly Denied: ReadonlySet<string> = new Set<string>([
        'redisurl',
        'otlpendpoint',
        'authorization',
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
        const record: Record<string, unknown> = {
            [StructuredLogger.LevelKey]: level,
            [StructuredLogger.TimestampKey]: new Date().toISOString(),
            [StructuredLogger.MessageKey]: message,
        }
        StructuredLogger.Merge(record, this.bound)
        if (fields !== undefined)
        {
            StructuredLogger.Merge(record, fields)
        }
        this.sink(JSON.stringify(record) + StructuredLogger.Newline)
    }

    private static Merge(target: Record<string, unknown>, source: LogFields): void
    {
        for (const key of Object.keys(source))
        {
            if (StructuredLogger.Denied.has(key.toLowerCase()))
            {
                continue
            }
            target[key] = source[key]
        }
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
