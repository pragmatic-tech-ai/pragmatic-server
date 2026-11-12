import type { ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { Disposable, Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IdpDirectorySync, Tenant } from '@pragmatic-tech-ai/todl-identity'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import type { EnvironmentSecuritySetting } from './environment-security-setting.js'

/** A repeating timer: calls `run` every `ms` for as long as the returned handle is not disposed. */
export interface ISyncTimer
{
    Every(ms: number, run: () => void): IDisposable
}

/** The default timer over an unref'd `setInterval`, so a lone pending sync never keeps the process alive. */
export class IntervalSyncTimer implements ISyncTimer
{
    public Every(ms: number, run: () => void): IDisposable
    {
        const handle = setInterval(run, ms)
        handle.unref?.()
        return new Disposable(() => clearInterval(handle))
    }
}

/** Where a failed sync is reported (by error name only, no directory content). */
export interface ISyncDiagnostics
{
    Failed(tenantId: string, error: Error): void
}

/** Reports a failed sync as one warning on the server logger, by error name only. */
export class LoggerSyncDiagnostics implements ISyncDiagnostics
{
    private static readonly Line = 'IdP directory sync failed, previous snapshot kept: tenant '
    private static readonly Separator = ': '

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public Failed(tenantId: string, error: Error): void
    {
        this.logger.Warn(LoggerSyncDiagnostics.Line + tenantId + LoggerSyncDiagnostics.Separator + error.name)
    }
}

/** The subscribe side of a deprovisioned-principals signal over the runtime Signal primitive. */
class DeprovisionedSignal implements ISignal<readonly string[]>
{
    private readonly signal = new Signal<readonly string[]>()

    public Subscribe(handler: (value: readonly string[]) => void): ISubscription
    {
        return this.signal.subscribe(handler)
    }

    public Raise(value: readonly string[]): void
    {
        this.signal.emit(value)
    }
}

/**
 * Drives one tenant's IdP directory sync (S3 `IdpDirectorySync`) on a poll: one run when its server starts serving (the
 * creator calls {@link RunNow}), one after each admin `SetSecurityModel`, then every {@link IntervalMs} while the server
 * lives. A `PragmaticServer` exists only while it holds the tenant lease, so exactly one replica polls. Runs are
 * serialized; a run requested while one is in flight coalesces into one more. After a run the security setting is
 * invalidated so the next scope reads the new snapshot, and the run's deprovisioned principal ids are raised on
 * {@link Deprovisioned} (controller ruling R27: Task 12 drops their stored tokens). A failing run is logged by error
 * name and keeps the previous snapshot (S3's `Run` stores the snapshot only after a successful pull).
 */
export class IdpDirectorySyncHost implements IDisposable
{
    public static readonly IntervalMs = 300000

    public readonly Deprovisioned: ISignal<readonly string[]>

    private readonly deprovisioned = new DeprovisionedSignal()
    private readonly timer: IDisposable
    private running: Promise<void> | undefined
    private pending = false
    private disposed = false

    public constructor(
        private readonly sync: IdpDirectorySync,
        private readonly setting: EnvironmentSecuritySetting,
        private readonly tenant: Tenant,
        timer: ISyncTimer = new IntervalSyncTimer(),
        private readonly diagnostics: ISyncDiagnostics = new LoggerSyncDiagnostics())
    {
        this.Deprovisioned = this.deprovisioned
        this.timer = timer.Every(IdpDirectorySyncHost.IntervalMs, () => void this.RunNow())
    }

    /** Requests a sync now. Resolves when the current (and any coalesced) run settles; a failing run resolves, never rejects. */
    public RunNow(): Promise<void>
    {
        if (this.disposed)
        {
            return Promise.resolve()
        }
        if (this.running !== undefined)
        {
            this.pending = true
            return this.running
        }
        this.running = this.Loop()
        return this.running
    }

    public dispose(): void
    {
        this.disposed = true
        this.timer.dispose()
    }

    private async Loop(): Promise<void>
    {
        try
        {
            do
            {
                this.pending = false
                await this.RunOnce()
            }
            while (this.pending && !this.disposed)
        }
        finally
        {
            this.running = undefined
        }
    }

    private async RunOnce(): Promise<void>
    {
        const config = await this.setting.Config()
        if (config === undefined)
        {
            // Nothing is stored, so the directory has no groups or principals to ask about.
            return
        }
        try
        {
            const result = await this.sync.Run(this.tenant, config)
            this.setting.Invalidate()
            this.deprovisioned.Raise(result.Deprovisioned)
        }
        catch (error)
        {
            this.diagnostics.Failed(this.tenant.Id, error instanceof Error ? error : new Error(String(error)))
        }
    }
}
