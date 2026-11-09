import { AccessError, ConflictError, ConnectorError, Cypher } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, GraphReader } from '@pragmatic-tech-ai/graph'
import { AppWriteStatus, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherExecuteResultDto, CypherQueryPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EngineBridgeError, EngineBridgeErrorCode } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { AsyncMutex } from '../cypher/async-mutex.js'
import { CypherExecuteResultMapper } from '../cypher/cypher-execute-result-mapper.js'
import { CypherResultMapper } from '../cypher/cypher-result-mapper.js'
import { InProcessWriteLock, WriteLockBusyError } from '../cypher/write-lock.js'
import type { IWriteLease, IWriteLock } from '../cypher/write-lock.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import type { IDevScope, IDevScopeSource } from './dev-access-scope-source.js'
import { DevCypherQuery, DevCypherQueryError, DevCypherQueryErrorCode } from './dev-cypher-query.js'
import type { IDevGraphEngine } from './dev-graph-engine-host.js'
import type { DevSnapshot } from './dev-snapshot-source.js'

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
 * Runs the dev tenant's Cypher writes on its embedded graph engine, under the caller's {@link IDevScope}: the scope
 * alone decides what the write may see and do (the engine's WriteGate judges every op at commit); this class never
 * filters, masks or authorizes by itself. A CREATE is placed in `modelId` by `IDevScope.Placement(modelId)`
 * (TodlNodePlacement + the security model's create defaults); the engine's `.todl` file connector writes the model's
 * saved sources (ServerModelWorkspace), and the host upgrades to them.
 *
 * - `modelId` must be one of `DevSnapshot.Models` (the `cypher/models` list), else InvalidParams "model not found".
 * - Serialized per tenant: an in-process mutex, then the tenant write lease (`IWriteLock`; busy -> Conflict) held
 *   across the whole write. Inside it: an `expectedRevision` other than the language service's `GraphRevision` is
 *   Conflict "graph revision has advanced"; the lease is re-checked (`Held()`) right before the engine write, which
 *   persists as it commits (lost -> Conflict, nothing written). Like the legacy fence, a check and not a storage fence.
 * - Status mapping ({@link DevWriteFailure}): `CypherWriteErrorCode.Conflict` (engine ConflictError) is retried once
 *   (a commit racing an upgrade fails retry-safe), then Conflict; a connector `EngineBridgeError` Stale is Conflict,
 *   both "model sources changed during the write"; Denied or an AccessError (MemberReadOnly, HiddenMember included)
 *   is Denied; Invalid, NodeHasRelationships or EngineBridgeError NotEditable / ForeignId / UnsupportedValue is
 *   Invalid; ConnectorFailed otherwise (PersistFailed, a failed revert) is Failed. A refusal carries no counts or rows.
 * - A write that committed nothing (no changes, a read-only query) is Applied with zero counts and the unchanged
 *   revision; one that committed waits for the host's upgrade to the saved write (`WhenUpgraded`) and returns the
 *   language service's `GraphRevision` then.
 * - RETURN rows: `DevSnapshot.CellMapper.MapResult` with a reader under the same scope (hidden members), then
 *   CypherResultMapper. Engine Syntax / Semantic / IntegerOverflow errors are InvalidParams, a timeout -32030
 *   (DevCypherQuery.WireError).
 */
export class DevCypherExecute implements IDevCypherExecute
{
    public static readonly MaxAttempts = 2
    private static readonly MaxSettles = 5
    private static readonly ModelNotFoundMessage = `${InvalidParamsPrefix.Text}model not found`
    private static readonly RevisionReason = 'graph revision has advanced'
    private static readonly LeaseLostReason = 'the tenant write lease was lost before the write could persist'
    private static readonly SourcesChangedReason = 'model sources changed during the write'
    private static readonly DeniedReason = 'the caller\'s access does not allow the write'
    private static readonly InvalidReason = 'the write is not valid against the model'
    private static readonly FailedReason = 'the model could not be persisted; no changes were kept'
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

    public constructor(
        private readonly host: IDevGraphEngine,
        private readonly scopes: () => Promise<IDevScopeSource>,
        private readonly revision: () => Promise<number>,
        private readonly lock: IWriteLock = new InProcessWriteLock(),
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
        try
        {
            return await this.Leased(context, modelId, request, lease)
        }
        finally
        {
            await lease.Release()
        }
    }

    private async Leased(context: AccessContext, modelId: string, request: DevCypherRequest, lease: IWriteLease): Promise<CypherExecuteResultDto>
    {
        if (request.expectedRevision !== undefined && request.expectedRevision !== await this.revision())
        {
            return CypherExecuteResultMapper.Refused(AppWriteStatus.Conflict, await this.revision(), DevCypherExecute.RevisionReason)
        }
        if (!(await lease.Held())) return CypherExecuteResultMapper.Refused(AppWriteStatus.Conflict, await this.revision(), DevCypherExecute.LeaseLostReason)
        for (let attempt = 1; attempt <= DevCypherExecute.MaxAttempts; attempt++)
        {
            const outcome = await this.Attempt(context, modelId, request, attempt === DevCypherExecute.MaxAttempts)
            if (outcome.Result !== undefined) return outcome.Result
        }
        // unreachable: the last attempt always returns a result
        return this.Refuse(DevWriteFailureKind.EngineConflict)
    }

    private async Attempt(context: AccessContext, modelId: string, request: DevCypherRequest, last: boolean): Promise<Attempt>
    {
        const [engine, snapshot] = await this.Settled()
        const scope = await (await this.scopes()).ScopeFor(context)
        let result: Cypher.CypherResult
        try
        {
            const cypher = new Cypher.CypherEngine(engine, { MaxVarLength: request.maxVarLength })
            result = await cypher.Execute(scope.Scope, request.cypher, { Parameters: request.parameters, Limits: { Cancel: Cypher.Deadline.After(request.timeoutMs) }, Placement: scope.Placement(modelId) })
        }
        catch (error)
        {
            const kind = DevWriteFailure.KindOf(error)
            if (kind === undefined) throw DevCypherQuery.WireError(error)
            if (kind === DevWriteFailureKind.EngineConflict && !last) return Attempt.Conflicted
            return Attempt.Done(await this.Refuse(kind))
        }
        const page = await DevCypherExecute.Page(engine, snapshot, scope, result)
        // a write that committed nothing leaves the saved sources (and so the revision) as they were
        if (result.Commit !== undefined) await this.host.WhenUpgraded()
        return Attempt.Done(CypherExecuteResultMapper.Applied(AppWriteStatus.Applied, await this.revision(), page, result.Stats?.ToDto()))
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
        throw new DevCypherQueryError(DevCypherQueryErrorCode.Unsettled)
    }

    /** The RETURN rows in TODL's wire shape, a reader under the write's scope telling the mapper what it hides. */
    private static async Page(engine: GraphEngine, snapshot: DevSnapshot, scope: IDevScope, result: Cypher.CypherResult): Promise<CypherQueryPageDto>
    {
        let reader: GraphReader | undefined
        try
        {
            reader = await engine.BeginRead(scope.Scope)
            return CypherResultMapper.ToWire(snapshot.CellMapper.MapResult(Cypher.CypherEngine.ToDto(result), reader))
        }
        finally
        {
            reader?.dispose()
        }
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
