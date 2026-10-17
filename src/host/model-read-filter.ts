import { Action } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { IdentityEnforcement } from '@pragmatic-tech-ai/todl-identity-engine'
import type { Repository, IInstanceFilter, Node } from '@pragmatic-tech-ai/todl'
import type { ModelMemberDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IFieldReadMask } from './cypher/field-masked-graph-query.js'
import { ModelMemberBuilder } from './model-member-builder.js'

/** One window of the visible member set, ordered by id. */
export interface ModelMemberPage
{
    Items: ModelMemberDto[]
    HasMore: boolean
    ProvenanceOf: Record<string, string>
}

/**
 * Authoritative in-memory read gate over a model Repository and the ONLY builder of ModelMemberDto: drops instances a
 * policy rule hides BEFORE paging (so pages count only visible members), masks attrs by the field-read mask, drops edges
 * whose target is hidden or whose via field is hidden or masked, and strips non-page ids from provenance.
 */
export class ModelReadFilter
{
    private readonly model: Repository
    private readonly filter: IInstanceFilter
    private readonly mask: IFieldReadMask

    public constructor(model: Repository, context: AccessContext, mask: IFieldReadMask)
    {
        this.model = model
        this.filter = IdentityEnforcement.ForRepository(model, context, Action.Read).InstanceFilter()
        this.mask = mask
    }

    public Page(provenance: ReadonlyMap<string, string>, offset: number, size: number): ModelMemberPage
    {
        const visible: Node[] = []
        const visibleIds = new Set<string>()
        for (const node of this.model.allNodes())
        {
            if (this.keep(node))
            {
                visible.push(node)
                visibleIds.add(node.id)
            }
        }
        visible.sort(ModelReadFilter.ByOrdinalId)
        const window = visible.slice(offset, offset + size + 1)
        const hasMore = window.length > size
        const builder = new ModelMemberBuilder(this.model, this.mask, visibleIds)
        const items = window.slice(0, size).map(node => builder.Build(node))
        const provenanceOf: Record<string, string> = {}
        for (const item of items)
        {
            const source = provenance.get(item.id)
            if (source !== undefined)
            {
                provenanceOf[item.id] = source
            }
        }
        return { Items: items, HasMore: hasMore, ProvenanceOf: provenanceOf }
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

    private static ByOrdinalId(a: Node, b: Node): number
    {
        if (a.id < b.id)
        {
            return -1
        }
        return a.id > b.id ? 1 : 0
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
