import { AccessScope, CommitKind, WriteOp } from '@pragmatic-tech-ai/graph'
import type { BatchOp, GraphEngine, ICommitApplied, IConnectorApplied, ISubscription } from '@pragmatic-tech-ai/graph'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { Disposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { DataChangedPayload } from '@pragmatic-tech-ai/pragmatic-protocol'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { TimeoutUpgradeTimer } from '../engine/bounded-wait.js'
import type { IUpgradeTimer } from '../engine/bounded-wait.js'
import type { IGraphScope } from '../engine/access-scope-source.js'
import { ScopeReach } from '../engine/scope-reach.js'
import type { EnvironmentEngineHost } from './environment-engine-host.js'

/**
 * What a runtime connection subscribes `data/changed` through (`ServerConnectionHandler`): the caller's context in,
 * payloads already filtered to its scope out. Built over `PragmaticServer.DataChanges()` by `RuntimeAttachArgs`;
 * undefined off a runtime tenant (dev tenants keep `solution/graphChanged` only).
 */
export interface IEnvironmentDataChanges
{
    Subscribe(context: AccessContext, send: (payload: DataChangedPayload) => void): IDisposable
}

/** Where the push reports a window it could not deliver (it never throws at the engine). */
export interface IDataChangedDiagnostics
{
    /** A receipt or flush step threw, or a subscriber was skipped for a window (its scope or send failed). */
    FlushFailed(error: unknown): void
}

/** Reports each dropped window as one line on the server logger (the error name only: messages can carry paths). */
export class LoggerDataChangedDiagnostics implements IDataChangedDiagnostics
{
    private static readonly FlushLine = 'a data/changed window was not pushed: '
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public FlushFailed(error: unknown): void
    {
        this.logger.Error(LoggerDataChangedDiagnostics.FlushLine + (error instanceof Error ? error.name : LoggerDataChangedDiagnostics.UnknownName))
    }
}

/** A subscriber skipped for one window: the engine began reopening while its scope resolved. */
export class DataChangedSkipError extends Error
{
    private static readonly ErrorName = 'DataChangedSkipError'
    private static readonly SkipMessage = 'the environment engine began reopening while a data/changed subscriber scope resolved'

    public constructor()
    {
        super(DataChangedSkipError.SkipMessage)
        this.name = DataChangedSkipError.ErrorName
    }
}

/** One connection's subscription: its scope (resolved per push) and its sink. */
class DataChangeSubscriber implements IDisposable
{
    private live = true

    public constructor(
        public readonly Scope: () => Promise<IGraphScope>,
        public readonly Send: (payload: DataChangedPayload) => void,
        private readonly remove: (subscriber: DataChangeSubscriber) => void,
    )
    {
    }

    public get Live(): boolean
    {
        return this.live
    }

    public dispose(): void
    {
        this.live = false
        this.remove(this)
    }
}

/** The CommitApplied and ConnectorApplied subscriptions of one engine. */
class EngineFollow implements IDisposable
{
    public constructor(public readonly Engine: GraphEngine, private readonly subscriptions: readonly ISubscription[])
    {
    }

    public dispose(): void
    {
        for (const subscription of this.subscriptions) subscription.dispose()
    }
}

/** The changes of one coalescing window: the latest commit and the union of concepts. */
class PendingChange
{
    public Commit = 0n
    public readonly Concepts = new Set<string>()

    /** `commit` undefined: the concepts join without naming a commit. */
    public Add(commit: bigint | undefined, concepts: Iterable<string>): void
    {
        if (commit !== undefined && commit > this.Commit) this.Commit = commit
        for (const concept of concepts) this.Concepts.add(concept)
    }
}

/**
 * The runtime `data/changed` push (ruling S16, owner answer Q5: concept-level, no ids). Follows the environment
 * engine's `CommitApplied` and `ConnectorApplied` once per host: it attaches to the engine running at construction
 * and to each engine `EnvironmentEngineHost.Opened` announces (a reopen replaces it, R25), so it never opens one.
 *
 * Concepts of a commit: an Upgrade or SchemaChange commit is the root `todl.Element` (any data may have been
 * discarded); a batch names each `CreateNode.Concept`, and every other op's public ids resolve through `ConceptOf` on
 * one `AccessScope.System` reader opened on receipt (a stub keeps its identity; an id it cannot resolve, e.g. deleted,
 * is the root). External ops never reach the log (R103): external concepts come only from `ConnectorApplied`, whose
 * commit is `IConnectorApplied.Commit` when the write-through also committed engine ops, else the `SnapshotCommit` of
 * a System reader opened on receipt (when that read fails, the concepts join without naming a commit). Receipts are
 * processed in arrival order, and a write-through's ConnectorApplied (raised after its engine commit) normally joins
 * the same window, so one commit is reported once. Should a window end between the two, the ConnectorApplied's
 * concepts merge into the next payload, whose commit is never older than the last one pushed: the commit is a
 * monotonic watermark that may repeat across payloads. A window due while the engine is reopening (or before any
 * commit can be named) is merged back into the pending change and goes out with the next window, opened by the next
 * receipt or by the next engine `Opened` announces. Following a REPLACEMENT engine (a reopen, not the first open)
 * queues the root `todl.Element` at that engine's snapshot commit: a reopen is schema-level like an Upgrade commit,
 * its own open/upgrade commit is raised before the follow, and a subscriber skipped while it began lost its window,
 * so every subscriber hears "maybe yours".
 *
 * Coalescing: the first receipt starts one `CoalesceMs` window (closed synchronously when its timer fires, so a
 * receipt queued behind a running step opens the next); when it ends, every live subscriber gets `{ commit: latest,
 * concepts: union }` filtered by `ScopeReach.MayRead` under its scope (resolved then, through its scope source, which
 * may itself wait on the host) and the catalog of the running snapshot read right after that scope resolved
 * (`RunningSnapshot()`: that read alone never opens, redelivers or takes the host mutex), sorted; nothing is sent when
 * the filtered set is empty. A concept covers its subconcepts. External sources changed outside the engine are not
 * pushed (no changefeed, spec 5.2). A failing scope or send (or a reopen begun while the scope resolved) skips that
 * subscriber for the window and is reported to `IDataChangedDiagnostics`, as is a step that threw.
 */
export class DataChangedPush implements IDisposable
{
    public static readonly CoalesceMs = 50

    private readonly subscribers = new Set<DataChangeSubscriber>()
    private readonly opened: ISubscription
    private follow: EngineFollow | undefined
    private pending = new PendingChange()
    private window: IDisposable | undefined
    /** The latest commit pushed: a later window never names an older one. */
    private pushed = 0n
    /** Receipt processing and flushes, in arrival order. */
    private work: Promise<void> = Promise.resolve()
    private disposed = false

    public constructor(
        private readonly host: EnvironmentEngineHost,
        private readonly timer: IUpgradeTimer = new TimeoutUpgradeTimer(),
        private readonly diagnostics: IDataChangedDiagnostics = new LoggerDataChangedDiagnostics(),
    )
    {
        this.opened = host.Opened.Subscribe(engine => this.Follow(engine))
        const running = host.Running()
        if (running !== undefined) this.Follow(running)
    }

    /** Pushes to `send` until the returned handle is disposed; `scope` is resolved for each push. */
    public Subscribe(scope: () => Promise<IGraphScope>, send: (payload: DataChangedPayload) => void): IDisposable
    {
        if (this.disposed) return new Disposable(() => {})
        const subscriber = new DataChangeSubscriber(scope, send, gone => this.subscribers.delete(gone))
        this.subscribers.add(subscriber)
        return subscriber
    }

    public dispose(): void
    {
        if (this.disposed) return
        this.disposed = true
        this.opened.dispose()
        this.follow?.dispose()
        this.follow = undefined
        this.window?.dispose()
        this.window = undefined
        for (const subscriber of [...this.subscribers]) subscriber.dispose()
    }

    private Follow(engine: GraphEngine): void
    {
        if (this.disposed || this.follow?.Engine === engine) return
        const replacing = this.follow !== undefined
        this.follow?.dispose()
        this.follow = new EngineFollow(engine, [
            engine.CommitApplied.Subscribe(applied => this.Receive(() => this.CommitConcepts(engine, applied))),
            engine.ConnectorApplied.Subscribe(applied => this.Receive(() => this.ConnectorConcepts(engine, applied))),
        ])
        if (replacing)
        {
            // a reopen is schema-level, like an Upgrade commit: its open/upgrade commit was raised before this follow,
            // and a subscriber skipped while it began lost its window, so every subscriber is told the root
            this.Receive(() => this.ReopenConcepts(engine))
        }
        else
        {
            // a change requeued before the first engine opened goes out with the next window
            this.Enqueue(async () =>
            {
                if (this.pending.Concepts.size > 0) this.OpenWindow()
            })
        }
    }

    /** The root at the replacement engine's current snapshot commit (none named when that read fails). */
    private async ReopenConcepts(engine: GraphEngine): Promise<readonly [bigint | undefined, readonly string[]]>
    {
        try
        {
            const reader = await engine.BeginRead(AccessScope.System)
            try
            {
                return [reader.SnapshotCommit, [TodlNames.Element]]
            }
            finally
            {
                reader.dispose()
            }
        }
        catch
        {
            return [undefined, [TodlNames.Element]]
        }
    }

    /** Queues one receipt in arrival order and opens the window if none is open. */
    private Receive(resolve: () => Promise<readonly [bigint | undefined, readonly string[]]>): void
    {
        if (this.disposed) return
        this.Enqueue(async () =>
        {
            const [commit, concepts] = await resolve()
            this.pending.Add(commit, concepts)
        })
        this.OpenWindow()
    }

    private OpenWindow(): void
    {
        if (this.disposed) return
        this.window ??= this.timer.Start(DataChangedPush.CoalesceMs, () =>
        {
            // closed now, not when the flush step runs: a receipt queued meanwhile opens the next window
            this.window = undefined
            this.Enqueue(() => this.Flush())
        })
    }

    private Enqueue(step: () => Promise<void>): void
    {
        this.work = this.work.then(step).catch(error => this.diagnostics.FlushFailed(error))
    }

    private async CommitConcepts(engine: GraphEngine, applied: ICommitApplied): Promise<readonly [bigint, readonly string[]]>
    {
        if (applied.Kind === CommitKind.Upgrade || applied.Kind === CommitKind.SchemaChange) return [applied.Commit, [TodlNames.Element]]
        const concepts = new Set<string>()
        const created = new Set<string>()
        const ids = new Set<string>()
        for (const op of applied.Batch.Ops())
        {
            if (op.Op === WriteOp.CreateNode)
            {
                concepts.add(op.Concept)
                created.add(op.PublicId)
            }
            else
            {
                for (const id of DataChangedPush.IdsOf(op)) ids.add(id)
            }
        }
        const unresolved = [...ids].filter(id => !created.has(id))
        if (unresolved.length > 0)
        {
            try
            {
                const reader = await engine.BeginRead(AccessScope.System)
                try
                {
                    for (const id of unresolved) concepts.add((await reader.ConceptOf(id)) ?? TodlNames.Element)
                }
                finally
                {
                    reader.dispose()
                }
            }
            catch
            {
                // the engine went (a reopen): what changed cannot be named, so the root covers it
                concepts.add(TodlNames.Element)
            }
        }
        return [applied.Commit, [...concepts]]
    }

    private async ConnectorConcepts(engine: GraphEngine, applied: IConnectorApplied): Promise<readonly [bigint | undefined, readonly string[]]>
    {
        const concepts = [...applied.Connectors.values()].flat()
        if (applied.Commit !== undefined) return [applied.Commit, concepts]
        try
        {
            const reader = await engine.BeginRead(AccessScope.System)
            try
            {
                return [reader.SnapshotCommit, concepts]
            }
            finally
            {
                reader.dispose()
            }
        }
        catch
        {
            // no snapshot to name: the concepts join, the window's other commits (or the last pushed) name it
            return [undefined, concepts]
        }
    }

    private async Flush(): Promise<void>
    {
        const change = this.pending
        this.pending = new PendingChange()
        if (this.disposed || change.Concepts.size === 0) return
        const latest = change.Commit > this.pushed ? change.Commit : this.pushed
        if (latest === 0n || this.host.RunningSnapshot() === undefined)
        {
            // no commit to name yet, or the engine is reopening: the change waits (merged, so bounded by the concepts)
            this.Requeue(change)
            return
        }
        this.pushed = latest
        const commit = String(latest)
        for (const subscriber of [...this.subscribers])
        {
            try
            {
                const scope = (await subscriber.Scope()).Scope
                // the catalog of the snapshot the scope was just resolved on, not one read before it
                const snapshot = this.host.RunningSnapshot()
                if (snapshot === undefined) throw new DataChangedSkipError()
                const concepts = [...change.Concepts].filter(concept => ScopeReach.MayRead(scope, concept, snapshot.SchemaCatalog)).sort()
                if (concepts.length > 0 && subscriber.Live) subscriber.Send({ commit, concepts })
            }
            catch (error)
            {
                // fail-closed: a subscriber whose scope cannot be compiled (or whose send throws) gets nothing this window
                this.diagnostics.FlushFailed(error)
            }
        }
    }

    /** Merges an unpushed change back into the pending one; the next window (or the next engine opened) carries it. */
    private Requeue(change: PendingChange): void
    {
        this.pending.Add(change.Commit === 0n ? undefined : change.Commit, change.Concepts)
    }

    private static IdsOf(op: BatchOp): readonly string[]
    {
        switch (op.Op)
        {
            case WriteOp.Link:
            case WriteOp.Unlink:
                return [op.From, op.To]
            case WriteOp.CreateNode:
                return []
            default:
                return [op.PublicId]
        }
    }
}
