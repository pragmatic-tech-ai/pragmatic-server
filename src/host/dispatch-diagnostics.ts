import { StructuredLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'

/**
 * Where a connection's request dispatch reports the failures the client only sees scrubbed: an unexpected error (the
 * wire says "internal error") and a data source that failed (the wire names the source, never the cause).
 */
export interface IDispatchDiagnostics
{
    Unexpected(method: string, error: unknown): void
    DataSourceFailed(method: string, error: unknown): void
}

/** Reports each scrubbed failure on the server logger with the whole error (the logger redacts secret-named fields). */
export class LoggerDispatchDiagnostics implements IDispatchDiagnostics
{
    private static readonly UnexpectedLine = 'request failed unexpectedly; the client was told "internal error"'
    private static readonly DataSourceLine = 'request failed: a data source did not answer'
    private static readonly MethodField = 'method'
    private static readonly ErrorField = 'error'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public Unexpected(method: string, error: unknown): void
    {
        this.logger.Error(LoggerDispatchDiagnostics.UnexpectedLine, LoggerDispatchDiagnostics.Fields(method, error))
    }

    public DataSourceFailed(method: string, error: unknown): void
    {
        this.logger.Warn(LoggerDispatchDiagnostics.DataSourceLine, LoggerDispatchDiagnostics.Fields(method, error))
    }

    private static Fields(method: string, error: unknown): Record<string, unknown>
    {
        return { [LoggerDispatchDiagnostics.MethodField]: method, [LoggerDispatchDiagnostics.ErrorField]: error }
    }
}
