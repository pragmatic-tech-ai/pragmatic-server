import { Cypher } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, GraphReader } from '@pragmatic-tech-ai/graph'
import { CursorStaleError, CypherProtocol, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherQueryPageDto, PageParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { PagingLimits } from '../../config/paging-limits.js'
import { CypherResultMapper } from '../cypher/cypher-result-mapper.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import { PageFingerprint } from '../paging/page-request.js'
import type { IGraphScope, IGraphScopeSource } from './access-scope-source.js'
import { CypherKeysetPage } from './cypher-keyset-page.js'
import type { IGraphEngineHost } from './graph-engine-host.js'
import { ModelScopes } from './model-scopes.js'

/** The page a dev query asks for: the wire paging params, the connection's paging limits and the row cap. */
export interface IDevCypherPage
{
    readonly Params: PageParams
    readonly Limits: PagingLimits
    readonly RowCap: number
}

/** One dev `cypher/query` request; the handler converts and canonicalizes the wire parameters once. */
export interface IDevCypherRequest
{
    readonly Source: string
    readonly Parameters: ReadonlyMap<string, Cypher.ParameterValue>
    /** `CypherParamConverter.Canonical` of the wire parameters (for the cursor fingerprint). */
    readonly CanonicalParameters: string
    /** A model id of the active solution; the query then sees only that model's instances (and the terms). */
    readonly ModelId?: string
    readonly Page: IDevCypherPage
    readonly TimeoutMs: number
    readonly MaxVarLength: number
}

/** The `cypher/query` and `cypher/models` endpoints' engine side, for any engine host (ruling S1). */
export interface IGraphCypherQuery
{
    Run(context: AccessContext, request: IDevCypherRequest): Promise<CypherQueryPageDto>
    /** The model ids `cypher/query` accepts as `modelId`, sorted. */
    Models(): Promise<readonly string[]>
}

export enum EngineCypherQueryErrorCode
{
    /** The engine kept upgrading on every attempt; a later request runs on the settled engine. */
    Unsettled = 1,
}

export class EngineCypherQueryError extends Error
{
    private static readonly ErrorName = 'EngineCypherQueryError'
    private static readonly Messages: Readonly<Record<EngineCypherQueryErrorCode, string>> = {
        [EngineCypherQueryErrorCode.Unsettled]: 'the graph engine kept changing while the query ran',
    }

    public constructor(public readonly Code: EngineCypherQueryErrorCode)
    {
        super(EngineCypherQueryError.Messages[Code])
        this.name = EngineCypherQueryError.ErrorName
    }
}

/** One attempt's outcome: the page, or that the engine moved while it ran. */
class Attempt
{
    public static readonly Moved = new Attempt(undefined)

    private constructor(public readonly Page: CypherQueryPageDto | undefined)
    {
    }

    public static Done(page: CypherQueryPageDto): Attempt
    {
        return new Attempt(page)
    }
}

/**
 * Runs read-only Cypher on a host's graph engine (IGraphEngineHost), under the caller's {@link IGraphScope}: the scope
 * alone decides what the query sees (rows, hidden members); this class never filters or masks a result itself.
 *
 * - `ModelId` must be one of {@link EngineCypherQuery.Models} (else InvalidParams "model not found", the same error for
 *   every unknown id). It ANDs the S12 model filter ({@link ModelScopes}) into the caller's scope.
 * - The result cells are mapped to TODL's wire shape by the running snapshot's EngineCellMapper, with a reader under
 *   the same scope telling it which relationship-held fields are hidden; then to the wire page (CypherResultMapper).
 * - Pages are keyset pages ({@link CypherKeysetPage}, ruling S11; offset pages only for an order over no returned column,
 *   Q10). Cursor fingerprint: `cypher`, the text, the canonical parameters, the engine schema version, the scope digest,
 *   and for a model-scoped query `model` and the model id. The commit is not in it: commits between pages neither repeat
 *   nor skip rows, while an upgrade or another principal stales the cursor. A query that saw the engine upgrade while it
 *   ran is run again, up to {@link EngineCypherQuery.MaxAttempts} times; a continuation page that never settles is
 *   CursorStale, a first page EngineCypherQueryError Unsettled.
 * - Read-only by construction: a query with writes is refused before anything runs (InvalidParams
 *   {@link EngineCypherQuery.ReadEndpointWriteMessage}; writes belong on `cypher/execute`).
 * - Engine Syntax / Semantic / IntegerOverflow errors are InvalidParams; a timeout is {@link EngineCypherQuery.TimeoutCode}.
 */
export class EngineCypherQuery implements IGraphCypherQuery
{
    public static readonly TimeoutCode = -32030
    public static readonly TimeoutMessage = 'cypher query timed out'
    public static readonly MaxAttempts = 5
    private static readonly FingerprintTag = 'cypher'
    private static readonly ModelScopeTag = 'model'
    public static readonly ModelNotFoundMessage = `${InvalidParamsPrefix.Text}model not found`
    public static readonly ReadEndpointWriteMessage = `${InvalidParamsPrefix.Text}writes are not supported on ${CypherProtocol.Query.method}; send them to ${CypherProtocol.Execute.method}`

    private readonly modelScopes = new ModelScopes()

    public constructor(private readonly host: IGraphEngineHost, private readonly scopes: () => Promise<IGraphScopeSource>)
    {
    }

    public async Models(): Promise<readonly string[]>
    {
        return (await this.host.Snapshot()).Models
    }

    public async Run(context: AccessContext, request: IDevCypherRequest): Promise<CypherQueryPageDto>
    {
        EngineCypherQuery.RefuseWrites(request.Source)
        for (let attempt = 1; attempt <= EngineCypherQuery.MaxAttempts; attempt++)
        {
            const outcome = await this.Attempt(context, request, attempt === EngineCypherQuery.MaxAttempts)
            if (outcome.Page !== undefined) return outcome.Page
        }
        if (EngineCypherQuery.Continues(request.Page.Params)) throw new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
        throw new EngineCypherQueryError(EngineCypherQueryErrorCode.Unsettled)
    }

    private async Attempt(context: AccessContext, request: IDevCypherRequest, last: boolean): Promise<Attempt>
    {
        const engine = await this.host.Engine()
        const before = engine.SchemaVersion
        const snapshot = await this.host.Snapshot()
        if (snapshot.Description.Version !== before)
        {
            // an upgrade is being applied: its snapshot is installed once the engine has upgraded
            await EngineCypherQuery.Yield()
            return Attempt.Moved
        }
        if (request.ModelId !== undefined && !snapshot.Models.includes(request.ModelId))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, EngineCypherQuery.ModelNotFoundMessage)
        }
        const graphScope = await (await this.scopes()).ScopeFor(context)
        const scope = request.ModelId === undefined ? graphScope.Scope : this.modelScopes.For(graphScope.Scope, request.ModelId, snapshot.Description)
        const page = CypherKeysetPage.Resolve(request.Page.Params, EngineCypherQuery.Fingerprint(request, before, graphScope), request.Page.Limits, request.Page.RowCap)
        let mapped: CypherQueryPageDto
        let reader: GraphReader | undefined
        try
        {
            // one reader under the query's scope per attempt: it tells the mapper which members the scope hides
            reader = await engine.BeginRead(scope, { Connector: graphScope.Connector })
            const cypher = new Cypher.CypherEngine(engine, { MaxVarLength: request.MaxVarLength })
            const result = await cypher.Execute(scope, request.Source, { Parameters: request.Parameters, Limits: page.Limits(Cypher.Deadline.After(request.TimeoutMs)), Connector: graphScope.Connector })
            mapped = CypherResultMapper.ToWire(snapshot.CellMapper.MapResult(Cypher.CypherEngine.ToDto(result), reader), page.NextCursor(result))
        }
        catch (error)
        {
            // a scope or plan made for a schema the engine left while the query ran: run it again on the new one
            if (!last && !EngineCypherQuery.Settled(engine, before)) return Attempt.Moved
            throw EngineCypherQuery.WireError(error)
        }
        finally
        {
            reader?.dispose()
        }
        if (!EngineCypherQuery.Settled(engine, before))
        {
            if (!last) return Attempt.Moved
            // never settled: a continuation cannot be served from a state its cursor was not minted for
            if (EngineCypherQuery.Continues(request.Page.Params)) throw new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
        }
        return Attempt.Done(mapped)
    }

    /** Refuses a query with writes: this class runs read-only Cypher whoever hands it a source. */
    private static RefuseWrites(source: string): void
    {
        let writes: boolean
        try
        {
            writes = new Cypher.CypherParser(source).Parse().HasWrites()
        }
        catch (error)
        {
            throw EngineCypherQuery.WireError(error)
        }
        if (writes)
        {
            throw new ResponseError(ErrorCodes.InvalidParams, EngineCypherQuery.ReadEndpointWriteMessage)
        }
    }

    private static Fingerprint(request: IDevCypherRequest, schemaVersion: string, scope: IGraphScope): string
    {
        const parts = [EngineCypherQuery.FingerprintTag, request.Source, request.CanonicalParameters, schemaVersion, scope.Digest]
        if (request.ModelId !== undefined) parts.push(EngineCypherQuery.ModelScopeTag, request.ModelId)
        return PageFingerprint.Of(...parts)
    }

    /** True when the engine is still at the schema version `before` (no upgrade since; commits do not matter, S11). */
    private static Settled(engine: GraphEngine, before: string): boolean
    {
        return engine.SchemaVersion === before
    }

    private static Continues(params: PageParams): boolean
    {
        return params?.cursor !== undefined && params.cursor !== null
    }

    /** An engine Cypher error as the wire error the dev endpoints report (anything else unchanged). */
    public static WireError(error: unknown): unknown
    {
        if (!(error instanceof Cypher.CypherError)) return error
        switch (error.Code)
        {
            case Cypher.CypherErrorCode.Syntax:
            case Cypher.CypherErrorCode.Semantic:
            case Cypher.CypherErrorCode.IntegerOverflow:
                return new ResponseError(ErrorCodes.InvalidParams, `${InvalidParamsPrefix.Text}${error.message}`)
            case Cypher.CypherErrorCode.Timeout:
                return new ResponseError(EngineCypherQuery.TimeoutCode, EngineCypherQuery.TimeoutMessage)
            default:
                return error
        }
    }

    private static Yield(): Promise<void>
    {
        return new Promise<void>(resolve => setImmediate(resolve))
    }
}
