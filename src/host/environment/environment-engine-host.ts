import { ConnectorPhase, GraphEngine, GraphError, GraphErrorCode } from '@pragmatic-tech-ai/graph'
import type { ConnectorError, IGraphEngineOptions, ISchemaDescription, ISignal, ISubscription, StorageKind } from '@pragmatic-tech-ai/graph'
import { StoragePackageSource } from '@pragmatic-tech-ai/todl'
import { EngineCellMapper, EnvironmentCatalogComposer, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog, IPackageDelivery } from '@pragmatic-tech-ai/todl/engine'
import type { PackageRef } from '@pragmatic-tech-ai/todl/domain'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable, IServiceProvider, IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { GraphLoadParamsDto, GraphLoadedDto, SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { AsyncMutex } from '../cypher/async-mutex.js'
import { BoundedWait, TimeoutUpgradeTimer } from '../engine/bounded-wait.js'
import type { IUpgradeTimer } from '../engine/bounded-wait.js'
import { ConnectorSetKey } from '../engine/connector-set-key.js'
import { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { EngineHostChanged } from '../engine/engine-host-changed.js'
import type { IEngineSnapshot, IGraphEngineHost } from '../engine/graph-engine-host.js'
import { LazyExternalConnector } from '../engine/lazy-external-connector.js'
import type { DeliverySecurity } from './delivery-security.js'
import type { DeliveryChange, EnvironmentDeliveries, IDelivered, IDeliveryGate } from './environment-deliveries.js'
import type { SecurityDeployDiff } from './security-deploy-diff.js'

/**
 * What the environment engine runs, in one read: the engine snapshot (`Description`, `Connectors` and `Identity` from
 * the composed catalog, `Models` = its package model ids other than `todl.system`, sorted (ruling S12), `CellMapper`
 * over the catalog's metadata), the whole catalog, and the deliveries it was composed from.
 */
export type EnvironmentSnapshot = IEngineSnapshot & {
    readonly Catalog: IEnvironmentCatalog
    /** How the engine sees `Description` (built once per snapshot). */
    readonly SchemaCatalog: EngineSchemaCatalog
    readonly Deliveries: readonly IPackageDelivery[]
}

/**
 * The runtime-side promote seam a runtime tenant exposes (`graph/load`, `graph/loaded`); the handler reaches it without
 * knowing the server type.
 */
export interface IEnvironmentGraphHost
{
    LoadEnvironmentGraph(params: GraphLoadParamsDto): Promise<GraphLoadedDto>
    LoadedGraph(): Promise<GraphLoadedDto | null>
}

/** Where the environment host reports what it never throws at a caller, or throws only after reporting. */
export interface IEnvironmentDiagnostics
{
    /** A redelivery (upgrade or reopen) did not apply; the host is stale and the next use retries it. */
    UpgradeFailed(error: unknown): void
    /** A `Changed` or `Opened` subscriber threw (the upgrade or open itself applied). */
    ChangedHandlerFailed(error: unknown): void
    /**
     * `GraphEngine.ConnectorRevertFailed` of an opened engine: a connector's compensation failed after the caller was
     * answered (TODL `CompensationFailed`, R113); the last place it can be seen.
     */
    RevertFailed(error: ConnectorError): void
    /** The store was locked at open (the previous lease holder may still be closing); attempt `attempt` is retried. */
    OpenRetried(error: unknown, attempt: number): void
    /** Teardown stopped waiting for the running open or delivery (a hung persist) and disposed the engine anyway. */
    DrainUnsettled(): void
}

/** Reports each event as one line on the server logger: error names, connector and phase only (messages can carry paths). */
export class LoggerEnvironmentDiagnostics implements IEnvironmentDiagnostics
{
    private static readonly UpgradeLine = 'environment graph engine was not upgraded; it is retried on next use: '
    private static readonly HandlerLine = 'environment graph engine upgraded, but a Changed subscriber failed: '
    private static readonly RevertLine = 'environment graph connector compensation failed after the write was answered: '
    private static readonly RetryLine = 'environment graph store is locked; retrying the open: '
    private static readonly DrainLine = 'environment graph engine teardown stopped waiting for a hung delivery'
    private static readonly ConnectorField = 'connector'
    private static readonly PhaseField = 'phase'
    private static readonly AttemptField = 'attempt'
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public UpgradeFailed(error: unknown): void
    {
        this.logger.Error(LoggerEnvironmentDiagnostics.UpgradeLine + LoggerEnvironmentDiagnostics.NameOf(error))
    }

    public ChangedHandlerFailed(error: unknown): void
    {
        this.logger.Error(LoggerEnvironmentDiagnostics.HandlerLine + LoggerEnvironmentDiagnostics.NameOf(error))
    }

    public RevertFailed(error: ConnectorError): void
    {
        this.logger.Error(LoggerEnvironmentDiagnostics.RevertLine + LoggerEnvironmentDiagnostics.NameOf(error.cause), {
            [LoggerEnvironmentDiagnostics.ConnectorField]: error.Connector,
            [LoggerEnvironmentDiagnostics.PhaseField]: ConnectorPhase[error.Phase],
        })
    }

    public OpenRetried(error: unknown, attempt: number): void
    {
        this.logger.Warn(LoggerEnvironmentDiagnostics.RetryLine + LoggerEnvironmentDiagnostics.NameOf(error), { [LoggerEnvironmentDiagnostics.AttemptField]: attempt })
    }

    public DrainUnsettled(): void
    {
        this.logger.Error(LoggerEnvironmentDiagnostics.DrainLine)
    }

    private static NameOf(error: unknown): string
    {
        return error instanceof Error ? error.name : LoggerEnvironmentDiagnostics.UnknownName
    }
}

export enum EnvironmentHostErrorCode
{
    /** The engine kept upgrading on every settle attempt; a later request runs on the settled engine. */
    Unsettled = 1,
}

/** A failure of the environment host itself (not of a query or a write): the request fails (InternalError). */
export class EnvironmentHostError extends Error
{
    private static readonly ErrorName = 'EnvironmentHostError'
    private static readonly Messages: Readonly<Record<EnvironmentHostErrorCode, string>> = {
        [EnvironmentHostErrorCode.Unsettled]: 'the environment graph engine kept upgrading while the request was prepared',
    }

    public constructor(public readonly Code: EnvironmentHostErrorCode)
    {
        super(EnvironmentHostError.Messages[Code])
        this.name = EnvironmentHostError.ErrorName
    }
}

/**
 * A delivery was validated and persisted (S4 steps 1-3), but redelivering it to the engine (step 4) failed: the host is
 * stale and the next use retries. `Result` is what the persist step returned; `cause` the redelivery failure.
 */
export class EnvironmentUpgradeFailedError extends Error
{
    public static readonly Reason = 'deployed, but the environment graph could not be upgraded; it is retried on next use'
    /** The same failure on a promote (`graph/load`): the promote record is persisted, the upgrade is retried on next use. */
    public static readonly PromoteReason = 'promoted, but the environment graph could not be upgraded; it is retried on next use'
    private static readonly ErrorName = 'EnvironmentUpgradeFailedError'

    public constructor(public readonly Result: unknown, cause: unknown)
    {
        super(EnvironmentUpgradeFailedError.Reason, { cause })
        this.name = EnvironmentUpgradeFailedError.ErrorName
    }
}

/** Where the environment engine's store lives (ruling S2 / Q7: LMDB at `<graphsRoot>/environment-engine`). */
export interface IEnvironmentEngineStorage
{
    readonly Kind: StorageKind
    readonly Path: string
}

/** Test seams over the host's fixed timings (absent = the static defaults). */
export interface IEnvironmentHostTiming
{
    readonly PrepareTimeoutMs?: number
    readonly OpenBackoffMs?: number
    /** Bounds teardown's wait for the running section (default `EnvironmentEngineHost.MaxDrainMs`). */
    readonly MaxDrainMs?: number
}

/** `EnvironmentEngineHost.Opened`: raised with each engine the host launches (first open, reopen, recovery). */
class EngineOpened implements ISignal<GraphEngine>
{
    private readonly signal = new Signal<GraphEngine>()

    public Subscribe(handler: (engine: GraphEngine) => void): ISubscription
    {
        return this.signal.subscribe(handler)
    }

    public Raise(engine: GraphEngine): void
    {
        this.signal.emit(engine)
    }
}

/** A delivery's security diff waiting to be committed (prune, store, log), with what it runs on. */
class PendingSecurity
{
    public constructor(
        public readonly Security: DeliverySecurity,
        public readonly Diff: SecurityDeployDiff,
        public readonly Delivery: string,
        public readonly Version: string)
    {
    }
}

/**
 * One opened engine: the snapshot it runs, the key of its external connector set, its lazy external connectors (kept
 * so a refresh can reset them, R23) and its ConnectorRevertFailed subscription.
 */
class OpenedEnvironment implements IDisposable
{
    public constructor(
        public readonly Engine: GraphEngine,
        public Snapshot: EnvironmentSnapshot,
        public readonly ConnectorKey: string,
        private readonly connectors: readonly LazyExternalConnector[],
        private readonly reverts: ISubscription,
    )
    {
    }

    public ResetConnectors(): void
    {
        for (const connector of this.connectors) connector.Reset()
    }

    /** The engine first, so a late compensation failure raised while it drains is still reported. */
    public async dispose(): Promise<void>
    {
        try
        {
            await this.Engine.dispose()
        }
        finally
        {
            this.reverts.dispose()
        }
    }
}

/**
 * The ONE embedded graph engine of a runtime environment (rulings S2, S3, S4). It lives inside the runtime
 * `PragmaticServer`, which `TenantRegistry` builds only while it holds the tenant-ownership lease; `dispose()` (lease
 * lost, idle eviction, shutdown) disposes the engine, which closes the store.
 *
 * Opens lazily on first use over the catalog `EnvironmentCatalogComposer.Compose` builds from `deliveries.Current()`
 * and the compiled packages (`StoragePackageSource`; nothing is compiled): `GraphEngine.Open({ Description, Storage,
 * Connectors: one LazyExternalConnector per catalog plan (R21: an unreachable source fails only the calls touching its
 * bindings), PrepareTimeoutMs })`. With nothing delivered it still opens (the composer always adds `todl.system`). A
 * store `GraphErrorCode.Locked` at open is retried `OpenAttempts` times in all, waiting `OpenBackoffMs` then doubling,
 * then fails the request. A restart opens from storage plus the composed description (no commit when unchanged, R74).
 *
 * Opens, redeliveries and deliveries run one at a time under the host mutex. `Redeliver()` recomposes over the current
 * deliveries: an unchanged `ConnectorSetKey` (R19, over the catalog's identity) upgrades in place when the version
 * differs; a changed one reopens (an engine's connectors are fixed at Open): new callers wait on the mutex, the engine
 * is disposed (an LMDB store admits one engine at a time, so it is closed before the next opens: a reader handed out
 * before the reopen fails with GraphError Disposed, unlike the dev host's grace retirement, R20) and reopened on the
 * same path (Open upgrades it). `Changed` is raised after every applied upgrade or reopen; `Opened` with every engine
 * launched (first open included), before any caller can commit on it. A redelivery that fails is
 * reported (`UpgradeFailed`) and leaves the host stale: the next `Engine()` / `Snapshot()` / `Description()` redelivers
 * before serving (and fails while that fails).
 *
 * `Deliver(change, persist)` is S4: under the mutex it composes the prospective deliveries (an EnvironmentCatalogError
 * rejects before `persist` runs, nothing persisted), runs `persist` (the app live pointer or the promote record), then
 * redelivers; a redelivery failure there rejects with EnvironmentUpgradeFailedError (the delivery stays persisted).
 *
 * With `security` (S4 Task 13, identity configured) the delivery also applies its security diff: compose the
 * prospective catalog, `DeliverySecurity.Diff` against the running one, `persist`, `Commit` (the setting pruned of
 * what the new packages cannot mean, stored and logged; fail closed, it only narrows access a moment early), then
 * redeliver (the catalog and its `Security` swap as one snapshot; scope caches drop on `Changed`, readers already
 * open keep the old snapshot and the scope they began with), then `Backfill` outside the mutex. A commit that fails is
 * reported (`UpgradeFailed`), leaves the host stale and is retried before the next delivery, redelivery or open
 * applies; every first open (and recovery) first reconciles the stored setting against the catalog it launches, so a
 * prune a crash or a lost lease kept from committing lands before anything is served. The owed backfill is recorded
 * durably (PendingBackfillStore) before `persist`, resumed in the background after every open and run after every
 * `Deliver` / `Redeliver`; a failure is reported (`UpgradeFailed`) and stays owed. The delivery answers the
 * logged change-log entry (`IDelivered.SecurityChanges`) when the diff is non-empty. An incompatible delivery is
 * rejected before anything is committed: the setting is untouched.
 */
export class EnvironmentEngineHost implements IGraphEngineHost, IDeliveryGate, IDisposable
{
    /** The store directory under the tenant's graphs root (Q7). */
    public static readonly StoreDir = 'environment-engine'
    public static readonly PrepareTimeoutMs = 30000
    public static readonly OpenAttempts = 3
    public static readonly OpenBackoffMs = 500
    /** How long teardown waits for the running open or delivery before it disposes the engine anyway. */
    public static readonly MaxDrainMs = 2 * EnvironmentEngineHost.PrepareTimeoutMs
    private static readonly DisposedMessage = 'The environment engine host has been disposed'
    private static readonly MaxSettles = 5
    private static readonly RefSeparator = '@'
    private static readonly ListSeparator = ', '

    public readonly Changed: ISignal<void>
    /**
     * Raised synchronously with each engine the host launches (the first open, a reopen, the recovery from a failed
     * one), before any caller sees it: a follower of the engine's own signals subscribes here (S16).
     */
    public readonly Opened: ISignal<GraphEngine>

    private readonly changed = new EngineHostChanged()
    private readonly opening = new EngineOpened()
    private readonly mutex = new AsyncMutex()
    private opened: OpenedEnvironment | undefined
    private stale = false
    /** True once an engine was launched: a later first-open branch replaces one, so it raises Changed. */
    private launched = false
    private disposing: Promise<void> | undefined
    /**
     * The last delivery's security diff, until its Commit lands (retried before the next delivery, redelivery or open
     * applies; a process that dies first leaves it to the next open's reconcile).
     */
    private uncommitted: PendingSecurity | undefined

    public constructor(
        private readonly deliveries: EnvironmentDeliveries,
        private readonly packages: IStorage,
        /** Resolves the process-wide `DataSourceAdapterCatalog` and the services its connections resolve with. */
        private readonly services: IServiceProvider,
        private readonly storage: IEnvironmentEngineStorage,
        private readonly diagnostics: IEnvironmentDiagnostics = new LoggerEnvironmentDiagnostics(),
        private readonly timing: IEnvironmentHostTiming = {},
        /** The timer seam bounding teardown's drain wait. */
        private readonly timer: IUpgradeTimer = new TimeoutUpgradeTimer(),
        /** What a delivery does to the environment's security (absent without identity: deliveries change no setting). */
        private readonly security?: () => Promise<DeliverySecurity>,
    )
    {
        this.Changed = this.changed
        this.Opened = this.opening
    }

    /** The engine running now, without opening one (undefined before the first open, while reopening, after dispose). */
    public Running(): GraphEngine | undefined
    {
        return this.disposing === undefined ? this.opened?.Engine : undefined
    }

    /** The snapshot the running engine runs, without opening or redelivering (undefined when `Running()` is). */
    public RunningSnapshot(): EnvironmentSnapshot | undefined
    {
        return this.disposing === undefined ? this.opened?.Snapshot : undefined
    }

    public async Engine(): Promise<GraphEngine>
    {
        return (await this.Current()).Engine
    }

    public async Snapshot(): Promise<EnvironmentSnapshot>
    {
        return (await this.Current()).Snapshot
    }

    public async Description(): Promise<ISchemaDescription>
    {
        return (await this.Current()).Snapshot.Description
    }

    /**
     * The engine and the snapshot it runs, once their versions agree (an upgrade being applied installs its snapshot
     * after the engine upgraded); EnvironmentHostError Unsettled when they still differ after `MaxSettles` yields.
     */
    public async Settled(): Promise<readonly [GraphEngine, EnvironmentSnapshot]>
    {
        for (let settle = 0; settle < EnvironmentEngineHost.MaxSettles; settle++)
        {
            const engine = await this.Engine()
            const snapshot = await this.Snapshot()
            if (snapshot.Description.Version === engine.SchemaVersion) return [engine, snapshot]
            await new Promise<void>(resolve => setImmediate(resolve))
        }
        throw new EnvironmentHostError(EnvironmentHostErrorCode.Unsettled)
    }

    /**
     * Ruling S4: validates the prospective deliveries (`change` applied) by composing them, then runs `persist`, then
     * commits the security diff (with `security`) and redelivers, all under the host mutex, then backfills ownership. An
     * EnvironmentCatalogError (or any compose failure) rejects before `persist` runs; a commit or redelivery failure
     * rejects with EnvironmentUpgradeFailedError carrying `persist`'s result.
     */
    public async Deliver<T>(change: DeliveryChange, persist: () => Promise<T>): Promise<IDelivered<T>>
    {
        const delivered = await this.Serialized(async (): Promise<IDelivered<T>> =>
        {
            // an earlier delivery's diff that did not commit is committed (and logged) first; failing, nothing persists
            await this.CommitSecurity()
            const prospective = await this.Compose(await this.deliveries.With(change))
            const security = this.security === undefined ? undefined : await this.security()
            const diff = security === undefined ? undefined : await security.Diff(await this.CurrentCatalog(), prospective)
            // the owed backfill is durable before the delivery is: a crash after persist cannot lose it
            if (security !== undefined && diff !== undefined) await security.Expect(diff)
            const result = await persist()
            if (security !== undefined && diff !== undefined) this.uncommitted = new PendingSecurity(security, diff, change.Name, EnvironmentEngineHost.VersionOf(change))
            let changes: SecurityChangesDto | undefined
            try
            {
                changes = await this.CommitSecurity()
            }
            catch (error)
            {
                this.stale = this.opened !== undefined
                this.diagnostics.UpgradeFailed(error)
                throw new EnvironmentUpgradeFailedError(result, error)
            }
            const answer: IDelivered<T> = changes === undefined ? { Result: result } : { Result: result, SecurityChanges: changes }
            if (this.disposing !== undefined)
            {
                // the lease went while persisting: the delivery is on disk, the next lease holder opens over it
                this.stale = true
                return answer
            }
            try
            {
                await this.Apply()
            }
            catch (error)
            {
                throw new EnvironmentUpgradeFailedError(result, error)
            }
            return answer
        })
        await this.Backfill()
        return delivered
    }

    /**
     * Recomposes over the current deliveries and upgrades or reopens the engine (nothing when it is not open yet), then
     * runs the ownership backfills still waiting.
     */
    public async Redeliver(): Promise<void>
    {
        await this.Serialized(() => this.Apply())
        await this.Backfill()
    }

    /** Waits for the ownership backfills owed now (the ones every open resumes in the background) to run once. */
    public BackfillNow(): Promise<void>
    {
        return this.Backfill()
    }

    /**
     * Forgets every opened external connector of the running engine, so the next use of each opens it again (R23:
     * after the adapter catalog disposed and dropped its adapters, e.g. a connector refresh).
     */
    public ResetConnectors(): void
    {
        this.opened?.ResetConnectors()
    }

    /**
     * Waits (at most `MaxDrainMs`) for the running open or delivery, then disposes the engine, closing its store. A
     * section still running afterwards opens nothing: every launch re-checks `disposing`. Idempotent.
     */
    public dispose(): Promise<void>
    {
        this.disposing ??= this.Teardown()
        return this.disposing
    }

    private async Current(): Promise<OpenedEnvironment>
    {
        if (this.disposing !== undefined) throw new Error(EnvironmentEngineHost.DisposedMessage)
        const opened = this.opened
        if (opened !== undefined && !this.stale) return opened
        let launched = false
        const current = await this.Serialized(async () =>
        {
            if (this.opened === undefined)
            {
                // a first open, or the recovery from a failed reopen: that one replaces a disposed engine (Changed)
                const replacing = this.launched
                await this.CommitSecurity()
                const deliveries = await this.deliveries.Current()
                const catalog = await this.Compose(deliveries)
                // a prune a crash or a lost lease kept from committing lands before anything is served (Review Focus 1)
                if (this.security !== undefined) await (await this.security()).Reconcile(catalog, EnvironmentEngineHost.RefList(catalog.Packages))
                this.opened = await this.Launch(EnvironmentEngineHost.SnapshotOf(catalog, deliveries))
                this.stale = false
                launched = true
                if (replacing) this.RaiseChanged()
            }
            else if (this.stale)
            {
                await this.Apply()
            }
            return this.opened!
        })
        // an opened engine resumes the backfills a crash or a lost lease left owed (in the background, outside the mutex)
        if (launched) void this.Backfill()
        return current
    }

    /** Runs `section` under the host mutex, refusing once the host is disposing. */
    private Serialized<T>(section: () => Promise<T>): Promise<T>
    {
        return this.mutex.Run(async () =>
        {
            if (this.disposing !== undefined) throw new Error(EnvironmentEngineHost.DisposedMessage)
            return section()
        })
    }

    /** Redelivery under the mutex: upgrade in place or reopen; a failure is reported and leaves the host stale. */
    private async Apply(): Promise<void>
    {
        const opened = this.opened
        if (opened === undefined || this.disposing !== undefined)
        {
            // nothing open: the first use opens over the current deliveries; disposing: the next lease holder does
            this.stale = opened !== undefined
            return
        }
        let applied = false
        try
        {
            await this.CommitSecurity()
            const deliveries = await this.deliveries.Current()
            const snapshot = EnvironmentEngineHost.SnapshotOf(await this.Compose(deliveries), deliveries)
            if (EnvironmentEngineHost.KeyOf(snapshot) === opened.ConnectorKey)
            {
                if (snapshot.Description.Version !== opened.Engine.SchemaVersion)
                {
                    await opened.Engine.Upgrade(snapshot.Description)
                    applied = true
                }
                opened.Snapshot = snapshot
            }
            else
            {
                // the store admits one engine: close the running one before the next opens on the same path
                this.opened = undefined
                await opened.dispose()
                this.opened = await this.Launch(snapshot)
                applied = true
            }
            this.stale = false
        }
        catch (error)
        {
            // a failed reopen leaves nothing open: the next use opens afresh rather than redelivering
            this.stale = this.opened !== undefined
            // a launch refused because teardown began is no upgrade failure
            if (this.disposing === undefined) this.diagnostics.UpgradeFailed(error)
            throw error
        }
        if (applied) this.RaiseChanged()
    }

    /**
     * Commits the uncommitted delivery's security diff (prune, store, log); the logged entry, undefined when nothing is
     * uncommitted or the diff was empty. Under the mutex; a failure keeps it uncommitted.
     */
    private async CommitSecurity(): Promise<SecurityChangesDto | undefined>
    {
        const pending = this.uncommitted
        if (pending === undefined) return undefined
        const entry = await pending.Security.Commit(pending.Diff, pending.Delivery, pending.Version)
        this.uncommitted = undefined
        return entry
    }

    /**
     * Runs the owed ownership backfills (the durable PendingBackfillStore) on the settled engine, outside the mutex; a
     * failure is reported (`UpgradeFailed`) and the concepts stay owed for the next delivery, redelivery or open.
     */
    private async Backfill(): Promise<void>
    {
        if (this.security === undefined || this.disposing !== undefined) return
        try
        {
            const security = await this.security()
            const [engine, snapshot] = await this.Settled()
            await security.Backfill(engine, snapshot)
        }
        catch (error)
        {
            if (this.disposing === undefined) this.diagnostics.UpgradeFailed(error)
        }
    }

    /** The catalog the running engine serves; the one the current deliveries compose to when none is open or it is stale. */
    private async CurrentCatalog(): Promise<IEnvironmentCatalog>
    {
        const opened = this.opened
        if (opened !== undefined && !this.stale) return opened.Snapshot.Catalog
        return this.Compose(await this.deliveries.Current())
    }

    /** Opens the engine on `snapshot`, retrying a locked store. */
    private async Launch(snapshot: EnvironmentSnapshot): Promise<OpenedEnvironment>
    {
        const catalog = snapshot.Catalog
        const connectors = catalog.Connectors.map(plan => new LazyExternalConnector(plan, () => this.services, catalog.Identity))
        if (this.disposing !== undefined) throw new Error(EnvironmentEngineHost.DisposedMessage)
        const engine = await this.OpenRetrying(snapshot.Description, connectors)
        if (this.disposing !== undefined)
        {
            // teardown began while the store opened: it never sees this engine, so it is closed here
            await engine.dispose()
            throw new Error(EnvironmentEngineHost.DisposedMessage)
        }
        this.launched = true
        const reverts = engine.ConnectorRevertFailed.Subscribe(error => this.diagnostics.RevertFailed(error))
        try
        {
            this.opening.Raise(engine)
        }
        catch (error)
        {
            this.diagnostics.ChangedHandlerFailed(error)
        }
        return new OpenedEnvironment(engine, snapshot, EnvironmentEngineHost.KeyOf(snapshot), connectors, reverts)
    }

    private async OpenRetrying(description: ISchemaDescription, connectors: readonly LazyExternalConnector[]): Promise<GraphEngine>
    {
        let backoff = this.timing.OpenBackoffMs ?? EnvironmentEngineHost.OpenBackoffMs
        for (let attempt = 1; ; attempt++)
        {
            try
            {
                return await this.OpenEngine({
                    Description: description,
                    Storage: { Kind: this.storage.Kind, Path: this.storage.Path },
                    Connectors: connectors,
                    PrepareTimeoutMs: this.timing.PrepareTimeoutMs ?? EnvironmentEngineHost.PrepareTimeoutMs,
                })
            }
            catch (error)
            {
                if (!EnvironmentEngineHost.IsLocked(error) || attempt >= EnvironmentEngineHost.OpenAttempts) throw error
                this.diagnostics.OpenRetried(error, attempt)
                await EnvironmentEngineHost.Delay(backoff)
                backoff *= 2
            }
        }
    }

    /** Opens one engine (`GraphEngine.Open`); a seam a test overrides to fail an open. */
    protected OpenEngine(options: IGraphEngineOptions): Promise<GraphEngine>
    {
        return GraphEngine.Open(options)
    }

    private Compose(deliveries: readonly IPackageDelivery[]): Promise<IEnvironmentCatalog>
    {
        return EnvironmentCatalogComposer.Compose({ Deliveries: deliveries, Packages: new StoragePackageSource(this.packages) })
    }

    private RaiseChanged(): void
    {
        try
        {
            this.changed.Raise()
        }
        catch (error)
        {
            this.diagnostics.ChangedHandlerFailed(error)
        }
    }

    private async Teardown(): Promise<void>
    {
        // the running section (and any queued before dispose) finishes first; every later one refuses
        const drained = this.mutex.Run(() => Promise.resolve())
        if (!(await BoundedWait.Within(drained, this.timing.MaxDrainMs ?? EnvironmentEngineHost.MaxDrainMs, this.timer)))
        {
            this.diagnostics.DrainUnsettled()
        }
        const opened = this.opened
        this.opened = undefined
        await opened?.dispose()
    }

    private static SnapshotOf(catalog: IEnvironmentCatalog, deliveries: readonly IPackageDelivery[]): EnvironmentSnapshot
    {
        return {
            Description: catalog.Description,
            CellMapper: new EngineCellMapper(catalog.Snapshot),
            Models: catalog.Packages.map(ref => ref.model).filter(model => model !== SystemNames.Model).sort(),
            Connectors: catalog.Connectors,
            Identity: catalog.Identity,
            Catalog: catalog,
            SchemaCatalog: new EngineSchemaCatalog(catalog.Description),
            Deliveries: deliveries,
        }
    }

    /** The version a change-log entry names: the app version of a Deploy, the `model@version` list of a Promote. */
    private static VersionOf(change: DeliveryChange): string
    {
        return change.Version ?? EnvironmentEngineHost.RefList(change.Packages)
    }

    /** `model@version, ...` of `refs`. */
    private static RefList(refs: readonly Required<PackageRef>[]): string
    {
        return refs.map(ref => ref.model + EnvironmentEngineHost.RefSeparator + ref.version).join(EnvironmentEngineHost.ListSeparator)
    }

    private static KeyOf(snapshot: EnvironmentSnapshot): string
    {
        return ConnectorSetKey.Of(snapshot.Connectors, snapshot.Catalog.Identity)
    }

    private static IsLocked(error: unknown): boolean
    {
        return error instanceof GraphError && error.GraphCode === GraphErrorCode.Locked
    }

    private static Delay(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => { setTimeout(resolve, ms) })
    }
}
