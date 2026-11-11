import { CommitKind, GraphEngine, StorageKind, WriteOp } from '@pragmatic-tech-ai/graph'
import type { BatchOp, ConnectorChangeSet, ICommitApplied, IConnectorTransaction, IGraphConnector, ISchemaDescription, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EnvironmentCatalogError, TodlFileConnector } from '@pragmatic-tech-ai/todl/engine'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable, IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { BoundedWait, TimeoutUpgradeTimer } from './bounded-wait.js'
import type { IUpgradeTimer } from './bounded-wait.js'
import { ConnectorSetKey } from './connector-set-key.js'
import { EngineHostChanged } from './engine-host-changed.js'
import type { IDevLanguageService } from './dev-language-service.js'
import type { IDevSolution } from './dev-solution.js'
import { DevSnapshotCompileError, DevSnapshotSource } from './dev-snapshot-source.js'
import type { DevSnapshot } from './dev-snapshot-source.js'
import type { IGraphEngineHost } from './graph-engine-host.js'
import { LazyExternalConnector } from './lazy-external-connector.js'
import { SavedMemberReader } from './saved-member-reader.js'
import { LoggerDevWriteDiagnostics, ServerModelWorkspace, WriteFenceSlot } from './server-model-workspace.js'
import type { IDevWriteDiagnostics, IWriteFence } from './server-model-workspace.js'

/**
 * The dev tenant's embedded graph engine, run from the saved solution. `Changed` is raised after each applied
 * upgrade (a saved edit recompiled to a new description); `Description` is the snapshot's description the engine
 * currently runs, and `Snapshot` is that whole snapshot in one read (its `Description.Version` equals the engine's
 * `SchemaVersion` except while an upgrade is being applied).
 */
export interface IDevGraphEngine extends IGraphEngineHost
{
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

/** Where an upgrade that did not apply is reported (it is never fatal: the engine keeps its previous version). */
export interface IDevEngineDiagnostics
{
    /** An upgrade or reopen did not apply (the engine keeps its previous version). */
    UpgradeFailed(error: unknown): void
    /**
     * The saved connector plans break an environment rule (TODL's EnvironmentCatalogError): dev engine requests answer
     * InvalidRequest with its message until a save describes again.
     */
    CatalogFailed(error: unknown): void
    /** An engine retired by a reopen failed to close (the running engine is unaffected). */
    RetireFailed(error: unknown): void
    /** A `Changed` subscriber threw (the upgrade itself applied; later upgrades are unaffected). */
    ChangedHandlerFailed(error: unknown): void
    /**
     * The engine's own connector writes did not settle within `DevGraphEngineHost.MaxSettleMs` (a hung connector call):
     * the upgrade pass or the teardown stopped waiting and went on.
     */
    WritesUnsettled(): void
    /** Teardown stopped waiting for an upgrade pass (a hang in the recompile or the upgrade) and disposed anyway. */
    DrainUnsettled(): void
}

/** Reports each failure as one error on the server logger, by error name only (messages can carry paths). */
export class LoggerDevEngineDiagnostics implements IDevEngineDiagnostics
{
    private static readonly Line = 'dev graph engine kept its previous version; the upgrade failed: '
    private static readonly HandlerLine = 'dev graph engine upgraded, but a Changed subscriber failed: '
    private static readonly UnsettledLine = 'dev graph engine writes did not settle in time; the host went on without them'
    private static readonly DrainLine = 'dev graph engine teardown stopped waiting for a hung upgrade pass'
    private static readonly CatalogLine = 'dev graph engine requests fail until the next save; the saved connector plans break an environment rule: '
    private static readonly RetireLine = 'dev graph engine retired by a reopen failed to close: '
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public UpgradeFailed(error: unknown): void
    {
        this.logger.Error(LoggerDevEngineDiagnostics.Line + LoggerDevEngineDiagnostics.NameOf(error))
    }

    public CatalogFailed(error: unknown): void
    {
        this.logger.Error(LoggerDevEngineDiagnostics.CatalogLine + LoggerDevEngineDiagnostics.NameOf(error))
    }

    public RetireFailed(error: unknown): void
    {
        this.logger.Error(LoggerDevEngineDiagnostics.RetireLine + LoggerDevEngineDiagnostics.NameOf(error))
    }

    public ChangedHandlerFailed(error: unknown): void
    {
        this.logger.Error(LoggerDevEngineDiagnostics.HandlerLine + LoggerDevEngineDiagnostics.NameOf(error))
    }

    public WritesUnsettled(): void
    {
        this.logger.Error(LoggerDevEngineDiagnostics.UnsettledLine)
    }

    public DrainUnsettled(): void
    {
        this.logger.Error(LoggerDevEngineDiagnostics.DrainLine)
    }

    private static NameOf(error: unknown): string
    {
        return error instanceof Error ? error.name : LoggerDevEngineDiagnostics.UnknownName
    }
}

export { DevSnapshotCompileError } from './dev-snapshot-source.js'

/**
 * The language-service-bound parts every open reuses: the reader, the snapshot source (whose failure memo spares a
 * failed open from recompiling until a save) and the model workspace.
 */
class SnapshotParts
{
    public readonly Reader: SavedMemberReader
    public readonly Source: DevSnapshotSource
    public readonly Workspace: ServerModelWorkspace

    public constructor(
        public readonly LanguageService: IDevEngineLanguageService,
        solution: () => Promise<IDevSolution | undefined>,
        writeDiagnostics: IDevWriteDiagnostics,
        fences: WriteFenceSlot)
    {
        this.Reader = new SavedMemberReader(LanguageService)
        this.Source = new DevSnapshotSource(solution, LanguageService, this.Reader)
        this.Workspace = new ServerModelWorkspace(solution, LanguageService, writeDiagnostics, this.Reader, fences)
    }
}

/**
 * The saved solution's connector plans break an environment rule (TODL's EnvironmentCatalogError, e.g. two models
 * binding one source): every dev engine request answers InvalidRequest with the error's message until a save describes
 * again (ruling S18).
 */
export class DevSnapshotCatalogFailure
{
    private constructor()
    {
    }

    /**
     * The wire error for a catalog failure, also when it arrives as the cause of a compile error (sources that both fail
     * to compile and break an environment rule, at open); any other error unchanged.
     */
    public static Of(error: unknown): unknown
    {
        const catalog = error instanceof DevSnapshotCompileError ? error.cause : error
        return catalog instanceof EnvironmentCatalogError ? new ResponseError(ErrorCodes.InvalidRequest, catalog.message) : error
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

    /**
     * The engine is gone: no Finalize will come, so every committed transaction leaves flight; with `connector`, only
     * the transactions begun through it (one engine of several, retired by a reopen).
     */
    public Abandon(connector?: IGraphConnector): void
    {
        const done = [...this.finalizing].filter(transaction => connector === undefined || transaction.Owner === connector)
        for (const transaction of done)
        {
            this.finalizing.delete(transaction)
            transaction.End()
        }
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
            return new TrackedTransaction(await this.inner.Begin(), this.tracker, this)
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

    public constructor(private readonly inner: IConnectorTransaction, private readonly tracker: EngineWriteTracker, public readonly Owner: IGraphConnector)
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

/**
 * One running engine: the GraphEngine, the CommitApplied subscription that tells the write tracker it finalized, its
 * tracked `.todl` file connector, the key of the external connector set it was opened with and its lazy external
 * connectors (kept so a refresh can reset them, R23).
 */
class RunningEngine implements IDisposable
{
    public constructor(
        public readonly Engine: GraphEngine,
        private readonly applied: ISubscription,
        private readonly file: IGraphConnector,
        private readonly writes: EngineWriteTracker,
        public readonly ConnectorKey: string,
        private readonly connectors: readonly LazyExternalConnector[],
    )
    {
    }

    public ResetConnectors(): void
    {
        for (const connector of this.connectors) connector.Reset()
    }

    public async dispose(): Promise<void>
    {
        this.applied.dispose()
        await this.Engine.dispose()
        // no Finalize comes after the engine is gone: nothing may wait on one of its transactions
        this.writes.Abandon(this.file)
    }
}

/**
 * The opened host state: the running engine with the snapshot it currently runs, the snapshot source and workspace a
 * reopen launches the next engine over, and the language-service subscription that upgrades it.
 */
class OpenedEngine implements IDisposable
{
    public constructor(
        public Running: RunningEngine,
        public readonly Source: DevSnapshotSource,
        public readonly Workspace: ServerModelWorkspace,
        private readonly subscription: IDisposable,
        public Snapshot: DevSnapshot,
    )
    {
    }

    public get Engine(): GraphEngine
    {
        return this.Running.Engine
    }

    /** Installs `running` with the snapshot it runs; returns the engine it replaces. */
    public Swap(running: RunningEngine, snapshot: DevSnapshot): RunningEngine
    {
        const previous = this.Running
        this.Running = running
        this.Snapshot = snapshot
        return previous
    }

    public async dispose(): Promise<void>
    {
        this.subscription.dispose()
        await this.Running.dispose()
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
 * upgrade or reopen.
 *
 * External connectors (ruling S18): beside the file connector the engine runs one {@link LazyExternalConnector} per
 * external plan of the snapshot, each opening its `DataSourceConnector` on first use (ruling R21: an unreachable source
 * fails only the calls touching its bindings) with an adapter borrowed from the process-wide `DataSourceAdapterCatalog`
 * the `services` provider resolves. An engine's connectors are fixed at Open, so a pass whose {@link ConnectorSetKey} differs from the
 * running engine's reopens (ruling S2's rule): new callers wait on the host gate, a fresh memory engine is launched
 * from the new snapshot (dev data lives in the `.todl` files, so the seed carries it over) and swapped in, and the
 * retired engine is disposed after {@link DevGraphEngineHost.RetireGraceMs} so readers already handed out finish. The
 * drain's settle wait precedes the reopen exactly as it precedes an upgrade. A snapshot that fails with TODL's
 * `EnvironmentCatalogError` (at open or in a pass) makes every request reject with InvalidRequest and its message
 * until a later pass describes again ({@link DevSnapshotCatalogFailure}); sources that do not compile keep the previous
 * version instead and never enter that state.
 */
export class DevGraphEngineHost implements IDevGraphEngine, IDisposable
{
    public static readonly UpgradeDebounceMs = 150
    /** Bounds the connector phase of each write-through (the engine's PrepareTimeoutMs), explicitly rather than by default. */
    public static readonly PrepareTimeoutMs = 30000
    /** How long the upgrade drain and the teardown wait for the engine's own writes to settle before going on (F-f). */
    public static readonly MaxSettleMs = 2 * DevGraphEngineHost.PrepareTimeoutMs
    /** How long an engine retired by a reopen stays open for the readers already handed out before it is disposed. */
    public static readonly RetireGraceMs = DevGraphEngineHost.MaxSettleMs
    private static readonly DisposedMessage = 'The dev graph engine host has been disposed'
    private static readonly NoIdentityMessage = 'invariant: a dev snapshot with external connector plans has no external identity'

    public readonly Changed: ISignal<void>

    private readonly changed = new EngineHostChanged()
    private readonly writes = new EngineWriteTracker()
    private readonly fences = new WriteFenceSlot()
    private opening: Promise<OpenedEngine> | undefined
    /** The engine `opening` resolved to (ResetConnectors reads it synchronously). */
    private openedEngine: OpenedEngine | undefined
    private openSucceeded = false
    private debounce: IDisposable | undefined
    private draining: Promise<void> | undefined
    private pending = false
    private disposing: Promise<void> | undefined
    /** Set while a reopen launches the next engine: new callers wait on it (the host gate). */
    private reopening: Promise<void> | undefined
    /** The request error of the latest pass's catalog failure, until a later pass describes. */
    private failure: unknown
    private parts: SnapshotParts | undefined
    /** Engines retired by a reopen, each with its pending grace timer. */
    private readonly retired = new Map<RunningEngine, IDisposable>()

    public constructor(
        private readonly solution: () => Promise<IDevSolution | undefined>,
        private readonly languageService: () => Promise<IDevEngineLanguageService>,
        private readonly timer: IUpgradeTimer = new TimeoutUpgradeTimer(),
        private readonly diagnostics: IDevEngineDiagnostics = new LoggerDevEngineDiagnostics(),
        private readonly writeDiagnostics: IDevWriteDiagnostics = new LoggerDevWriteDiagnostics(),
        private readonly prepareTimeoutMs: number = DevGraphEngineHost.PrepareTimeoutMs,
        /** The timer seam bounding the settle waits ({@link DevGraphEngineHost.MaxSettleMs}). */
        private readonly settleTimer: IUpgradeTimer = new TimeoutUpgradeTimer(),
        /** Resolves the `DataSourceAdapterCatalog` and the services its connections resolve with (external plans only). */
        private readonly services: () => IServiceProvider = () => new ServiceProvider(),
    )
    {
        this.Changed = this.changed
    }

    public async Engine(): Promise<GraphEngine>
    {
        return (await this.Opened()).Engine
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

    /**
     * @internal True once the engine opened successfully (a failed open leaves it false). Not part of IDevGraphEngine:
     * its only reader is the worker-host test proving a dev query used the ATTACHED engine; no public behaviour can
     * show that without opening the engine itself, so the read is kept here, internal.
     */
    public get IsOpen(): boolean
    {
        return this.openSucceeded
    }

    public InstallWriteFence(fence: IWriteFence): IDisposable
    {
        return this.fences.Install(fence)
    }

    /**
     * Forgets every opened external connector of the running engine (R23), so the next use of each opens it again;
     * nothing when the engine is not open (or still opening: its connectors have not opened anything yet). A retired
     * engine's connectors are not reset: it serves only the readers already handed out until its grace ends.
     */
    public ResetConnectors(): void
    {
        this.openedEngine?.Running.ResetConnectors()
    }

    /** Cancels a pending upgrade, waits for a running one, then disposes the engine. Idempotent. */
    public dispose(): Promise<void>
    {
        this.disposing ??= this.Teardown()
        return this.disposing
    }

    private async Opened(): Promise<OpenedEngine>
    {
        if (this.disposing !== undefined) throw new Error(DevGraphEngineHost.DisposedMessage)
        // the host gate: a caller arriving while a reopen launches the next engine is handed that engine
        if (this.reopening !== undefined) await this.reopening
        if (this.failure !== undefined) throw this.failure
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
        if (this.parts?.LanguageService !== languageService) this.parts = new SnapshotParts(languageService, this.solution, this.writeDiagnostics, this.fences)
        const { Source: source, Workspace: workspace } = this.parts
        // subscribed before the first read, so a save racing the open is upgraded once it is open
        const subscription = languageService.GraphChanged.subscribe(() => this.Schedule())
        try
        {
            const snapshot = await source.Current()
            const opened = new OpenedEngine(await this.Launch(snapshot, workspace), source, workspace, subscription, snapshot)
            this.openSucceeded = true
            this.openedEngine = opened
            return opened
        }
        catch (error)
        {
            subscription.dispose()
            throw DevSnapshotCatalogFailure.Of(error)
        }
    }

    /** Opens a memory engine on `snapshot`: the tracked `.todl` file connector plus one lazy external connector per plan. */
    private async Launch(snapshot: DevSnapshot, workspace: ServerModelWorkspace): Promise<RunningEngine>
    {
        const file = this.writes.Track(new TodlFileConnector(workspace))
        const external = this.ExternalConnectors(snapshot)
        const engine = await GraphEngine.Open({
            Description: snapshot.Description,
            Storage: { Kind: StorageKind.Memory },
            Connectors: [file, ...external],
            PrepareTimeoutMs: this.prepareTimeoutMs,
        })
        const applied = engine.CommitApplied.Subscribe(commit => this.writes.Finalized(commit))
        return new RunningEngine(engine, applied, file, this.writes, ConnectorSetKey.Of(snapshot.Connectors, snapshot.Identity), external)
    }

    /**
     * One lazily opened DataSourceConnector per external plan (ruling R21: a source that cannot be reached fails only
     * the calls touching its bindings, never the engine open; each borrows its adapter from the catalog).
     */
    private ExternalConnectors(snapshot: DevSnapshot): LazyExternalConnector[]
    {
        if (snapshot.Connectors.length === 0) return []
        const identity = snapshot.Identity
        if (identity === undefined) throw new Error(DevGraphEngineHost.NoIdentityMessage)
        return snapshot.Connectors.map(plan => new LazyExternalConnector(plan, this.services, identity))
    }

    /**
     * Replaces the running engine with one launched from `snapshot`, new callers waiting on the host gate meanwhile;
     * the replaced engine is retired, not disposed, so the readers already handed out finish. True when the launched
     * engine was swapped in; false when teardown began meanwhile (nothing applied).
     */
    private async Reopen(opened: OpenedEngine, snapshot: DevSnapshot): Promise<boolean>
    {
        let release: () => void = () => undefined
        this.reopening = new Promise<void>(resolve => { release = resolve })
        try
        {
            const running = await this.Launch(snapshot, opened.Workspace)
            // teardown began while the engine launched: it disposes what is installed, so the new engine is not swapped in
            if (this.disposing !== undefined)
            {
                await running.dispose()
                return false
            }
            this.Retire(opened.Swap(running, snapshot))
            return true
        }
        finally
        {
            this.reopening = undefined
            release()
        }
    }

    /** Disposes `running` once {@link DevGraphEngineHost.RetireGraceMs} elapses (or at teardown). */
    private Retire(running: RunningEngine): void
    {
        if (this.disposing !== undefined)
        {
            // teardown already collected the retired engines: close this one now
            running.dispose().catch((error: unknown) => this.diagnostics.RetireFailed(error))
            return
        }
        const grace = this.settleTimer.Start(DevGraphEngineHost.RetireGraceMs, () =>
        {
            this.retired.delete(running)
            running.dispose().catch((error: unknown) => this.diagnostics.RetireFailed(error))
        })
        this.retired.set(running, grace)
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
                // a hung connector call: report and re-arm, so the skipped upgrade runs as soon as the writes settle
                // (the next pass waits on them again) rather than waiting for the next GraphChanged
                this.diagnostics.WritesUnsettled()
                this.pending = true
                return
            }
            const begun = this.writes.Begun
            let snapshot: DevSnapshot | undefined
            let failed: unknown
            try
            {
                snapshot = await opened.Source.Current()
            }
            catch (error)
            {
                if (!(error instanceof EnvironmentCatalogError) && !(error instanceof DevSnapshotCompileError)) throw error
                failed = error
            }
            if (!this.writes.Quiet(begun))
            {
                // an engine commit began while the solution was read: the read may be torn, read again once it settles
                this.pending = true
                return
            }
            // sources that do not compile keep the previous version (the source reports them as compile errors even
            // when their plans also break an environment rule): never the catalog-failure state
            if (failed instanceof DevSnapshotCompileError) throw failed
            if (snapshot === undefined)
            {
                // the saved plans break an environment rule: every request reports it until a later pass describes
                this.failure = DevSnapshotCatalogFailure.Of(failed)
                this.diagnostics.CatalogFailed(failed)
                return
            }
            DevSnapshotCompileError.ThrowIfFailed(snapshot.CompileDiagnostics)
            if (snapshot.Description.Version === opened.Engine.SchemaVersion)
            {
                this.failure = undefined
                return
            }
            if (ConnectorSetKey.Of(snapshot.Connectors, snapshot.Identity) !== opened.Running.ConnectorKey)
            {
                // teardown began while the engine launched: nothing applied, Changed is not raised
                if (!(await this.Reopen(opened, snapshot))) return
            }
            else
            {
                // The one remaining window: an engine commit that begins while Upgrade runs. Upgrade installs the new
                // bindings in its own turn (ruling R77), so that commit fails with a retry-safe ConflictError and
                // nothing is applied torn; DevCypherExecute retries it once.
                await opened.Engine.Upgrade(snapshot.Description)
                opened.Snapshot = snapshot
            }
            this.failure = undefined
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
        // bounded too: a hang inside the recompile (Source.Current) or engine.Upgrade never makes dispose hang
        if (this.draining !== undefined && !(await BoundedWait.Within(this.draining, DevGraphEngineHost.MaxSettleMs, this.settleTimer)))
        {
            this.diagnostics.DrainUnsettled()
        }
        const opened = await this.opening?.catch(() => undefined)
        if (opened === undefined) return
        if (!(await BoundedWait.Within(this.writes.Settled(), DevGraphEngineHost.MaxSettleMs, this.settleTimer))) this.diagnostics.WritesUnsettled()
        const retired = [...this.retired]
        this.retired.clear()
        for (const [, grace] of retired) grace.dispose()
        const disposed = Promise.all([opened.dispose(), ...retired.map(([running]) => running.dispose())]).then(() => undefined)
        if (!(await BoundedWait.Within(disposed, DevGraphEngineHost.MaxSettleMs, this.settleTimer)))
        {
            this.diagnostics.WritesUnsettled()
            this.writes.Abandon()
        }
    }
}
