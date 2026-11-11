import type { Repository, Node } from '@pragmatic-tech-ai/todl'
import type { ModelMemberDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ModelMemberBuilder } from './model-member-builder.js'
import type { IMemberReadGate } from './model-member-builder.js'

/** One window of the visible member set, ordered by id. */
export interface ModelMemberPage
{
    Items: ModelMemberDto[]
    HasMore: boolean
    ProvenanceOf: Record<string, string>
}

/** Which model nodes a reader sees at all (the projection's only visibility input). */
export interface IModelNodeGate
{
    Keeps(node: Node): boolean
}

/**
 * The ONLY builder of ModelMemberDto pages: drops the nodes its node gate hides BEFORE paging (so pages count only
 * visible members), masks attrs by its member gate, drops edges whose target is hidden or whose via field is hidden or
 * masked (ModelMemberBuilder), and strips non-page ids from provenance. It decides nothing itself: the dev model view
 * gates and masks with the caller's engine scope (DevModelView); the runtime model view has no structure to project
 * (EnvironmentModelView maps engine nodes itself).
 */
export class ModelProjection
{
    public constructor(private readonly model: Repository, private readonly nodes: IModelNodeGate, private readonly members: IMemberReadGate)
    {
    }

    public Page(provenance: ReadonlyMap<string, string>, offset: number, size: number): ModelMemberPage
    {
        const visible: Node[] = []
        const visibleIds = new Set<string>()
        for (const node of this.model.allNodes())
        {
            if (this.nodes.Keeps(node))
            {
                visible.push(node)
                visibleIds.add(node.id)
            }
        }
        visible.sort(ModelProjection.ByOrdinalId)
        const window = visible.slice(offset, offset + size + 1)
        const hasMore = window.length > size
        const builder = new ModelMemberBuilder(this.model, this.members, visibleIds)
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

    /** True when the model holds `nodeId` and the node gate hides it (false for an id the model cannot resolve). */
    public Hidden(nodeId: string): boolean
    {
        const node = this.model.resolve(nodeId)
        if (node === undefined)
        {
            return false
        }
        return !this.nodes.Keeps(node)
    }

    private static ByOrdinalId(a: Node, b: Node): number
    {
        if (a.id < b.id)
        {
            return -1
        }
        return a.id > b.id ? 1 : 0
    }
}
