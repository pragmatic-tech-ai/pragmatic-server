import { AccessScope, Cypher } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, GraphReader } from '@pragmatic-tech-ai/graph'
import { AppWriteStatus, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherExecuteResultDto, CypherQueryPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { CypherExecuteResultMapper } from '../cypher/cypher-execute-result-mapper.js'
import { CypherResultMapper } from '../cypher/cypher-result-mapper.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import type { IGraphScopeSource } from '../engine/access-scope-source.js'
import type { DevCypherRequest, IGraphCypherExecute } from '../engine/dev-cypher-execute.js'
import { EngineCypherQuery, EngineCypherQueryError, EngineCypherQueryErrorCode } from '../engine/engine-cypher-query.js'
import { EngineWriteFailure } from '../engine/engine-write-failure.js'
import type { IWriteFailureOutcome } from '../engine/engine-write-failure.js'
import { ModelWriteScopes } from '../engine/model-write-scopes.js'
import type { EnvironmentEngineHost, EnvironmentSnapshot } from './environment-engine-host.js'

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
 * The runtime `cypher/execute` (rulings S13, Q9) on the environment engine, under the caller's environment scope: the
 * scope alone decides what the write may see and do (the engine's WriteGate judges every op at commit, read-only
 * bindings and seeded nodes included, S5); this class never filters, masks or authorizes by itself.
 *
 * - No write lease: the tenant-ownership lease already makes the engine single-owner and its OCC serializes (S1).
 * - CREATEs are placed by `IGraphScope.Placement()` (S6: the home package for engine nodes, the binding for external
 *   ones; `modelId` does not affect placement). External writes run through the DataSourceConnector at commit and are
 *   compensated on failure (R9).
 * - `modelId` is optional; when given it must be one of `cypher/models` (S12, else InvalidParams "model not found")
 *   and confines the writes to that package's data ({@link ModelWriteScopes}, as dev T7-b).
 * - `revision` = the latest commit number after the write (unchanged when nothing commits, e.g. an all-external write,
 *   P13); an `expectedRevision` that differs is Conflict "graph revision has advanced".
 * - An engine conflict is retried once (one deadline covers both attempts), then Conflict; every other failure maps
 *   through the shared {@link EngineWriteFailure} table; an error outside it propagates (InternalError). Engine
 *   Syntax / Semantic / IntegerOverflow errors are InvalidParams, a timeout -32030 (EngineCypherQuery.WireError).
 * - RETURN rows as dev: the snapshot's CellMapper with a reader under the write's scope, then CypherResultMapper.
 */
export class EnvironmentCypherExecute implements IGraphCypherExecute
{
    public static readonly MaxAttempts = 2
    private static readonly MaxSettles = 5
    private static readonly ModelNotFoundMessage = `${InvalidParamsPrefix.Text}model not found`
    private static readonly RevisionReason = 'graph revision has advanced'

    private static readonly Conflict: IWriteFailureOutcome = { Status: AppWriteStatus.Conflict, Reason: EngineWriteFailure.WriteConflict }

    private readonly writeScopes = new ModelWriteScopes()

    public constructor(private readonly host: EnvironmentEngineHost, private readonly scopes: () => Promise<IGraphScopeSource>)
    {
    }

    public async Run(context: AccessContext, modelId: string | undefined, request: DevCypherRequest): Promise<CypherExecuteResultDto>
    {
        if (modelId !== undefined && !(await this.host.Snapshot()).Models.includes(modelId))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, EnvironmentCypherExecute.ModelNotFoundMessage)
        }
        // one deadline for every attempt: a retry never extends the caller's timeout
        const deadline = Cypher.Deadline.After(request.timeoutMs)
        let outcome = Attempt.Conflicted
        for (let attempt = 1; attempt <= EnvironmentCypherExecute.MaxAttempts && outcome.Result === undefined; attempt++)
        {
            outcome = await this.Attempt(context, modelId, request, deadline, attempt === EnvironmentCypherExecute.MaxAttempts)
        }
        return outcome.Result ?? this.Refused(EnvironmentCypherExecute.Conflict)
    }

    private async Attempt(context: AccessContext, modelId: string | undefined, request: DevCypherRequest, deadline: Cypher.Deadline, last: boolean): Promise<Attempt>
    {
        const [engine, snapshot] = await this.Settled()
        if (request.expectedRevision !== undefined && request.expectedRevision !== await EnvironmentCypherExecute.Revision(engine))
        {
            return Attempt.Done(CypherExecuteResultMapper.Refused(AppWriteStatus.Conflict, await EnvironmentCypherExecute.Revision(engine), EnvironmentCypherExecute.RevisionReason))
        }
        const graphScope = await (await this.scopes()).ScopeFor(context)
        const scope = modelId === undefined ? graphScope.Scope : this.writeScopes.For(graphScope.Scope, modelId, snapshot.Description)
        let result: Cypher.CypherResult
        try
        {
            const cypher = new Cypher.CypherEngine(engine, { MaxVarLength: request.maxVarLength })
            result = await cypher.Execute(scope, request.cypher, { Parameters: request.parameters, Limits: { Cancel: deadline }, Placement: graphScope.Placement(modelId) })
        }
        catch (error)
        {
            const failure = EngineWriteFailure.Map(error)
            if (failure === undefined) throw EngineCypherQuery.WireError(error)
            if (failure.Status === AppWriteStatus.Conflict && !last) return Attempt.Conflicted
            return Attempt.Done(await this.Refused(failure, engine))
        }
        const page = await EnvironmentCypherExecute.Page(engine, snapshot, scope, result)
        const revision = result.Commit === undefined ? await EnvironmentCypherExecute.Revision(engine) : Number(result.Commit)
        return Attempt.Done(CypherExecuteResultMapper.Applied(AppWriteStatus.Applied, revision, page, result.Stats?.ToDto()))
    }

    private async Refused(failure: IWriteFailureOutcome, engine?: GraphEngine): Promise<CypherExecuteResultDto>
    {
        const revision = await EnvironmentCypherExecute.Revision(engine ?? await this.host.Engine())
        return CypherExecuteResultMapper.Refused(failure.Status, revision, failure.Reason)
    }

    /** The engine and the snapshot it runs, once their versions agree (an upgrade being applied installs its snapshot after). */
    private async Settled(): Promise<[GraphEngine, EnvironmentSnapshot]>
    {
        for (let settle = 0; settle < EnvironmentCypherExecute.MaxSettles; settle++)
        {
            const engine = await this.host.Engine()
            const snapshot = await this.host.Snapshot()
            if (snapshot.Description.Version === engine.SchemaVersion) return [engine, snapshot]
            await EnvironmentCypherExecute.Yield()
        }
        throw new EngineCypherQueryError(EngineCypherQueryErrorCode.Unsettled)
    }

    /** The latest commit number (the wire `revision`). */
    private static async Revision(engine: GraphEngine): Promise<number>
    {
        const reader = await engine.BeginRead(AccessScope.System)
        try
        {
            return Number(reader.SnapshotCommit)
        }
        finally
        {
            reader.dispose()
        }
    }

    /** The RETURN rows in TODL's wire shape, a reader under the write's scope telling the mapper what it hides. */
    private static async Page(engine: GraphEngine, snapshot: EnvironmentSnapshot, scope: AccessScope, result: Cypher.CypherResult): Promise<CypherQueryPageDto>
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

    private static Yield(): Promise<void>
    {
        return new Promise<void>(resolve => setImmediate(resolve))
    }
}
