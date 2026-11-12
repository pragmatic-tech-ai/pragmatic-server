import type { ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { Disposable, Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { UnreadableIdpDirectoryRecordError } from '@pragmatic-tech-ai/todl-identity'
import type { IdpDirectorySnapshot, IdpDirectorySync, Tenant } from '@pragmatic-tech-ai/todl-identity'
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
 * serialized; a run requested while one is in flight coalesces into one more. A run whose snapshot differs from the
 * stored one in what security reads (authority, user states, group members; not the timestamp) or that deprovisions
 * anyone invalidates the security setting so the next scope reads the new snapshot; an unchanged run leaves it (and
 * every compiled scope and cursor) alone. The run's deprovisioned principal ids are raised on {@link Deprovisioned}
 * (controller ruling R27: Task 12 drops their stored tokens). A failing run (including a setting the store cannot
 * read) is logged by error name and keeps the previous snapshot (S3's `Run` stores the snapshot only after a
 * successful pull); a run never rejects. {@link Stop} waits for an in-flight run, so none outlives the lease.
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

    /** Disposes the host and resolves once an in-flight run (if any) has settled; never rejects. */
    public Stop(): Promise<void>
    {
        this.dispose()
        return this.running ?? Promise.resolve()
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
        try
        {
            const config = await this.setting.Config()
            if (config === undefined || this.disposed)
            {
                // Nothing is stored, so the directory has no groups or principals to ask about.
                return
            }
            const before = await this.StoredSnapshot()
            const result = await this.sync.Run(this.tenant, config)
            if (result.Deprovisioned.length > 0 || before === undefined || !IdpDirectorySyncHost.SameSecurity(before, result.Snapshot))
            {
                this.setting.Invalidate()
            }
            this.deprovisioned.Raise(result.Deprovisioned)
        }
        catch (error)
        {
            this.diagnostics.Failed(this.tenant.Id, error instanceof Error ? error : new Error(String(error)))
        }
    }

    /** The snapshot stored before the run; undefined when it cannot be read (the run then counts as a change). */
    private async StoredSnapshot(): Promise<IdpDirectorySnapshot | undefined>
    {
        try
        {
            return await this.setting.Snapshot()
        }
        catch (error)
        {
            if (error instanceof UnreadableIdpDirectoryRecordError) return undefined
            throw error
        }
    }

    /** Equal in what the security model reads: authority, every user's state and every group's members (order-free). */
    private static SameSecurity(a: IdpDirectorySnapshot, b: IdpDirectorySnapshot): boolean
    {
        if (a.Authoritative !== b.Authoritative || a.Users().size !== b.Users().size || a.Groups().size !== b.Groups().size)
        {
            return false
        }
        for (const [principalId, state] of a.Users())
        {
            if (b.Users().get(principalId) !== state) return false
        }
        for (const [groupId, members] of a.Groups())
        {
            const other = b.Groups().get(groupId)
            if (other === undefined) return false
            const left = new Set(members)
            const right = new Set(other)
            if (left.size !== right.size) return false
            for (const member of left)
            {
                if (!right.has(member)) return false
            }
        }
        return true
    }
}
