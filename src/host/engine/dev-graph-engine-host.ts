import { CommitKind, GraphEngine, StorageKind, WriteOp } from '@pragmatic-tech-ai/graph'
import type { BatchOp, ConnectorChangeSet, ICommitApplied, IConnectorTransaction, IGraphConnector, ISchemaDescription, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { Severity } from '@pragmatic-tech-ai/todl'
import type { Diagnostic, Repository } from '@pragmatic-tech-ai/todl'
import { TodlFileConnector } from '@pragmatic-tech-ai/todl/engine'
import { Disposable, Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import type { IDevLanguageService } from './dev-language-service.js'
import type { IDevSolution } from './dev-solution.js'
import { DevSnapshotSource } from './dev-snapshot-source.js'
import type { DevSnapshot } from './dev-snapshot-source.js'
import { SavedMemberReader } from './saved-member-reader.js'
import { LoggerDevWriteDiagnostics, ServerModelWorkspace, WriteFenceSlot } from './server-model-workspace.js'
import type { IDevWriteDiagnostics, IWriteFence } from './server-model-workspace.js'

/**
 * The dev tenant's embedded graph engine, run from the saved solution. `Changed` is raised after each applied
 * upgrade (a saved edit recompiled to a new description); `Repository` / `Description` are the snapshot the engine
 * currently runs, and `Snapshot` is that whole snapshot in one read (its `Description.Version` equals the engine's
 * `SchemaVersion` except while an upgrade is being applied).
 */
export interface IDevGraphEngine
{
    Engine(): Promise<GraphEngine>
    Repository(): Promise<Repository>
    Description(): Promise<ISchemaDescription>
    Snapshot(): Promise<DevSnapshot>
    /**
     * Resolves once every upgrade already asked for has finished: a pending debounce is cut short (its pass runs now)
     * and a running pass is awaited. A writer calls it after its commit, whose saved files raised the change.
     */
    WhenUpgraded(): Promise<void>
    /**
     * Resolves once none of the engine's own connector transactions is in flight: every file write a commit began,
     * including one still running after the write-through timed out and its late revert, has settled. A writer awaits
     * it before releasing its write lease, so the next writer never starts while files are still being written.
     */
    WhenWritesSettled(): Promise<void>
    /**
     * Installs the writer's fence (its write lease) for the engine's own `.todl` writes until the handle is disposed:
     * each draft session checks it before its first file write and refuses the write (Stale) once it no longer holds.
     */
    InstallWriteFence(fence: IWriteFence): IDisposable
    readonly Changed: ISignal<void>
}

/** The language-service change the host follows: any reload of the solution graph (TODL's `GraphChanged`). */
export interface IGraphChangedSource
{
    subscribe(handler: () => void): IDisposable
}

/** The language-service slice the engine host needs: the dev write slice plus its graph-change signal. */
export interface IDevEngineLanguageService extends IDevLanguageService
{
    readonly GraphChanged: IGraphChangedSource
}

/** Runs `work` once after `delayMs` unless the returned handle is disposed first (the upgrade debounce). */
export interface IUpgradeTimer
{
    Start(delayMs: number, work: () => void): IDisposable
}

/**
 * A wait bounded by a timer seam: resolves true when `work` settles first, false when `ms` elapses first. A rejection of
 * `work` counts as settled (the caller only waits for it to stop).
 */
export class BoundedWait
{
    public static Within(work: Promise<unknown>, ms: number, timer: IUpgradeTimer): Promise<boolean>
    {
        return new Promise<boolean>(resolve =>
        {
            const handle = timer.Start(ms, () => resolve(false))
            const done = (): void =>
            {
                handle.dispose()
                resolve(true)
            }
            work.then(done, done)
        })
    }
}

export class TimeoutUpgradeTimer implements IUpgradeTimer
{
    public Start(delayMs: number, work: () => void): IDisposable
    {
        const handle = setTimeout(work, delayMs)
        // a pending recompile never keeps the process alive on its own
        handle.unref?.()
        return new Disposable(() => clearTimeout(handle))
    }
}

/** Where an upgrade that did not apply is reported (it is never fatal: the engine keeps its previous version). */
export interface IDevEngineDiagnostics
{
    UpgradeFailed(error: unknown): void
    /** A `Changed` subscriber threw (the upgrade itself applied; later upgrades are unaffected). */
    ChangedHandlerFailed(error: unknown): void
    /**
     * The engine's own connector writes did not settle within `DevGraphEngineHost.MaxSettleMs` (a hung connector call):
     * the upgrade pass or the teardown stopped waiting and went on.
     */
    WritesUnsettled(): void
}

/** Reports each failure as one error on the server logger, by error name only (messages can carry paths). */
export class LoggerDevEngineDiagnostics implements IDevEngineDiagnostics
{
    private static readonly Line = 'dev graph engine kept its previous version; the upgrade failed: '
    private static readonly HandlerLine = 'dev graph engine upgraded, but a Changed subscriber failed: '
    private static readonly UnsettledLine = 'dev graph engine writes did not settle in time; the host went on without them'
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public UpgradeFailed(error: unknown): void
    {
        this.logger.Error(LoggerDevEngineDiagnostics.Line + LoggerDevEngineDiagnostics.NameOf(error))
    }

    public ChangedHandlerFailed(error: unknown): void
    {
        this.logger.Error(LoggerDevEngineDiagnostics.HandlerLine + LoggerDevEngineDiagnostics.NameOf(error))
    }

    public WritesUnsettled(): void
    {
        this.logger.Error(LoggerDevEngineDiagnostics.UnsettledLine)
    }

    private static NameOf(error: unknown): string
    {
        return error instanceof Error ? error.name : LoggerDevEngineDiagnostics.UnknownName
    }
}

/** The saved sources compiled with errors (a broken save, or a commit only half on disk): the snapshot is not applied. */
export class DevSnapshotCompileError extends Error
{
    private static readonly ErrorName = 'DevSnapshotCompileError'
    private static readonly MessagePrefix = 'the saved sources do not compile; errors: '

    public constructor(public readonly Diagnostics: readonly Diagnostic[])
    {
        super(DevSnapshotCompileError.MessagePrefix + Diagnostics.length)
        this.name = DevSnapshotCompileError.ErrorName
    }

    /** Throws when `diagnostics` holds an error. */
    public static ThrowIfFailed(diagnostics: readonly Diagnostic[]): void
    {
        const errors = diagnostics.filter(diagnostic => diagnostic.severity === Severity.Error)
        if (errors.length > 0) throw new DevSnapshotCompileError(errors)
    }
}

/**
 * Counts the engine's own connector transactions in flight: from Begin until the engine has finalized the commit
 * (`Finalized`, raised on the engine's CommitApplied), a failed Commit, or a Revert settles, and again while a Revert
 * after Commit (compensation) runs. A committed transaction therefore stays in flight until the engine side of the
 * write-through completes, so the upgrade drain never reads while the engine is still finalizing. `Begun` counts every
 * transaction ever begun, so a reader can tell whether one started while it read.
 */
export class EngineWriteTracker
{
    private active = 0
    private begun = 0
    private waiters: (() => void)[] = []
    /** Transactions whose connector Commit returned and whose engine Finalize has not been observed yet. */
    private readonly finalizing = new Set<TrackedTransaction>()

    public get Begun(): number
    {
        return this.begun
    }

    /** True when nothing is in flight and no transaction began since `begun` was read. */
    public Quiet(begun: number): boolean
    {
        return this.active === 0 && this.begun === begun
    }

    /** Resolves once no transaction is in flight (at once when none is). */
    public Settled(): Promise<void>
    {
        if (this.active === 0) return Promise.resolve()
        return new Promise<void>(resolve => { this.waiters.push(resolve) })
    }

    public Enter(): void
    {
        this.active += 1
        this.begun += 1
    }

    public Exit(): void
    {
        this.active -= 1
        if (this.active > 0) return
        const waiters = this.waiters
        this.waiters = []
        for (const resolve of waiters) resolve()
    }

    /** A transaction committed on the connector side: it stays in flight until the engine finalizes (or it reverts). */
    public AwaitFinalize(transaction: TrackedTransaction): void
    {
        this.finalizing.add(transaction)
    }

    /** Leaves the finalizing set (a compensating Revert); false when the transaction was not in it. */
    public Unfinalize(transaction: TrackedTransaction): boolean
    {
        return this.finalizing.delete(transaction)
    }

    /**
     * The engine applied a commit (CommitApplied, after Finalize). Only the committed transactions that belong to it
     * leave flight: a connector is never told its commit number, so a transaction matches the applied commit when it
     * is a Batch whose ops include one of the changes the transaction was given (a synthetic DETACH unlink matches the
     * batch's DeleteNode of either end). An upgrade or schema change, or another batch such
     * as an upgrade's seed commit, never ends a tracked transaction early (N3).
     */
    public Finalized(applied: ICommitApplied): void
    {
        if (applied.Kind !== CommitKind.Batch) return
        const ops = new Set(applied.Batch.Ops().map(op => ChangeKey.Of(op)))
        for (const transaction of [...this.finalizing])
        {
            if (!transaction.BelongsTo(ops)) continue
            this.finalizing.delete(transaction)
            transaction.End()
        }
    }

    /** The engine is gone: no Finalize will come, so every committed transaction leaves flight. */
    public Abandon(): void
    {
        const done = [...this.finalizing]
        this.finalizing.clear()
        for (const transaction of done) transaction.End()
    }

    public Track(connector: IGraphConnector): IGraphConnector
    {
        return new TrackedConnector(connector, this)
    }
}

/** The identity of one batch op, as both the commit's batch and a connector change set carry it. */
class ChangeKey
{
    private static readonly Separator = '\u0000'

    public static Of(op: BatchOp): string
    {
        const parts: string[] = [String(op.Op)]
        switch (op.Op)
        {
            case WriteOp.CreateNode:
            case WriteOp.DeleteNode:
            case WriteOp.SetOwner:
                parts.push(op.PublicId)
                break
            case WriteOp.SetProperty:
                parts.push(op.PublicId, op.Member, String(op.Value))
                break
            case WriteOp.Link:
            case WriteOp.Unlink:
                parts.push(op.From, op.Relationship, op.To)
                break
        }
        return parts.join(ChangeKey.Separator)
    }
}

class TrackedConnector implements IGraphConnector
{
    public readonly Name: string

    public constructor(private readonly inner: IGraphConnector, private readonly tracker: EngineWriteTracker)
    {
        this.Name = inner.Name
    }

    public async Begin(): Promise<IConnectorTransaction>
    {
        this.tracker.Enter()
        try
        {
            return new TrackedTransaction(await this.inner.Begin(), this.tracker)
        }
        catch (error)
        {
            this.tracker.Exit()
            throw error
        }
    }
}

class TrackedTransaction implements IConnectorTransaction
{
    private ended = false
    private readonly keys = new Set<string>()

    public constructor(private readonly inner: IConnectorTransaction, private readonly tracker: EngineWriteTracker)
    {
    }

    public Apply(changes: ConnectorChangeSet): Promise<void>
    {
        for (const change of changes.Changes)
        {
            this.keys.add(ChangeKey.Of(change))
            if (change.Op === WriteOp.Unlink)
            {
                // a synthetic DETACH unlink is not a batch op: it belongs to the batch that deletes one of its ends
                this.keys.add(ChangeKey.Of({ Op: WriteOp.DeleteNode, PublicId: change.From }))
                this.keys.add(ChangeKey.Of({ Op: WriteOp.DeleteNode, PublicId: change.To }))
            }
        }
        return this.inner.Apply(changes)
    }

    /** True when the applied commit's ops (ChangeKey) include one of the changes this transaction was given. */
    public BelongsTo(ops: ReadonlySet<string>): boolean
    {
        for (const key of this.keys)
        {
            if (ops.has(key)) return true
        }
        return false
    }

    /** A committed transaction stays in flight until the engine finalizes (EngineWriteTracker.Finalized); a failed one ends. */
    public async Commit(): Promise<void>
    {
        try
        {
            await this.inner.Commit()
        }
        catch (error)
        {
            this.End()
            throw error
        }
        if (!this.ended) this.tracker.AwaitFinalize(this)
    }

    public async Revert(): Promise<void>
    {
        // committed but not finalized (the engine Finalize failed, or the write-through timed out): this compensation
        // ends the flight that began at Begin
        const finalizing = this.tracker.Unfinalize(this)
        // a Revert after the transaction ended compensates: it writes files again, so it is in flight while it runs
        const compensating = this.ended
        if (compensating) this.tracker.Enter()
        try
        {
            await this.inner.Revert()
        }
        finally
        {
            if (compensating) this.tracker.Exit()
            else if (finalizing || !this.ended) this.End()
        }
    }

    public End(): void
    {
        if (this.ended) return
        this.ended = true
        this.tracker.Exit()
    }
}

/** The subscribe side of the host's change signal. */
class DevEngineChanged implements ISignal<void>
{
    private readonly signal = new Signal<void>()

    public Subscribe(handler: (value: void) => void): ISubscription
    {
        return this.signal.subscribe(handler)
    }

    public Raise(): void
    {
        this.signal.emit(undefined)
    }
}

/**
 * An open engine with the snapshot it currently runs, the language-service subscription that upgrades it and the
 * CommitApplied subscription that tells the write tracker the engine finalized.
 */
class OpenedEngine implements IDisposable
{
    public constructor(
        public readonly Engine: GraphEngine,
        public readonly Source: DevSnapshotSource,
        private readonly subscription: IDisposable,
        private readonly applied: ISubscription,
        private readonly writes: EngineWriteTracker,
        public Snapshot: DevSnapshot,
    )
    {
    }

    public async dispose(): Promise<void>
    {
        this.subscription.dispose()
        this.applied.dispose()
        await this.Engine.dispose()
        // no Finalize comes after the engine is gone: nothing may wait on one
        this.writes.Abandon()
    }
}

/**
 * Hosts the dev tenant's {@link GraphEngine}: opened (memory storage, the `.todl` file connector over the server
 * model workspace) on first use from the saved snapshot, then upgraded as saved sources change.
 *
 * Upgrade: every language-service `GraphChanged` (re)arms a debounce of {@link DevGraphEngineHost.UpgradeDebounceMs};
 * the handler does nothing else, so no upgrade ever runs inside the language-service queue or a commit's refresh.
 * When it elapses, a single drain loop recompiles (`DevSnapshotSource.Current()`) and upgrades when the version
 * differs; changes arriving meanwhile coalesce into one more pass that reads the latest saved state. Before reading,
 * the drain waits until none of the engine's own connector transactions is in flight, and re-reads when one began
 * while it read, so a multi-file commit only half on disk is never applied. A recompile that throws or has compile
 * errors is reported to the diagnostics and not applied: the engine keeps its previous version, the next change
 * retries. Readers already open keep their snapshot (the engine's MVCC). `Changed` is raised after each applied
 * upgrade.
 */
export class DevGraphEngineHost implements IDevGraphEngine, IDisposable
{
    public static readonly UpgradeDebounceMs = 150
    /** Bounds the connector phase of each write-through (the engine's PrepareTimeoutMs), explicitly rather than by default. */
    public static readonly PrepareTimeoutMs = 30000
    /** How long the upgrade drain and the teardown wait for the engine's own writes to settle before going on (F-f). */
    public static readonly MaxSettleMs = 2 * DevGraphEngineHost.PrepareTimeoutMs
    private static readonly DisposedMessage = 'The dev graph engine host has been disposed'

    public readonly Changed: ISignal<void>

    private readonly changed = new DevEngineChanged()
    private readonly writes = new EngineWriteTracker()
    private readonly fences = new WriteFenceSlot()
    private opening: Promise<OpenedEngine> | undefined
    private debounce: IDisposable | undefined
    private draining: Promise<void> | undefined
    private pending = false
    private disposing: Promise<void> | undefined

    public constructor(
        private readonly solution: () => Promise<IDevSolution | undefined>,
        private readonly languageService: () => Promise<IDevEngineLanguageService>,
        private readonly timer: IUpgradeTimer = new TimeoutUpgradeTimer(),
        private readonly diagnostics: IDevEngineDiagnostics = new LoggerDevEngineDiagnostics(),
        private readonly writeDiagnostics: IDevWriteDiagnostics = new LoggerDevWriteDiagnostics(),
        private readonly prepareTimeoutMs: number = DevGraphEngineHost.PrepareTimeoutMs,
        /** The timer seam bounding the settle waits ({@link DevGraphEngineHost.MaxSettleMs}). */
        private readonly settleTimer: IUpgradeTimer = new TimeoutUpgradeTimer(),
    )
    {
        this.Changed = this.changed
    }

    public async Engine(): Promise<GraphEngine>
    {
        return (await this.Opened()).Engine
    }

    public async Repository(): Promise<Repository>
    {
        return (await this.Opened()).Snapshot.Repository
    }

    public async Description(): Promise<ISchemaDescription>
    {
        return (await this.Opened()).Snapshot.Description
    }

    public async Snapshot(): Promise<DevSnapshot>
    {
        return (await this.Opened()).Snapshot
    }

    /**
     * Resolves once every upgrade already asked for has finished: a pending debounce is cut short (one drain pass runs
     * now instead of when it elapses) and the running drain is awaited. At once when nothing is pending or running, or
     * the host is disposing. `DevCypherExecute` calls it after a commit: the commit's saved files raised GraphChanged
     * (the language service reloads them before each `WhenIdle` the commit awaits), so its upgrade is pending.
     */
    public WhenUpgraded(): Promise<void>
    {
        if (this.disposing !== undefined) return Promise.resolve()
        if (this.debounce !== undefined)
        {
            this.debounce.dispose()
            this.debounce = undefined
            this.pending = true
            this.draining ??= this.Drain()
        }
        return this.draining ?? Promise.resolve()
    }

    public WhenWritesSettled(): Promise<void>
    {
        return this.writes.Settled()
    }

    /** True once the engine has been asked to open (by a read, a query or a write); false before its first use. */
    public get IsOpen(): boolean
    {
        return this.opening !== undefined
    }

    public InstallWriteFence(fence: IWriteFence): IDisposable
    {
        return this.fences.Install(fence)
    }

    /** Cancels a pending upgrade, waits for a running one, then disposes the engine. Idempotent. */
    public dispose(): Promise<void>
    {
        this.disposing ??= this.Teardown()
        return this.disposing
    }

    private Opened(): Promise<OpenedEngine>
    {
        if (this.disposing !== undefined) return Promise.reject(new Error(DevGraphEngineHost.DisposedMessage))
        this.opening ??= this.Open().catch((error: unknown) =>
        {
            this.opening = undefined
            throw error
        })
        return this.opening
    }

    private async Open(): Promise<OpenedEngine>
    {
        const languageService = await this.languageService()
        const reader = new SavedMemberReader(languageService)
        const source = new DevSnapshotSource(this.solution, languageService, reader)
        const workspace = new ServerModelWorkspace(this.solution, languageService, this.writeDiagnostics, reader, this.fences)
        // subscribed before the first read, so a save racing the open is upgraded once it is open
        const subscription = languageService.GraphChanged.subscribe(() => this.Schedule())
        try
        {
            const snapshot = await source.Current()
            const connector = this.writes.Track(new TodlFileConnector(workspace))
            const engine = await GraphEngine.Open({
                Description: snapshot.Description,
                Storage: { Kind: StorageKind.Memory },
                Connectors: [connector],
                PrepareTimeoutMs: this.prepareTimeoutMs,
            })
            const applied = engine.CommitApplied.Subscribe(commit => this.writes.Finalized(commit))
            return new OpenedEngine(engine, source, subscription, applied, this.writes, snapshot)
        }
        catch (error)
        {
            subscription.dispose()
            throw error
        }
    }

    /** The GraphChanged handler: (re)arms the debounce, nothing more. */
    private Schedule(): void
    {
        if (this.disposing !== undefined) return
        this.debounce?.dispose()
        this.debounce = this.timer.Start(DevGraphEngineHost.UpgradeDebounceMs, () => this.Elapsed())
    }

    private Elapsed(): void
    {
        this.debounce = undefined
        this.pending = true
        this.draining ??= this.Drain()
    }

    /** One upgrade pass per pending request; requests arriving during a pass coalesce into the next. */
    private async Drain(): Promise<void>
    {
        try
        {
            while (this.pending && this.disposing === undefined)
            {
                this.pending = false
                await this.UpgradeOnce()
            }
        }
        finally
        {
            // cleared with no await after the last `pending` check, so a later request always starts a new drain
            this.draining = undefined
        }
    }

    private async UpgradeOnce(): Promise<void>
    {
        const opened = await this.opening?.catch(() => undefined)
        // nothing open: the first Engine() call opens from the latest saved state
        if (opened === undefined || this.disposing !== undefined) return
        let applied = false
        try
        {
            if (!(await BoundedWait.Within(this.writes.Settled(), DevGraphEngineHost.MaxSettleMs, this.settleTimer)))
            {
                // a hung connector call: report and go on; the next change retries once the writes settle
                this.diagnostics.WritesUnsettled()
                return
            }
            const begun = this.writes.Begun
            const snapshot = await opened.Source.Current()
            if (!this.writes.Quiet(begun))
            {
                // an engine commit began while the solution was read: the read may be torn, read again once it settles
                this.pending = true
                return
            }
            DevSnapshotCompileError.ThrowIfFailed(snapshot.CompileDiagnostics)
            if (snapshot.Description.Version === opened.Engine.SchemaVersion) return
            // The one remaining window: an engine commit that begins while Upgrade runs. Upgrade installs the new
            // bindings in its own turn (ruling R77), so that commit fails with a retry-safe ConflictError and nothing
            // is applied torn; DevCypherExecute retries it once.
            await opened.Engine.Upgrade(snapshot.Description)
            opened.Snapshot = snapshot
            applied = true
        }
        catch (error)
        {
            this.diagnostics.UpgradeFailed(error)
        }
        if (!applied) return
        try
        {
            this.changed.Raise()
        }
        catch (error)
        {
            this.diagnostics.ChangedHandlerFailed(error)
        }
    }

    /** Bounded: a hung connector call never makes dispose hang (reported, the engine is disposed regardless). */
    private async Teardown(): Promise<void>
    {
        this.debounce?.dispose()
        this.debounce = undefined
        await this.draining
        const opened = await this.opening?.catch(() => undefined)
        if (opened === undefined) return
        if (!(await BoundedWait.Within(this.writes.Settled(), DevGraphEngineHost.MaxSettleMs, this.settleTimer))) this.diagnostics.WritesUnsettled()
        const disposed = opened.dispose()
        if (!(await BoundedWait.Within(disposed, DevGraphEngineHost.MaxSettleMs, this.settleTimer)))
        {
            this.diagnostics.WritesUnsettled()
            this.writes.Abandon()
        }
    }
}
