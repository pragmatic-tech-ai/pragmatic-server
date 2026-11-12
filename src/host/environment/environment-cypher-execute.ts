import { AccessScope, Cypher } from '@pragmatic-tech-ai/graph'
import type { ConnectorContext, GraphEngine, GraphReader } from '@pragmatic-tech-ai/graph'
import { AppWriteStatus, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherExecuteResultDto, CypherQueryPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { AsyncMutex } from '../cypher/async-mutex.js'
import { CypherExecuteResultMapper } from '../cypher/cypher-execute-result-mapper.js'
import { CypherResultMapper } from '../cypher/cypher-result-mapper.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import type { IGraphScopeSource } from '../engine/access-scope-source.js'
import { EngineCypherQuery } from '../engine/engine-cypher-query.js'
import { EngineWriteFailure } from '../engine/engine-write-failure.js'
import type { IWriteFailureOutcome } from '../engine/engine-write-failure.js'
import { ExecuteAttempt, LoggerExecuteDiagnostics } from '../engine/graph-cypher-execute.js'
import type { ICypherExecuteRequest, IExecuteDiagnostics, IGraphCypherExecute } from '../engine/graph-cypher-execute.js'
import { ModelWriteScopes } from '../engine/model-write-scopes.js'
import type { EnvironmentEngineHost, EnvironmentSnapshot } from './environment-engine-host.js'
import { CallerConnectorContext } from './caller-connector-context.js'

/**
 * The runtime `cypher/execute` (rulings S13, Q9) on the environment engine, under the caller's environment scope: the
 * scope alone decides what the write may see and do (the engine's WriteGate judges every op at commit, read-only
 * bindings and seeded nodes included, S5); this class never filters, masks or authorizes by itself.
 *
 * - No tenant write lease: the tenant-ownership lease already makes the engine single-owner and its OCC serializes
 *   (S1). Executes of one host run one at a time under an in-process mutex (ruling R37), so the `expectedRevision`
 *   check and the write it guards are atomic against other `cypher/execute` calls only. Other writers (data/write,
 *   share, assign, connector commits) are not under this mutex and can commit between the revision read and the
 *   write: a write that reads its targets is still caught by the engine's OCC (and retried), a plain CREATE is not.
 * - CREATEs are placed by `IGraphScope.Placement()` (S6: the home package for engine nodes, the binding for external
 *   ones; `modelId` does not affect placement). External writes run through the DataSourceConnector at commit and are
 *   compensated on failure (R9).
 * - `modelId` is optional; when given it must be one of `cypher/models` (S12, else InvalidParams "model not found")
 *   and confines the writes to that package's data ({@link ModelWriteScopes}, as dev T7-b).
 * - `revision` = the latest commit number after the write (unchanged when nothing commits, e.g. an all-external write,
 *   P13); an `expectedRevision` that differs is Conflict "graph revision has advanced".
 * - The engine's own OCC conflict is retried once (one deadline covers both attempts), then Conflict; every other
 *   failure maps through the shared {@link EngineWriteFailure} table (an external source's conflict is Conflict, not
 *   retried); an error outside it propagates (InternalError). Engine Syntax / Semantic / IntegerOverflow errors are
 *   InvalidParams, a timeout -32030 (EngineCypherQuery.WireError).
 * - RETURN rows as dev: the snapshot's CellMapper with a reader under the write's scope, then CypherResultMapper. A
 *   failure after the commit (reading the rows or the revision) never turns the applied write into an error: it is
 *   reported to {@link IExecuteDiagnostics} and the result is Applied (no rows when they could not be read).
 */
export class EnvironmentCypherExecute implements IGraphCypherExecute
{
    public static readonly MaxAttempts = 2
    private static readonly ModelNotFoundMessage = `${InvalidParamsPrefix.Text}model not found`
    private static readonly RevisionReason = 'graph revision has advanced'
    private static readonly NoRows: CypherQueryPageDto = { columns: [], items: [], truncated: false }

    private readonly writeScopes = new ModelWriteScopes()
    private readonly mutex = new AsyncMutex()

    public constructor(
        private readonly host: EnvironmentEngineHost,
        private readonly scopes: () => Promise<IGraphScopeSource>,
        private readonly diagnostics: IExecuteDiagnostics = new LoggerExecuteDiagnostics())
    {
    }

    public async Run(context: AccessContext, modelId: string | undefined, request: ICypherExecuteRequest): Promise<CypherExecuteResultDto>
    {
        if (modelId !== undefined && !(await this.host.Snapshot()).Models.includes(modelId))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, EnvironmentCypherExecute.ModelNotFoundMessage)
        }
        return this.mutex.Run(() => this.Locked(context, modelId, request))
    }

    private async Locked(context: AccessContext, modelId: string | undefined, request: ICypherExecuteRequest): Promise<CypherExecuteResultDto>
    {
        // one deadline for every attempt: a retry never extends the caller's timeout
        const deadline = Cypher.Deadline.After(request.timeoutMs)
        let outcome = ExecuteAttempt.Conflicted
        // the last attempt never answers Conflicted, so the loop always ends with a result
        for (let attempt = 1; outcome.Result === undefined; attempt++)
        {
            outcome = await this.Attempt(context, modelId, request, deadline, attempt === EnvironmentCypherExecute.MaxAttempts)
        }
        return outcome.Result
    }

    private async Attempt(context: AccessContext, modelId: string | undefined, request: ICypherExecuteRequest, deadline: Cypher.Deadline, last: boolean): Promise<ExecuteAttempt>
    {
        const [engine, snapshot] = await this.host.Settled()
        const connector = CallerConnectorContext.For(context.Principal)
        if (request.expectedRevision !== undefined)
        {
            const revision = await EnvironmentCypherExecute.Revision(engine, connector)
            if (request.expectedRevision !== revision)
            {
                return ExecuteAttempt.Done(CypherExecuteResultMapper.Refused(AppWriteStatus.Conflict, revision, EnvironmentCypherExecute.RevisionReason))
            }
        }
        const graphScope = await (await this.scopes()).ScopeFor(context)
        const scope = modelId === undefined ? graphScope.Scope : this.writeScopes.For(graphScope.Scope, modelId, snapshot.Description)
        let result: Cypher.CypherResult
        try
        {
            const cypher = new Cypher.CypherEngine(engine, { MaxVarLength: request.maxVarLength })
            result = await cypher.Execute(scope, request.cypher, { Parameters: request.parameters, Limits: { Cancel: deadline }, Placement: graphScope.Placement(modelId), Connector: connector })
        }
        catch (error)
        {
            const failure = EngineWriteFailure.Map(error)
            if (failure === undefined) throw EngineCypherQuery.WireError(error)
            if (EngineWriteFailure.IsEngineConflict(error) && !last) return ExecuteAttempt.Conflicted
            return ExecuteAttempt.Done(await EnvironmentCypherExecute.Refused(failure, engine, connector))
        }
        return ExecuteAttempt.Done(await this.Applied(engine, snapshot, scope, connector, result))
    }

    /** The applied result; nothing after the commit can fail it (reported, rows best-effort). */
    private async Applied(engine: GraphEngine, snapshot: EnvironmentSnapshot, scope: AccessScope, connector: ConnectorContext, result: Cypher.CypherResult): Promise<CypherExecuteResultDto>
    {
        let page = EnvironmentCypherExecute.NoRows
        let revision = result.Commit === undefined ? undefined : Number(result.Commit)
        try
        {
            page = await EnvironmentCypherExecute.Page(engine, snapshot, scope, connector, result)
            revision ??= await EnvironmentCypherExecute.Revision(engine, connector)
        }
        catch (error)
        {
            this.diagnostics.AfterCommitFailed(error)
        }
        // a write that committed nothing and whose revision could not be read reports the commit it never moved: 0
        return CypherExecuteResultMapper.Applied(AppWriteStatus.Applied, revision ?? 0, page, result.Stats?.ToDto())
    }

    private static async Refused(failure: IWriteFailureOutcome, engine: GraphEngine, connector: ConnectorContext): Promise<CypherExecuteResultDto>
    {
        return CypherExecuteResultMapper.Refused(failure.Status, await EnvironmentCypherExecute.Revision(engine, connector), failure.Reason)
    }

    /** The latest commit number (the wire `revision`). */
    private static async Revision(engine: GraphEngine, connector: ConnectorContext): Promise<number>
    {
        const reader = await engine.BeginRead(AccessScope.System, { Connector: connector })
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
    private static async Page(engine: GraphEngine, snapshot: EnvironmentSnapshot, scope: AccessScope, connector: ConnectorContext, result: Cypher.CypherResult): Promise<CypherQueryPageDto>
    {
        let reader: GraphReader | undefined
        try
        {
            reader = await engine.BeginRead(scope, { Connector: connector })
            return CypherResultMapper.ToWire(snapshot.CellMapper.MapResult(Cypher.CypherEngine.ToDto(result), reader))
        }
        finally
        {
            reader?.dispose()
        }
    }
}
