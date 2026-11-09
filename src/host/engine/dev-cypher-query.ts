import { AccessDefault, AccessScope, Cypher, OwnerIs } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, ISchemaDescription } from '@pragmatic-tech-ai/graph'
import { CursorStaleError, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherParamValue, CypherQueryPageDto, PageParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { PagingLimits } from '../../config/paging-limits.js'
import { CypherParamConverter, CypherParamError } from '../cypher/cypher-param-converter.js'
import { CypherResultMapper } from '../cypher/cypher-result-mapper.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import { PageFingerprint, PageRequest } from '../paging/page-request.js'
import { AccessScopeConjunction } from './access-scope-conjunction.js'
import { DevAccessScopeError, DevAccessScopeErrorCode } from './dev-access-scope-source.js'
import type { IDevScope, IDevScopeSource } from './dev-access-scope-source.js'
import type { IDevGraphEngine } from './dev-graph-engine-host.js'
import type { DevSnapshot } from './dev-snapshot-source.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'

/** The page a dev query asks for: the wire paging params, the connection's paging limits and the row cap. */
export interface IDevCypherPage
{
    readonly Params: PageParams
    readonly Limits: PagingLimits
    readonly RowCap: number
}

/** One dev `cypher/query` request (the wire parameters, already validated by the handler). */
export interface IDevCypherRequest
{
    readonly Source: string
    readonly Parameters: { [name: string]: CypherParamValue } | undefined
    /** A model id of the active solution; the query then sees only that model's instances. */
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

/** What is derived once per engine description: the model ids and the schema catalog. */
class DescriptionFacts
{
    public readonly Catalog: EngineSchemaCatalog
    public readonly Models: readonly string[]

    public constructor(public readonly Description: ISchemaDescription, solutionName: string | undefined)
    {
        this.Catalog = new EngineSchemaCatalog(Description)
        const owners = new Set<string>()
        for (const node of Description.Seed)
        {
            // the solution package owns what lies outside every model (and the taxonomy terms): it is no model
            if (node.Owner !== solutionName) owners.add(node.Owner)
        }
        this.Models = [...owners].sort()
    }
}

/**
 * Runs the dev tenant's read-only Cypher on its embedded graph engine, under the caller's {@link IDevScope}: the scope
 * alone decides what the query sees (rows, hidden members); this class never filters or masks a result itself.
 *
 * - `ModelId` must be one of {@link DevCypherQuery.Models} (else InvalidParams "model not found", the same error for
 *   every unknown id). It ANDs `OwnerIs(modelId)` into the `todl.Element` rows entry of the caller's scope
 *   (AccessScopeConjunction, deny-wins), so the model filter applies to every concept.
 * - The result cells are mapped to TODL's wire shape (EngineCellMapper of the snapshot the engine runs), then to the
 *   wire page (CypherResultMapper).
 * - Cursor fingerprint: `cypher`, the text, the canonical parameters, the engine schema version and commit, and for a
 *   model-scoped query `model`, the model id and the scope digest. A query that saw the engine move (an upgrade or a
 *   commit while it ran) is run again, up to {@link DevCypherQuery.MaxAttempts} times; a continuation page that never
 *   settles is reported stale rather than served from a state its cursor was not minted for.
 * - Engine Syntax / Semantic errors are InvalidParams; a timeout is {@link DevCypherQuery.TimeoutCode}.
 */
export class DevCypherQuery implements IDevCypherQuery
{
    public static readonly TimeoutCode = -32030
    public static readonly TimeoutMessage = 'cypher query timed out'
    public static readonly MaxAttempts = 5
    private static readonly FingerprintTag = 'cypher'
    private static readonly ModelScopeTag = 'model'
    private static readonly ModelNotFoundMessage = `${InvalidParamsPrefix.Text}model not found`

    private facts: DescriptionFacts | undefined
    private readonly modelScopes = new WeakMap<AccessScope, Map<string, AccessScope>>()

    public constructor(
        private readonly host: IDevGraphEngine,
        private readonly scopes: () => Promise<IDevScopeSource>,
        private readonly solutionName: () => Promise<string | undefined>)
    {
    }

    public async Models(): Promise<readonly string[]>
    {
        return (await this.Facts((await this.host.Snapshot()).Description)).Models
    }

    public async Run(context: AccessContext, request: IDevCypherRequest): Promise<CypherQueryPageDto>
    {
        const parameters = DevCypherQuery.Parameters(request)
        const canonical = CypherParamConverter.Canonical(request.Parameters)
        for (let attempt = 1; attempt <= DevCypherQuery.MaxAttempts; attempt++)
        {
            const last = attempt === DevCypherQuery.MaxAttempts
            const engine = await this.host.Engine()
            const before = await EngineState.Of(engine)
            const snapshot = await this.host.Snapshot()
            if (snapshot.Description.Version !== before.Version)
            {
                // an upgrade is being applied: its snapshot is installed once the engine has upgraded
                await DevCypherQuery.Yield()
                continue
            }
            const facts = await this.Facts(snapshot.Description)
            if (request.ModelId !== undefined && !facts.Models.includes(request.ModelId))
            {
                throw new ResponseError(ErrorCodes.InvalidParams, DevCypherQuery.ModelNotFoundMessage)
            }
            const devScope = await (await this.scopes()).ScopeFor(context)
            const scope = request.ModelId === undefined ? devScope.Scope : this.ModelScope(devScope.Scope, request.ModelId, facts)
            const page = PageRequest.Resolve(request.Page.Params, DevCypherQuery.Fingerprint(request, canonical, before, devScope), request.Page.Limits, request.Page.RowCap)
            let result: Cypher.CypherResult
            try
            {
                const cypher = new Cypher.CypherEngine(engine, { MaxVarLength: request.MaxVarLength })
                result = await cypher.Execute(scope, request.Source, { Parameters: parameters, Limits: { Skip: page.Offset, RowCap: page.Size, Cancel: Cypher.Deadline.After(request.TimeoutMs) } })
            }
            catch (error)
            {
                // a scope or plan made for a schema the engine left while the query ran: run it again on the new one
                if (!last && !(await DevCypherQuery.Settled(engine, before))) continue
                throw DevCypherQuery.WireError(error)
            }
            if (!(await DevCypherQuery.Settled(engine, before)))
            {
                if (!last) continue
                if (DevCypherQuery.Continues(request.Page.Params)) throw new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
            }
            return DevCypherQuery.Wire(snapshot, result, page)
        }
        throw new DevAccessScopeError(DevAccessScopeErrorCode.SchemaUnsettled)
    }

    private async Facts(description: ISchemaDescription): Promise<DescriptionFacts>
    {
        if (this.facts === undefined || this.facts.Description !== description)
        {
            this.facts = new DescriptionFacts(description, await this.solutionName())
        }
        return this.facts
    }

    /** The caller's scope AND the model's own instances (cached per scope object, which is per schema version). */
    private ModelScope(scope: AccessScope, modelId: string, facts: DescriptionFacts): AccessScope
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
            const model = AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[TodlNames.Element, new OwnerIs(new Set([modelId]))]]) })
            scoped = AccessScopeConjunction.And(scope, model, facts.Catalog)
            byModel.set(modelId, scoped)
        }
        return scoped
    }

    private static Parameters(request: IDevCypherRequest): ReadonlyMap<string, Cypher.ParameterValue>
    {
        try
        {
            return CypherParamConverter.ToMap(request.Parameters)
        }
        catch (error)
        {
            if (error instanceof CypherParamError) throw new ResponseError(ErrorCodes.InvalidParams, `${InvalidParamsPrefix.Text}${error.message}`)
            throw error
        }
    }

    private static Fingerprint(request: IDevCypherRequest, canonical: string, state: EngineState, scope: IDevScope): string
    {
        const parts = [DevCypherQuery.FingerprintTag, request.Source, canonical, state.Version, String(state.Commit)]
        if (request.ModelId !== undefined) parts.push(DevCypherQuery.ModelScopeTag, request.ModelId, scope.Digest)
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

    private static Wire(snapshot: DevSnapshot, result: Cypher.CypherResult, page: PageRequest): CypherQueryPageDto
    {
        return CypherResultMapper.ToWire(snapshot.CellMapper.MapResult(Cypher.CypherEngine.ToDto(result)), page.NextCursor(result.HasMore))
    }

    private static WireError(error: unknown): unknown
    {
        if (!(error instanceof Cypher.CypherError)) return error
        switch (error.Code)
        {
            case Cypher.CypherErrorCode.Syntax:
            case Cypher.CypherErrorCode.Semantic:
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
