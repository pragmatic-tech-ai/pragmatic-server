import { Cypher } from '@pragmatic-tech-ai/graph'
import { EdgeKind, Tier } from '@pragmatic-tech-ai/todl'
import { SystemNames, TodlNames } from '@pragmatic-tech-ai/todl/engine'
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
 *   InvalidRequest "unknown solution member" (checked before the page size, as dev); a non-positive page size is
 *   InvalidParams. Items = the nodes ``MATCH (n:`todl.Element`) RETURN n`` returns under the caller's scope AND the
 *   owner-only model filter (`ModelScopes.ForOwner`, ruling R53: the package's own nodes, so another package's taxonomy
 *   terms are not listed; R58: plus the caller's share grants, so shared records stay visible), except the
 *   `todl.system.ShareGrant` nodes (not package members; the engine parser has no label predicate, so they are left out
 *   of the mapped rows by exact concept; a page may then hold fewer items than its size), keyset-paged ({@link CypherKeysetPage}, S11), each mapped by {@link EnvironmentModelMember};
 *   `provenanceOf` is `{}`. Cursor fingerprint: `modelView`, the member id, the engine schema version and the scope
 *   digest (a commit between pages neither repeats nor skips a member; an upgrade or another principal stales the
 *   cursor). A page that saw the engine upgrade is read again (`MaxAttempts`); one that never settles is CursorStale for
 *   a continuation, else EngineCypherQueryError Unsettled. The scope alone decides what is visible; nothing is masked
 *   here, and the grant exclusion is structural, never an access decision.
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
            PageRequest.ValidatePageSize(page.Params)
            const graphScope = await (await this.scopes()).ScopeFor(context)
            const scope = this.modelScopes.ForOwner(graphScope.Scope, memberId, snapshot.Description)
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
            // R58: the owner filter admits the caller's share grants (so widening works); they are not package members
            const items = result.Rows.map(row => (row[0] as Cypher.NodeValue).Node).filter(node => node.Concept !== SystemNames.ShareGrant).map(node => EnvironmentModelMember.Of(node))
            const nextCursor = keyset.NextCursor(result)
            return nextCursor === undefined ? { items, provenanceOf: {} } : { items, provenanceOf: {}, nextCursor }
        }
        if (page.Params?.cursor !== undefined && page.Params.cursor !== null) throw new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
        throw new EngineCypherQueryError(EngineCypherQueryErrorCode.Unsettled)
    }

    public async Resources(_context: AccessContext, _nodeId: string): Promise<ResolvedResourceDto[]>
    {
        return []
    }

    private static Yield(): Promise<void>
    {
        return new Promise<void>(resolve => setImmediate(resolve))
    }
}
