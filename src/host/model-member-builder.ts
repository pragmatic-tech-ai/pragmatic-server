import { EdgeKind, Tier } from '@pragmatic-tech-ai/todl'
import type { Repository, Node, Edge } from '@pragmatic-tech-ai/todl'
import type { ModelEdgeDto, ModelMemberDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IFieldReadMask } from './cypher/field-masked-graph-query.js'
import { WireScalar } from './wire-scalar.js'
import type { WireScalarValue } from './wire-scalar.js'

/** Which of a visible node's fields (attrs and edge-carrying members) the reader may read. */
export interface IMemberReadGate
{
    CanRead(node: Node, field: string): boolean
}

/**
 * The field-read mask as a member gate: untyped nodes are ontology definitions / model containers (never
 * secured instances), so field security does not apply to them; every typed node asks the mask for its type.
 */
export class FieldReadMaskGate implements IMemberReadGate
{
    public constructor(private readonly mask: IFieldReadMask)
    {
    }

    public CanRead(node: Node, field: string): boolean
    {
        return node.type === null || this.mask.CanRead(node.type, field)
    }
}

/**
 * Maps a visible model Node plus its out-edges to a ModelMemberDto under a member gate (a field-read mask, or the dev
 * engine scope's hidden members). Used ONLY by ModelProjection, which owns visibility: it hands over the set of visible
 * node ids, so the builder never decides which nodes are hidden, only which of a visible node's attrs and edges survive.
 */
export class ModelMemberBuilder
{
    private static readonly Absent = ''

    private readonly model: Repository
    private readonly gate: IMemberReadGate
    private readonly visible: ReadonlySet<string>

    public constructor(model: Repository, gate: IMemberReadGate, visible: ReadonlySet<string>)
    {
        this.model = model
        this.gate = gate
        this.visible = visible
    }

    public Build(node: Node): ModelMemberDto
    {
        return {
            id: node.id,
            kind: node.metaKind ?? node.type,
            localId: node.localId ?? ModelMemberBuilder.Absent,
            namespace: node.namespace ?? ModelMemberBuilder.Absent,
            tier: Tier[node.tier],
            isClass: node.isClass,
            attrs: this.Attrs(node),
            edges: this.Edges(node),
        }
    }

    private Attrs(node: Node): Record<string, WireScalarValue>
    {
        const attrs: Record<string, WireScalarValue> = {}
        for (const [name, value] of node.attrs)
        {
            if (this.gate.CanRead(node, name))
            {
                attrs[name] = WireScalar.Of(value)
            }
        }
        return attrs
    }

    private Edges(node: Node): ModelEdgeDto[]
    {
        const edges: ModelEdgeDto[] = []
        for (const edge of this.model.outEdges(node.id))
        {
            if (this.Keeps(node, edge))
            {
                edges.push({ kind: EdgeKind[edge.kind], via: edge.via, to: edge.to })
            }
        }
        return edges
    }

    /** An edge survives when its target is visible and, for a field-carried edge, the via field is visible and readable. */
    private Keeps(node: Node, edge: Edge): boolean
    {
        // a target outside the visible set (hidden or unresolvable) drops the edge (fail-closed)
        if (!this.visible.has(edge.to))
        {
            return false
        }
        if (edge.via === null)
        {
            return true
        }
        // a compiled instance edge carries the bare member name as via; a via that names a node must itself be visible
        const viaNode = this.model.resolve(edge.via)
        if (viaNode !== undefined && !this.visible.has(viaNode.id))
        {
            return false
        }
        return this.gate.CanRead(node, viaNode?.localId ?? edge.via)
    }
}
