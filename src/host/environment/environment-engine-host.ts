import { ConnectorPhase, GraphEngine, GraphError, GraphErrorCode } from '@pragmatic-tech-ai/graph'
import type { ConnectorError, IGraphEngineOptions, ISchemaDescription, ISignal, ISubscription, StorageKind } from '@pragmatic-tech-ai/graph'
import { StoragePackageSource } from '@pragmatic-tech-ai/todl'
import { EngineCellMapper, EnvironmentCatalogComposer, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog, IPackageDelivery } from '@pragmatic-tech-ai/todl/engine'
import type { IDisposable, IServiceProvider, IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { AsyncMutex } from '../cypher/async-mutex.js'
import { BoundedWait, TimeoutUpgradeTimer } from '../engine/bounded-wait.js'
import type { IUpgradeTimer } from '../engine/bounded-wait.js'
import { ConnectorSetKey } from '../engine/connector-set-key.js'
import { EngineHostChanged } from '../engine/engine-host-changed.js'
import type { IEngineSnapshot, IGraphEngineHost } from '../engine/graph-engine-host.js'
import { LazyExternalConnector } from '../engine/lazy-external-connector.js'
import type { DeliveryChange, EnvironmentDeliveries, IDeliveryGate } from './environment-deliveries.js'

/**
 * What the environment engine runs, in one read: the engine snapshot (`Description`, `Connectors` and `Identity` from
 * the composed catalog, `Models` = its package model ids other than `todl.system`, sorted (ruling S12), `CellMapper`
 * over the catalog's metadata), the whole catalog, and the deliveries it was composed from.
 */
export type EnvironmentSnapshot = IEngineSnapshot & {
    readonly Catalog: IEnvironmentCatalog
    readonly Deliveries: readonly IPackageDelivery[]
}

/** Where the environment host reports what it never throws at a caller, or throws only after reporting. */
export interface IEnvironmentDiagnostics
{
    /** A redelivery (upgrade or reopen) did not apply; the host is stale and the next use retries it. */
    UpgradeFailed(error: unknown): void
    /** A `Changed` subscriber threw (the upgrade itself applied). */
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

/**
 * A delivery was validated and persisted (S4 steps 1-3), but redelivering it to the engine (step 4) failed: the host is
 * stale and the next use retries. `Result` is what the persist step returned; `cause` the redelivery failure.
 */
export class EnvironmentUpgradeFailedError extends Error
{
    public static readonly Reason = 'deployed, but the environment graph could not be upgraded; it is retried on next use'
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
 * same path (Open upgrades it). `Changed` is raised after every applied upgrade or reopen. A redelivery that fails is
 * reported (`UpgradeFailed`) and leaves the host stale: the next `Engine()` / `Snapshot()` / `Description()` redelivers
 * before serving (and fails while that fails).
 *
 * `Deliver(change, persist)` is S4: under the mutex it composes the prospective deliveries (an EnvironmentCatalogError
 * rejects before `persist` runs, nothing persisted), runs `persist` (the app live pointer or the promote record), then
 * redelivers; a redelivery failure there rejects with EnvironmentUpgradeFailedError (the delivery stays persisted).
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

    public readonly Changed: ISignal<void>

    private readonly changed = new EngineHostChanged()
    private readonly mutex = new AsyncMutex()
    private opened: OpenedEnvironment | undefined
    private stale = false
    /** True once an engine was launched: a later first-open branch replaces one, so it raises Changed. */
    private launched = false
    private disposing: Promise<void> | undefined

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
    )
    {
        this.Changed = this.changed
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
     * Ruling S4: validates the prospective deliveries (`change` applied) by composing them, then runs `persist`, then
     * redelivers, all under the host mutex. An EnvironmentCatalogError (or any compose failure) rejects before
     * `persist` runs; a redelivery failure rejects with EnvironmentUpgradeFailedError carrying `persist`'s result.
     */
    public Deliver<T>(change: DeliveryChange, persist: () => Promise<T>): Promise<T>
    {
        return this.Serialized(async () =>
        {
            await this.Compose(await this.deliveries.With(change))
            const result = await persist()
            if (this.disposing !== undefined)
            {
                // the lease went while persisting: the delivery is on disk, the next lease holder opens over it
                this.stale = true
                return result
            }
            try
            {
                await this.Apply()
            }
            catch (error)
            {
                throw new EnvironmentUpgradeFailedError(result, error)
            }
            return result
        })
    }

    /** Recomposes over the current deliveries and upgrades or reopens the engine (nothing when it is not open yet). */
    public Redeliver(): Promise<void>
    {
        return this.Serialized(() => this.Apply())
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
        return this.Serialized(async () =>
        {
            if (this.opened === undefined)
            {
                // a first open, or the recovery from a failed reopen: that one replaces a disposed engine (Changed)
                const replacing = this.launched
                const deliveries = await this.deliveries.Current()
                this.opened = await this.Launch(EnvironmentEngineHost.SnapshotOf(await this.Compose(deliveries), deliveries))
                this.stale = false
                if (replacing) this.RaiseChanged()
            }
            else if (this.stale)
            {
                await this.Apply()
            }
            return this.opened!
        })
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
            Deliveries: deliveries,
        }
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
