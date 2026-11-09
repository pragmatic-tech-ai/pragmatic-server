import { AccessDefault, AccessScope, ConceptIs, Cypher, Or, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, GraphReader, ISchemaDescription } from '@pragmatic-tech-ai/graph'
import { CursorStaleError, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherQueryPageDto, PageParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { PagingLimits } from '../../config/paging-limits.js'
import { CypherResultMapper } from '../cypher/cypher-result-mapper.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import { PageFingerprint, PageRequest } from '../paging/page-request.js'
import { AccessScopeConjunction } from './access-scope-conjunction.js'
import type { IDevScope, IDevScopeSource } from './dev-access-scope-source.js'
import type { IDevGraphEngine } from './dev-graph-engine-host.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'

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

/** The dev `cypher/query` and `cypher/models` endpoints' engine side. */
export interface IDevCypherQuery
{
    Run(context: AccessContext, request: IDevCypherRequest): Promise<CypherQueryPageDto>
    /** The model ids `cypher/query` accepts as `modelId`, sorted. */
    Models(): Promise<readonly string[]>
}

export enum DevCypherQueryErrorCode
{
    /** The engine kept upgrading or committing on every attempt; a later request runs on the settled engine. */
    Unsettled = 1,
}

export class DevCypherQueryError extends Error
{
    private static readonly ErrorName = 'DevCypherQueryError'
    private static readonly Messages: Readonly<Record<DevCypherQueryErrorCode, string>> = {
        [DevCypherQueryErrorCode.Unsettled]: 'the dev graph engine kept changing while the query ran',
    }

    public constructor(public readonly Code: DevCypherQueryErrorCode)
    {
        super(DevCypherQueryError.Messages[Code])
        this.name = DevCypherQueryError.ErrorName
    }
}

/** The engine's schema version and latest commit: a page is only valid for the state it was read at. */
class EngineState
{
    public constructor(public readonly Version: string, public readonly Commit: bigint)
    {
    }

    public static async Of(engine: GraphEngine): Promise<EngineState>
    {
        const reader = await engine.BeginRead(AccessScope.System)
        try
        {
            return new EngineState(engine.SchemaVersion, reader.SnapshotCommit)
        }
        finally
        {
            reader.dispose()
        }
    }

    public Equals(other: EngineState): boolean
    {
        return this.Version === other.Version && this.Commit === other.Commit
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
 * Runs the dev tenant's read-only Cypher on its embedded graph engine, under the caller's {@link IDevScope}: the scope
 * alone decides what the query sees (rows, hidden members); this class never filters or masks a result itself.
 *
 * - `ModelId` must be one of {@link DevCypherQuery.Models} (else InvalidParams "model not found", the same error for
 *   every unknown id). It ANDs `Or(ConceptIs todl.Term, OwnerIs(modelId))` into the `todl.Element` rows entry of the
 *   caller's scope (AccessScopeConjunction, deny-wins): the model filter reaches every concept but the taxonomy terms
 *   (owned by the solution package), which the caller's own scope alone governs, so term refs survive.
 * - The result cells are mapped to TODL's wire shape by the running snapshot's EngineCellMapper, with a reader under
 *   the same scope telling it which relationship-held fields are hidden; then to the wire page (CypherResultMapper).
 * - Cursor fingerprint: `cypher`, the text, the canonical parameters, the engine schema version and commit, the scope
 *   digest, and for a model-scoped query `model` and the model id. A query that saw the engine move (an upgrade or a
 *   commit while it ran) is run again, up to {@link DevCypherQuery.MaxAttempts} times; a continuation page that never
 *   settles is CursorStale, a first page DevCypherQueryError Unsettled.
 * - Engine Syntax / Semantic / IntegerOverflow errors are InvalidParams; a timeout is {@link DevCypherQuery.TimeoutCode}.
 */
export class DevCypherQuery implements IDevCypherQuery
{
    public static readonly TimeoutCode = -32030
    public static readonly TimeoutMessage = 'cypher query timed out'
    public static readonly MaxAttempts = 5
    private static readonly FingerprintTag = 'cypher'
    private static readonly ModelScopeTag = 'model'
    private static readonly ModelNotFoundMessage = `${InvalidParamsPrefix.Text}model not found`

    private catalog: { readonly Description: ISchemaDescription; readonly Catalog: EngineSchemaCatalog } | undefined
    private readonly modelScopes = new WeakMap<AccessScope, Map<string, AccessScope>>()

    public constructor(private readonly host: IDevGraphEngine, private readonly scopes: () => Promise<IDevScopeSource>)
    {
    }

    public async Models(): Promise<readonly string[]>
    {
        return (await this.host.Snapshot()).Models
    }

    public async Run(context: AccessContext, request: IDevCypherRequest): Promise<CypherQueryPageDto>
    {
        for (let attempt = 1; attempt <= DevCypherQuery.MaxAttempts; attempt++)
        {
            const outcome = await this.Attempt(context, request, attempt === DevCypherQuery.MaxAttempts)
            if (outcome.Page !== undefined) return outcome.Page
        }
        if (DevCypherQuery.Continues(request.Page.Params)) throw new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
        throw new DevCypherQueryError(DevCypherQueryErrorCode.Unsettled)
    }

    private async Attempt(context: AccessContext, request: IDevCypherRequest, last: boolean): Promise<Attempt>
    {
        const engine = await this.host.Engine()
        const before = await EngineState.Of(engine)
        const snapshot = await this.host.Snapshot()
        if (snapshot.Description.Version !== before.Version)
        {
            // an upgrade is being applied: its snapshot is installed once the engine has upgraded
            await DevCypherQuery.Yield()
            return Attempt.Moved
        }
        if (request.ModelId !== undefined && !snapshot.Models.includes(request.ModelId))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, DevCypherQuery.ModelNotFoundMessage)
        }
        const devScope = await (await this.scopes()).ScopeFor(context)
        const scope = request.ModelId === undefined ? devScope.Scope : this.ModelScope(devScope.Scope, request.ModelId, snapshot.Description)
        const page = PageRequest.Resolve(request.Page.Params, DevCypherQuery.Fingerprint(request, before, devScope), request.Page.Limits, request.Page.RowCap)
        let mapped: CypherQueryPageDto
        let reader: GraphReader | undefined
        try
        {
            // one reader under the query's scope per attempt: it tells the mapper which members the scope hides
            reader = await engine.BeginRead(scope)
            const cypher = new Cypher.CypherEngine(engine, { MaxVarLength: request.MaxVarLength })
            const result = await cypher.Execute(scope, request.Source, { Parameters: request.Parameters, Limits: { Skip: page.Offset, RowCap: page.Size, Cancel: Cypher.Deadline.After(request.TimeoutMs) } })
            mapped = CypherResultMapper.ToWire(snapshot.CellMapper.MapResult(Cypher.CypherEngine.ToDto(result), reader), page.NextCursor(result.HasMore))
        }
        catch (error)
        {
            // a scope or plan made for a schema the engine left while the query ran: run it again on the new one
            if (!last && !(await DevCypherQuery.Settled(engine, before))) return Attempt.Moved
            throw DevCypherQuery.WireError(error)
        }
        finally
        {
            reader?.dispose()
        }
        if (!(await DevCypherQuery.Settled(engine, before)))
        {
            if (!last) return Attempt.Moved
            // never settled: a continuation cannot be served from a state its cursor was not minted for
            if (DevCypherQuery.Continues(request.Page.Params)) throw new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
        }
        return Attempt.Done(mapped)
    }

    /** The caller's scope AND the model's own instances (cached per scope object, which is per schema version). */
    private ModelScope(scope: AccessScope, modelId: string, description: ISchemaDescription): AccessScope
    {
        let byModel = this.modelScopes.get(scope)
        if (byModel === undefined)
        {
            byModel = new Map<string, AccessScope>()
            this.modelScopes.set(scope, byModel)
        }
        let scoped = byModel.get(modelId)
        if (scoped === undefined)
        {
            const rows = new Map([[TodlNames.Element, new Or([new ConceptIs(TodlNames.Term), new OwnerIs(new Set([modelId]))])]])
            scoped = AccessScopeConjunction.And(scope, AccessScope.Build({ Default: AccessDefault.Allow, Rows: rows }), this.CatalogOf(description))
            byModel.set(modelId, scoped)
        }
        return scoped
    }

    private CatalogOf(description: ISchemaDescription): EngineSchemaCatalog
    {
        if (this.catalog === undefined || this.catalog.Description !== description)
        {
            this.catalog = { Description: description, Catalog: new EngineSchemaCatalog(description) }
        }
        return this.catalog.Catalog
    }

    private static Fingerprint(request: IDevCypherRequest, state: EngineState, scope: IDevScope): string
    {
        const parts = [DevCypherQuery.FingerprintTag, request.Source, request.CanonicalParameters, state.Version, String(state.Commit), scope.Digest]
        if (request.ModelId !== undefined) parts.push(DevCypherQuery.ModelScopeTag, request.ModelId)
        return PageFingerprint.Of(...parts)
    }

    /** True when the engine is still at `before` (no upgrade and no commit since). */
    private static async Settled(engine: GraphEngine, before: EngineState): Promise<boolean>
    {
        return (await EngineState.Of(engine)).Equals(before)
    }

    private static Continues(params: PageParams): boolean
    {
        return params?.cursor !== undefined && params.cursor !== null
    }

    private static WireError(error: unknown): unknown
    {
        if (!(error instanceof Cypher.CypherError)) return error
        switch (error.Code)
        {
            case Cypher.CypherErrorCode.Syntax:
            case Cypher.CypherErrorCode.Semantic:
            case Cypher.CypherErrorCode.IntegerOverflow:
                return new ResponseError(ErrorCodes.InvalidParams, `${InvalidParamsPrefix.Text}${error.message}`)
            case Cypher.CypherErrorCode.Timeout:
                return new ResponseError(DevCypherQuery.TimeoutCode, DevCypherQuery.TimeoutMessage)
            default:
                return error
        }
    }

    private static Yield(): Promise<void>
    {
        return new Promise<void>(resolve => setImmediate(resolve))
    }
}
