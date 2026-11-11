import type { Repository, IInstanceFilter, Node } from '@pragmatic-tech-ai/todl'
import type { IFieldReadMask } from './cypher/field-read-mask.js'
import { FieldReadMaskGate } from './model-member-builder.js'
import { ModelProjection } from './model-projection.js'
import type { IModelNodeGate, ModelMemberPage } from './model-projection.js'

/** Keeps untyped nodes (schema, models) and every instance the tenant security model's access-depth read filter keeps. */
class InstanceFilterNodeGate implements IModelNodeGate
{
    public constructor(private readonly filter: IInstanceFilter)
    {
    }

    public Keeps(node: Node): boolean
    {
        if (node.type === null)
        {
            return true
        }
        return this.filter.Keep({ Concept: node.type, Field: name => node.attrs.get(name) })
    }
}

/**
 * The runtime (non-dev) in-memory read gate over a model Repository: the tenant security model's access-depth read filter
 * (`IReadFilterSource.ReadFilterFor`, allow-all without identity) decides which instances are visible and the field-read
 * mask decides attrs and edges (ModelProjection). The dev tenant's model/view uses DevModelView instead.
 */
export class ModelReadFilter
{
    private readonly projection: ModelProjection

    public constructor(model: Repository, filter: IInstanceFilter, mask: IFieldReadMask)
    {
        this.projection = new ModelProjection(model, new InstanceFilterNodeGate(filter), new FieldReadMaskGate(mask))
    }

    public Page(provenance: ReadonlyMap<string, string>, offset: number, size: number): ModelMemberPage
    {
        return this.projection.Page(provenance, offset, size)
    }

    /** True when the model holds `nodeId` and the read filter hides it. */
    public Hidden(nodeId: string): boolean
    {
        return this.projection.Hidden(nodeId)
    }
}
