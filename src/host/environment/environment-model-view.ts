import { AccessScope, Cypher } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, GraphReader } from '@pragmatic-tech-ai/graph'
import { EdgeKind, Tier } from '@pragmatic-tech-ai/todl'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { CursorStaleError, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ModelEdgeDto, ModelMemberDto, ModelViewPageDto, ResolvedResourceDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { PageFingerprint, PageRequest } from '../paging/page-request.js'
import type { WireScalarValue } from '../wire-scalar.js'
import type { IGraphScopeSource } from '../engine/access-scope-source.js'
import { ConnectorEntity } from '../engine/connector-entity.js'
import { CypherKeysetPage } from '../engine/cypher-keyset-page.js'
import { EngineCypherQuery, EngineCypherQueryError, EngineCypherQueryErrorCode } from '../engine/engine-cypher-query.js'
import type { IGraphEngineHost } from '../engine/graph-engine-host.js'
import type { IGraphModelView, IModelViewPage } from '../engine/graph-model-view.js'
import { ModelScopes } from '../engine/model-scopes.js'

/**
 * One engine node as a runtime `model/view` member (ruling S15): `{ id: public id, kind: concept, localId: the text
 * after the id's last '#' (an external id) or else its last '.', namespace: the concept's text before its last '.',
 * tier: Instance, isClass: false, attrs: the node's set properties as the reader's scope shows them (a hidden member is
 * absent; an unset one is left out), edges: one Relationship edge per link the scope shows (the engine drops links over
 * a hidden member and links to an invisible node) }`.
 */
class EnvironmentModelMember
{
    private static readonly ExternalSeparator = '#'
    private static readonly NameSeparator = '.'
    private static readonly NoNamespace = ''
    private static readonly InstanceTier = Tier[Tier.Instance]
    private static readonly RelationshipKind = EdgeKind[EdgeKind.Relationship]

    private constructor()
    {
    }

    public static Of(node: Cypher.CypherNode): ModelMemberDto
    {
        return {
            id: node.PublicId,
            kind: node.Concept,
            localId: EnvironmentModelMember.LocalId(node.PublicId),
            namespace: EnvironmentModelMember.Namespace(node.Concept),
            tier: EnvironmentModelMember.InstanceTier,
            isClass: false,
            attrs: EnvironmentModelMember.Attrs(node),
            edges: (node.Links ?? []).map((link): ModelEdgeDto => ({ kind: EnvironmentModelMember.RelationshipKind, via: link.Relationship, to: link.PublicId })),
        }
    }

    private static Attrs(node: Cypher.CypherNode): Record<string, WireScalarValue>
    {
        const attrs: Record<string, WireScalarValue> = {}
        for (const [member, value] of node.Properties)
        {
            if (value !== null) attrs[member] = ConnectorEntity.Scalar(value)
        }
        return attrs
    }

    private static LocalId(id: string): string
    {
        const external = id.lastIndexOf(EnvironmentModelMember.ExternalSeparator)
        return id.slice((external >= 0 ? external : id.lastIndexOf(EnvironmentModelMember.NameSeparator)) + 1)
    }

    private static Namespace(concept: string): string
    {
        const dot = concept.lastIndexOf(EnvironmentModelMember.NameSeparator)
        return dot < 0 ? EnvironmentModelMember.NoNamespace : concept.slice(0, dot)
    }
}

/**
 * The runtime `model/view` and `model/resources` (ruling S15; PragmaticServer.EnvironmentModelView()), projected from
 * the environment engine: the runtime compiles nothing, so there is no language-service structure and no source
 * resource.
 *
 * - `Page`: `memberId` must be one of the snapshot's `Models` (a delivered package id, never `todl.system`), else
 *   InvalidRequest "unknown solution member"; a non-positive page size is InvalidParams. Items = the nodes
 *   ``MATCH (n:`todl.Element`) RETURN n`` returns under the caller's scope AND the S12 model filter
 *   ({@link ModelScopes}), keyset-paged ({@link CypherKeysetPage}, S11), each mapped by {@link EnvironmentModelMember};
 *   `provenanceOf` is `{}`.
 *   Cursor fingerprint: `modelView`, the member id, the engine schema version and the scope digest (a commit between
 *   pages neither repeats nor skips a member; an upgrade or another principal stales the cursor). A page that saw the
 *   engine upgrade is read again (`MaxAttempts`); one that never settles is CursorStale for a continuation, else
 *   EngineCypherQueryError Unsettled. The scope alone decides what is visible; nothing is filtered or masked here.
 * - `Hidden`: the engine holds `nodeId` (a System read) and the caller's scope does not show it.
 * - `Resources`: always `[]` (the runtime holds no source resources).
 */
export class EnvironmentModelView implements IGraphModelView
{
    public static readonly MaxAttempts = EngineCypherQuery.MaxAttempts
    public static readonly UnknownMemberError = 'unknown solution member'
    private static readonly FingerprintTag = 'modelView'
    private static readonly Source = `MATCH (n:\`${TodlNames.Element}\`) RETURN n`

    private readonly modelScopes = new ModelScopes()

    public constructor(private readonly host: IGraphEngineHost, private readonly scopes: () => Promise<IGraphScopeSource>)
    {
    }

    public async Page(context: AccessContext, memberId: string | undefined, page: IModelViewPage): Promise<ModelViewPageDto>
    {
        PageRequest.ValidatePageSize(page.Params)
        for (let attempt = 1; attempt <= EnvironmentModelView.MaxAttempts; attempt++)
        {
            const last = attempt === EnvironmentModelView.MaxAttempts
            const engine = await this.host.Engine()
            const before = engine.SchemaVersion
            const snapshot = await this.host.Snapshot()
            if (snapshot.Description.Version !== before)
            {
                // an upgrade is being applied: its snapshot is installed once the engine has upgraded
                await EnvironmentModelView.Yield()
                continue
            }
            if (memberId === undefined || !snapshot.Models.includes(memberId))
            {
                throw new ResponseError(ErrorCodes.InvalidRequest, EnvironmentModelView.UnknownMemberError)
            }
            const graphScope = await (await this.scopes()).ScopeFor(context)
            const scope = this.modelScopes.For(graphScope.Scope, memberId, snapshot.Description)
            const fingerprint = PageFingerprint.Of(EnvironmentModelView.FingerprintTag, memberId, before, graphScope.Digest)
            const keyset = CypherKeysetPage.Resolve(page.Params, fingerprint, page.Limits)
            let result: Cypher.CypherResult
            try
            {
                result = await new Cypher.CypherEngine(engine).Execute(scope, EnvironmentModelView.Source, { Limits: keyset.Limits() })
            }
            catch (error)
            {
                if (!last && engine.SchemaVersion !== before) continue
                throw EngineCypherQuery.WireError(error)
            }
            if (engine.SchemaVersion !== before && !last) continue
            const items = result.Rows.map(row => EnvironmentModelMember.Of((row[0] as Cypher.NodeValue).Node))
            const nextCursor = keyset.NextCursor(result)
            return nextCursor === undefined ? { items, provenanceOf: {} } : { items, provenanceOf: {}, nextCursor }
        }
        if (page.Params?.cursor !== undefined && page.Params.cursor !== null) throw new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
        throw new EngineCypherQueryError(EngineCypherQueryErrorCode.Unsettled)
    }

    public async Hidden(context: AccessContext, nodeId: string): Promise<boolean>
    {
        const engine = await this.host.Engine()
        if (await EnvironmentModelView.ConceptOf(engine, AccessScope.System, nodeId) === undefined) return false
        const scope = (await (await this.scopes()).ScopeFor(context)).Scope
        return await EnvironmentModelView.ConceptOf(engine, scope, nodeId) === undefined
    }

    public async Resources(_context: AccessContext, _nodeId: string): Promise<ResolvedResourceDto[]>
    {
        return []
    }

    private static async ConceptOf(engine: GraphEngine, scope: AccessScope, nodeId: string): Promise<string | undefined>
    {
        const reader: GraphReader = await engine.BeginRead(scope)
        try
        {
            return await reader.ConceptOf(nodeId)
        }
        finally
        {
            reader.dispose()
        }
    }

    private static Yield(): Promise<void>
    {
        return new Promise<void>(resolve => setImmediate(resolve))
    }
}
