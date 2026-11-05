import type { IAccessAuditSink } from '../host/access-audit.js'
import type { ILogger } from '../observability/logger.js'

/** What a shutdown stops first: the server or worker host (no new requests, so no new audit writes, after it). */
export interface IShutdownHost
{
    DisposeAsync(): Promise<void>
}

/** The cloud bundle (its database pool backs the SQL audit sink), disposed last. */
export interface IShutdownBundle
{
    Dispose(): Promise<void>
}

/**
 * A server or worker process's shutdown, once: stop the host, drain the access-audit sink (fire-and-forget writes such as
 * SqlAuditAccessSink's inserts finish instead of being cut off), then dispose the cloud bundle. A host failure is logged and the
 * remaining steps still run. Run resolves with the exit code, or undefined when a shutdown already ran.
 */
export class GracefulShutdown
{
    private static readonly EventKey = 'event'
    private static readonly ShutdownEvent = 'shutdown'
    private static readonly ShutdownErrorEvent = 'shutdown-error'
    private static readonly UnknownError = 'unknown error'
    private static readonly ExitOk = 0
    private static readonly ExitFailed = 1

    private started = false

    public constructor(
        private readonly host: IShutdownHost,
        private readonly audit: IAccessAuditSink,
        private readonly bundle: IShutdownBundle | undefined,
        private readonly logger: ILogger,
        private readonly shutdownLine: string,
        private readonly errorPrefix: string)
    {
    }

    public async Run(): Promise<number | undefined>
    {
        const C = GracefulShutdown
        if (this.started)
        {
            return undefined
        }
        this.started = true
        this.logger.Info(this.shutdownLine, { [C.EventKey]: C.ShutdownEvent })
        let code = C.ExitOk
        try
        {
            await this.host.DisposeAsync()
        }
        catch (error)
        {
            this.logger.Error(this.errorPrefix + (error instanceof Error ? error.message : C.UnknownError), { [C.EventKey]: C.ShutdownErrorEvent })
            code = C.ExitFailed
        }
        await this.audit.Drain()
        await this.DisposeBundle()
        return code
    }

    private async DisposeBundle(): Promise<void>
    {
        if (this.bundle === undefined)
        {
            return
        }
        try
        {
            await this.bundle.Dispose()
        }
        catch
        {
            // best-effort: a bundle teardown failure must not block exit
        }
    }
}
