import { AccessDefault, AccessError, AccessScope, ConceptIs, ConflictError, ConnectorError, Cypher, Or, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, GraphReader, ISchemaDescription, IWriteRules } from '@pragmatic-tech-ai/graph'
import { AppWriteStatus, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherExecuteResultDto, CypherQueryPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EngineBridgeError, EngineBridgeErrorCode, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { AsyncMutex } from '../cypher/async-mutex.js'
import { CypherExecuteResultMapper } from '../cypher/cypher-execute-result-mapper.js'
import { CypherResultMapper } from '../cypher/cypher-result-mapper.js'
import { InProcessWriteLock, WriteLockBusyError } from '../cypher/write-lock.js'
import type { IWriteLease, IWriteLock } from '../cypher/write-lock.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import { AccessScopeConjunction } from './access-scope-conjunction.js'
import type { IGraphScopeSource } from './access-scope-source.js'
import { EngineCypherQuery, EngineCypherQueryError, EngineCypherQueryErrorCode } from './engine-cypher-query.js'
import { BoundedWait, DevGraphEngineHost, TimeoutUpgradeTimer } from './dev-graph-engine-host.js'
import type { IDevGraphEngine, IUpgradeTimer } from './dev-graph-engine-host.js'
import type { DevSnapshot } from './dev-snapshot-source.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'
import type { IWriteFence } from './server-model-workspace.js'

/** A validated cypher/execute request, free of wire concerns (the handler converts the parameters once). */
export interface DevCypherRequest
{
    cypher: string
    parameters: ReadonlyMap<string, Cypher.ParameterValue>
    expectedRevision?: number
    timeoutMs: number
    maxVarLength: number
}

/** The dev `cypher/execute` endpoint's engine side. */
export interface IDevCypherExecute
{
    Run(context: AccessContext, modelId: string, request: DevCypherRequest): Promise<CypherExecuteResultDto>
}

/** What a failed engine write means for the caller (see the status mapping on {@link DevCypherExecute}). */
export enum DevWriteFailureKind
{
    /** An engine ConflictError (a concurrent commit, or a commit racing an upgrade): nothing was applied, retry-safe. */
    EngineConflict = 1,
    /** A model's saved sources changed under the write (the connector's EngineBridgeError Stale). */
    SourcesChanged,
    Denied,
    Invalid,
    Failed,
}

/** Classifies an engine write failure; undefined for an error that is not a write outcome (rethrown). */
export class DevWriteFailure
{
    public static KindOf(error: unknown): DevWriteFailureKind | undefined
    {
        if (error instanceof ConflictError) return DevWriteFailureKind.EngineConflict
        if (error instanceof AccessError) return DevWriteFailureKind.Denied
        if (error instanceof ConnectorError) return DevWriteFailure.ConnectorKind(error)
        if (error instanceof EngineBridgeError) return DevWriteFailure.BridgeKind(error)
        if (!(error instanceof Cypher.CypherWriteError)) return undefined
        switch (error.WriteCode)
        {
            case Cypher.CypherWriteErrorCode.Conflict:
                return DevWriteFailureKind.EngineConflict
            case Cypher.CypherWriteErrorCode.Denied:
                return DevWriteFailureKind.Denied
            case Cypher.CypherWriteErrorCode.ConnectorFailed:
                return error.cause instanceof ConnectorError ? DevWriteFailure.ConnectorKind(error.cause) : DevWriteFailureKind.Failed
            default:
                return DevWriteFailureKind.Invalid
        }
    }

    /** The connector's own failure decides; a revert that also failed (an AggregateError cause) is Failed. */
    private static ConnectorKind(error: ConnectorError): DevWriteFailureKind
    {
        return error.cause instanceof EngineBridgeError ? DevWriteFailure.BridgeKind(error.cause) : DevWriteFailureKind.Failed
    }

    private static BridgeKind(error: EngineBridgeError): DevWriteFailureKind
    {
        switch (error.Code)
        {
            case EngineBridgeErrorCode.Stale:
                return DevWriteFailureKind.SourcesChanged
            case EngineBridgeErrorCode.NotEditable:
            case EngineBridgeErrorCode.ForeignId:
            case EngineBridgeErrorCode.UnsupportedValue:
                return DevWriteFailureKind.Invalid
            default:
                return DevWriteFailureKind.Failed
        }
    }
}

/** Where a failure after a committed write is reported (the write is applied; only its rows or upgrade wait failed). */
export interface IDevExecuteDiagnostics
{
    AfterCommitFailed(error: unknown): void
    /**
     * A write's connector writes did not settle within `DevCypherExecute.MaxSettleMs` (a hung connector call): the
     * tenant is wedged (every execute is Failed) until they do; the lease stays held meanwhile.
     */
    WritesUnsettled(): void
}

/** Reports each after-commit failure as one warning on the server logger, by error name only (messages can carry paths). */
export class LoggerDevExecuteDiagnostics implements IDevExecuteDiagnostics
{
    private static readonly Line = 'dev cypher/execute committed, but reading its result or awaiting the upgrade failed: '
    private static readonly UnsettledLine = 'dev cypher/execute: the write\'s file writes did not settle in time; dev writes are refused until they do'
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public AfterCommitFailed(error: unknown): void
    {
        this.logger.Warn(LoggerDevExecuteDiagnostics.Line + (error instanceof Error ? error.name : LoggerDevExecuteDiagnostics.UnknownName))
    }

    public WritesUnsettled(): void
    {
        this.logger.Error(LoggerDevExecuteDiagnostics.UnsettledLine)
    }
}

/** The write lease as the workspace's write fence; remembers whether it was ever found lost. */
class LeaseFence implements IWriteFence
{
    private lost = false

    public constructor(private readonly lease: IWriteLease)
    {
    }

    public get Lost(): boolean
    {
        return this.lost
    }

    public async Held(): Promise<boolean>
    {
        const held = await this.lease.Held()
        if (!held) this.lost = true
        return held
    }
}

/**
 * The caller's scope with its writes confined to one model (ruling T7-b): `Or(ConceptIs todl.Term, OwnerIs(modelId))`
 * ANDed into the `todl.Element` Create, Update and Delete rules (deny-wins), so a write to another model's instance is
 * Denied while reads stay tenant-wide; terms keep the caller's own rules (their writes stay NotEditable -> Invalid).
 * Cached per scope object (one per schema version) and model id.
 */
class ModelWriteScopes
{
    private readonly scopes = new WeakMap<AccessScope, Map<string, AccessScope>>()
    private catalog: { readonly Description: ISchemaDescription; readonly Catalog: EngineSchemaCatalog } | undefined

    public For(scope: AccessScope, modelId: string, description: ISchemaDescription): AccessScope
    {
        let byModel = this.scopes.get(scope)
        if (byModel === undefined)
        {
            byModel = new Map<string, AccessScope>()
            this.scopes.set(scope, byModel)
        }
        let confined = byModel.get(modelId)
        if (confined === undefined)
        {
            const own = new Or([new ConceptIs(TodlNames.Term), new OwnerIs(new Set([modelId]))])
            const rules: IWriteRules = { Create: own, Update: own, Delete: own }
            const writes = new Map([[TodlNames.Element, rules]])
            confined = AccessScopeConjunction.And(scope, AccessScope.Build({ Default: AccessDefault.Allow, Writes: writes }), this.CatalogOf(description))
            byModel.set(modelId, confined)
        }
        return confined
    }

    private CatalogOf(description: ISchemaDescription): EngineSchemaCatalog
    {
        if (this.catalog === undefined || this.catalog.Description !== description)
        {
            this.catalog = { Description: description, Catalog: new EngineSchemaCatalog(description) }
        }
        return this.catalog.Catalog
    }
}

/** One attempt's outcome: the wire result, or that the engine conflicted (nothing applied) and a retry may succeed. */
class Attempt
{
    public static readonly Conflicted = new Attempt(undefined)

    private constructor(public readonly Result: CypherExecuteResultDto | undefined)
    {
    }

    public static Done(result: CypherExecuteResultDto): Attempt
    {
        return new Attempt(result)
    }
}

/**
 * Runs the dev tenant's Cypher writes on its embedded graph engine, under the caller's dev scope: the scope alone
 * decides what the write may see and do (the engine's WriteGate judges every op at commit); this class never filters,
 * masks or authorizes by itself. A CREATE is placed in `modelId` by `IGraphScope.Placement(modelId)` (TodlNodePlacement
 * + the security model's create defaults) and every write is confined to `modelId` ({@link ModelWriteScopes}, an
 * engine scope conjunct); reads stay tenant-wide. The engine's `.todl` file connector writes the model's saved sources
 * (ServerModelWorkspace), and the host upgrades to them.
 *
 * - `modelId` must be one of `DevSnapshot.Models` (the `cypher/models` list), else InvalidParams "model not found".
 * - Serialized per tenant: an in-process mutex, then the tenant write lease (`IWriteLock`; busy -> Conflict) held
 *   across the whole write and installed as the workspace's write fence (`IDevGraphEngine.InstallWriteFence`); both
 *   are released only after `IDevGraphEngine.WhenWritesSettled`, so a connector still writing after a write-through
 *   timeout (or its late revert) finishes before the next write starts, on success, failure and throw alike. Each
 *   attempt first checks `expectedRevision` against the language service's `GraphRevision` (else Conflict "graph
 *   revision has advanced") and the lease (`Held()`, else Conflict "the tenant write lease was lost before the write
 *   could persist"); each draft session checks the fence again right before its first file write, so nothing persists
 *   once the lease is lost (same Conflict). Like the legacy fence, a check and not a storage fence.
 * - Status mapping ({@link DevWriteFailure}): `CypherWriteErrorCode.Conflict` (engine ConflictError) is retried once
 *   (a commit racing an upgrade fails retry-safe), then Conflict; a connector `EngineBridgeError` Stale is Conflict,
 *   both "model sources changed during the write"; Denied or an AccessError (MemberReadOnly, HiddenMember included)
 *   is Denied; Invalid, NodeHasRelationships or EngineBridgeError NotEditable / ForeignId / UnsupportedValue is
 *   Invalid; ConnectorFailed otherwise (PersistFailed, a failed revert) is Failed. A refusal carries no counts or rows
 *   and the revision read after the connector restored what it wrote.
 * - A write that committed nothing (no changes, a read-only query) is Applied with zero counts and the unchanged
 *   revision; one that committed waits for the host's upgrade to the saved write (`WhenUpgraded`) and returns the
 *   language service's `GraphRevision` then. A failure after the commit (mapping the rows, the upgrade wait) never
 *   turns the applied write into an error: it is reported to {@link IDevExecuteDiagnostics} and the result is Applied
 *   (no rows when they could not be read).
 * - One `timeoutMs` deadline covers both attempts.
 * - RETURN rows: `DevSnapshot.CellMapper.MapResult` with a reader under the same scope (hidden members), then
 *   CypherResultMapper. Engine Syntax / Semantic / IntegerOverflow errors are InvalidParams, a timeout -32030
 *   (EngineCypherQuery.WireError).
 */
export class DevCypherExecute implements IDevCypherExecute
{
    public static readonly MaxAttempts = 2
    /** How long a write waits for its connector writes to settle before the tenant is wedged (ruling F-f). */
    public static readonly MaxSettleMs = 2 * DevGraphEngineHost.PrepareTimeoutMs
    private static readonly WedgedReason = 'an earlier write is still persisting; retry later'
    private static readonly MaxSettles = 5
    private static readonly ModelNotFoundMessage = `${InvalidParamsPrefix.Text}model not found`
    private static readonly RevisionReason = 'graph revision has advanced'
    private static readonly LeaseLostReason = 'the tenant write lease was lost before the write could persist'
    private static readonly SourcesChangedReason = 'model sources changed during the write'
    private static readonly DeniedReason = 'the caller\'s access does not allow the write'
    private static readonly InvalidReason = 'the write is not valid against the model'
    private static readonly FailedReason = 'the model could not be persisted; no changes were kept'
    private static readonly NoRows: CypherQueryPageDto = { columns: [], items: [], truncated: false }
    private static readonly Reasons: Readonly<Record<DevWriteFailureKind, string>> = {
        [DevWriteFailureKind.EngineConflict]: DevCypherExecute.SourcesChangedReason,
        [DevWriteFailureKind.SourcesChanged]: DevCypherExecute.SourcesChangedReason,
        [DevWriteFailureKind.Denied]: DevCypherExecute.DeniedReason,
        [DevWriteFailureKind.Invalid]: DevCypherExecute.InvalidReason,
        [DevWriteFailureKind.Failed]: DevCypherExecute.FailedReason,
    }
    private static readonly Statuses: Readonly<Record<DevWriteFailureKind, AppWriteStatus>> = {
        [DevWriteFailureKind.EngineConflict]: AppWriteStatus.Conflict,
        [DevWriteFailureKind.SourcesChanged]: AppWriteStatus.Conflict,
        [DevWriteFailureKind.Denied]: AppWriteStatus.Denied,
        [DevWriteFailureKind.Invalid]: AppWriteStatus.Invalid,
        [DevWriteFailureKind.Failed]: AppWriteStatus.Failed,
    }

    private readonly mutex = new AsyncMutex()
    private readonly writeScopes = new ModelWriteScopes()
    /** Set while an earlier write's connector writes outlived the settle bound: every Run is Failed until it clears. */
    private wedged: Promise<void> | undefined

    public constructor(
        private readonly host: IDevGraphEngine,
        private readonly scopes: () => Promise<IGraphScopeSource>,
        private readonly revision: () => Promise<number>,
        private readonly lock: IWriteLock = new InProcessWriteLock(),
        private readonly diagnostics: IDevExecuteDiagnostics = new LoggerDevExecuteDiagnostics(),
        /** The timer seam bounding the settle wait ({@link DevCypherExecute.MaxSettleMs}). */
        private readonly settleTimer: IUpgradeTimer = new TimeoutUpgradeTimer(),
    )
    {
    }

    public async Run(context: AccessContext, modelId: string, request: DevCypherRequest): Promise<CypherExecuteResultDto>
    {
        if (!(await this.host.Snapshot()).Models.includes(modelId))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, DevCypherExecute.ModelNotFoundMessage)
        }
        return this.mutex.Run(() => this.Locked(context, modelId, request))
    }

    private async Locked(context: AccessContext, modelId: string, request: DevCypherRequest): Promise<CypherExecuteResultDto>
    {
        // wedged: an earlier write may still be writing files; refuse before taking the lease
        if (this.wedged !== undefined) return CypherExecuteResultMapper.Refused(AppWriteStatus.Failed, await this.revision(), DevCypherExecute.WedgedReason)
        let lease: IWriteLease
        try
        {
            lease = await this.lock.Acquire()
        }
        catch (error)
        {
            if (error instanceof WriteLockBusyError) return CypherExecuteResultMapper.Refused(AppWriteStatus.Conflict, await this.revision(), error.message)
            throw error
        }
        const fence = new LeaseFence(lease)
        // dev writes are serialized by the mutex: this write's lease is the only fence installed while it runs
        const installed = this.host.InstallWriteFence(fence)
        try
        {
            return await this.Leased(context, modelId, request, fence)
        }
        finally
        {
            // on every path: a write-through that timed out may still be writing files (and then reverting them); the
            // next writer starts only once they settle, so the fence, lease and mutex are released after. Bounded
            // (F-f): past MaxSettleMs the mutex is released but the tenant is wedged, keeping the lease and the fence
            // until the writes settle in the background.
            const settling = this.host.WhenWritesSettled()
            if (await BoundedWait.Within(settling, DevCypherExecute.MaxSettleMs, this.settleTimer))
            {
                installed.dispose()
                await lease.Release()
            }
            else
            {
                this.Wedge(settling, installed, lease)
            }
        }
    }

    private Wedge(settling: Promise<void>, installed: IDisposable, lease: IWriteLease): void
    {
        this.diagnostics.WritesUnsettled()
        const cleared = settling.catch(() => undefined).then(async () =>
        {
            try
            {
                installed.dispose()
                await lease.Release()
            }
            finally
            {
                this.wedged = undefined
            }
        })
        this.wedged = cleared.catch(() => undefined)
    }

    private async Leased(context: AccessContext, modelId: string, request: DevCypherRequest, fence: LeaseFence): Promise<CypherExecuteResultDto>
    {
        // one deadline for every attempt: a retry never extends the caller's timeout
        const deadline = Cypher.Deadline.After(request.timeoutMs)
        let outcome = Attempt.Conflicted
        for (let attempt = 1; attempt <= DevCypherExecute.MaxAttempts && outcome.Result === undefined; attempt++)
        {
            outcome = await this.Attempt(context, modelId, request, fence, deadline, attempt === DevCypherExecute.MaxAttempts)
        }
        return outcome.Result ?? this.Refuse(DevWriteFailureKind.EngineConflict)
    }

    private async Attempt(context: AccessContext, modelId: string, request: DevCypherRequest, fence: LeaseFence, deadline: Cypher.Deadline, last: boolean): Promise<Attempt>
    {
        if (request.expectedRevision !== undefined && request.expectedRevision !== await this.revision())
        {
            return Attempt.Done(CypherExecuteResultMapper.Refused(AppWriteStatus.Conflict, await this.revision(), DevCypherExecute.RevisionReason))
        }
        if (!(await fence.Held())) return Attempt.Done(await this.LeaseLost())
        const [engine, snapshot] = await this.Settled()
        const devScope = await (await this.scopes()).ScopeFor(context)
        const scope = this.writeScopes.For(devScope.Scope, modelId, snapshot.Description)
        let result: Cypher.CypherResult
        try
        {
            const cypher = new Cypher.CypherEngine(engine, { MaxVarLength: request.maxVarLength })
            result = await cypher.Execute(scope, request.cypher, { Parameters: request.parameters, Limits: { Cancel: deadline }, Placement: devScope.Placement(modelId) })
        }
        catch (error)
        {
            const kind = DevWriteFailure.KindOf(error)
            if (kind === undefined) throw EngineCypherQuery.WireError(error)
            if (kind === DevWriteFailureKind.EngineConflict && !last) return Attempt.Conflicted
            // a draft session refuses (Stale) once the fence it checks before its first write no longer holds
            if (kind === DevWriteFailureKind.SourcesChanged && fence.Lost) return Attempt.Done(await this.LeaseLost())
            return Attempt.Done(await this.Refuse(kind))
        }
        return Attempt.Done(await this.Applied(engine, snapshot, scope, result))
    }

    /** The applied result; nothing after the commit can fail it (reported, rows best-effort). */
    private async Applied(engine: GraphEngine, snapshot: DevSnapshot, scope: AccessScope, result: Cypher.CypherResult): Promise<CypherExecuteResultDto>
    {
        let page = DevCypherExecute.NoRows
        try
        {
            page = await DevCypherExecute.Page(engine, snapshot, scope, result)
        }
        catch (error)
        {
            this.diagnostics.AfterCommitFailed(error)
        }
        // a write that committed nothing leaves the saved sources (and so the revision) as they were
        if (result.Commit !== undefined)
        {
            try
            {
                await this.host.WhenUpgraded()
            }
            catch (error)
            {
                this.diagnostics.AfterCommitFailed(error)
            }
        }
        return CypherExecuteResultMapper.Applied(AppWriteStatus.Applied, await this.revision(), page, result.Stats?.ToDto())
    }

    /** The engine and the snapshot it runs, after any upgrade already asked for (their versions agree). */
    private async Settled(): Promise<[GraphEngine, DevSnapshot]>
    {
        for (let settle = 0; settle < DevCypherExecute.MaxSettles; settle++)
        {
            await this.host.WhenUpgraded()
            const engine = await this.host.Engine()
            const snapshot = await this.host.Snapshot()
            if (snapshot.Description.Version === engine.SchemaVersion) return [engine, snapshot]
            // an upgrade is being applied: its snapshot is installed once the engine has upgraded
            await DevCypherExecute.Yield()
        }
        throw new EngineCypherQueryError(EngineCypherQueryErrorCode.Unsettled)
    }

    /** The RETURN rows in TODL's wire shape, a reader under the write's scope telling the mapper what it hides. */
    private static async Page(engine: GraphEngine, snapshot: DevSnapshot, scope: AccessScope, result: Cypher.CypherResult): Promise<CypherQueryPageDto>
    {
        let reader: GraphReader | undefined
        try
        {
            reader = await engine.BeginRead(scope)
            return CypherResultMapper.ToWire(snapshot.CellMapper.MapResult(Cypher.CypherEngine.ToDto(result), reader))
        }
        finally
        {
            reader?.dispose()
        }
    }

    private async LeaseLost(): Promise<CypherExecuteResultDto>
    {
        return CypherExecuteResultMapper.Refused(AppWriteStatus.Conflict, await this.revision(), DevCypherExecute.LeaseLostReason)
    }

    private async Refuse(kind: DevWriteFailureKind): Promise<CypherExecuteResultDto>
    {
        return CypherExecuteResultMapper.Refused(DevCypherExecute.Statuses[kind], await this.revision(), DevCypherExecute.Reasons[kind])
    }

    private static Yield(): Promise<void>
    {
        return new Promise<void>(resolve => setImmediate(resolve))
    }
}
