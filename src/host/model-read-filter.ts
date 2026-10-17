import { Action } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { IdentityEnforcement } from '@pragmatic-tech-ai/todl-identity-engine'
import { Tier } from '@pragmatic-tech-ai/todl'
import type { Repository, IInstanceFilter, Node } from '@pragmatic-tech-ai/todl'
import type { ModelMemberDto, ModelViewPageDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/** Authoritative in-memory read filter over a model Repository: drops instances a policy rule hides,
 *  before DTO projection, and strips their ids from provenance. Non-policy models pass through unchanged. */
export class ModelReadFilter
{
    private static readonly Absent = ''

    private readonly model: Repository
    private readonly filter: IInstanceFilter

    public constructor(model: Repository, context: AccessContext)
    {
        this.model = model
        this.filter = IdentityEnforcement.ForRepository(model, context, Action.Read).InstanceFilter()
    }

    public Project(provenance: ReadonlyMap<string, string>): ModelViewPageDto
    {
        const members: ModelMemberDto[] = []
        const kept = new Set<string>()
        for (const node of this.model.allNodes())
        {
            if (!this.keep(node))
            {
                continue
            }
            kept.add(node.id)
            members.push(ModelReadFilter.Member(node))
        }
        const provenanceOf: Record<string, string> = {}
        for (const [id, source] of provenance)
        {
            if (kept.has(id))
            {
                provenanceOf[id] = source
            }
        }
        return { items: members, provenanceOf }
    }

    public Hidden(nodeId: string): boolean
    {
        const node = this.model.resolve(nodeId)
        if (node === undefined)
        {
            return false
        }
        return !this.keep(node)
    }

    private static Member(node: Node): ModelMemberDto
    {
        return {
            id: node.id,
            kind: node.metaKind ?? node.type,
            localId: node.localId ?? ModelReadFilter.Absent,
            namespace: node.namespace ?? ModelReadFilter.Absent,
            tier: Tier[node.tier],
            isClass: node.isClass,
            attrs: {},
            edges: [],
        }
    }

    private keep(node: Node): boolean
    {
        if (node.type === null)
        {
            return true
        }
        const concept = node.type
        return this.filter.Keep({ Concept: concept, Field: name => node.attrs.get(name) })
    }
}
