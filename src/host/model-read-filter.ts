import { Action } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { IdentityEnforcement } from '@pragmatic-tech-ai/todl-identity-engine'
import type { Repository, IInstanceFilter, Node } from '@pragmatic-tech-ai/todl'
import type { IFieldReadMask } from './cypher/field-masked-graph-query.js'
import { FieldReadMaskGate } from './model-member-builder.js'
import { ModelProjection } from './model-projection.js'
import type { IModelNodeGate, ModelMemberPage } from './model-projection.js'

/** Keeps untyped nodes and every instance the TODL read policies keep. */
class PolicyNodeGate implements IModelNodeGate
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
        const concept = node.type
        return this.filter.Keep({ Concept: concept, Field: name => node.attrs.get(name) })
    }
}

/**
 * The runtime (non-dev) in-memory read gate over a model Repository: the TODL read policies decide visibility and the
 * field-read mask decides attrs and edges (ModelProjection). The dev tenant's model/view uses DevModelView instead.
 */
export class ModelReadFilter
{
    private readonly projection: ModelProjection

    public constructor(model: Repository, context: AccessContext, mask: IFieldReadMask)
    {
        const filter = IdentityEnforcement.ForRepository(model, context, Action.Read).InstanceFilter()
        this.projection = new ModelProjection(model, new PolicyNodeGate(filter), new FieldReadMaskGate(mask))
    }

    public Page(provenance: ReadonlyMap<string, string>, offset: number, size: number): ModelMemberPage
    {
        return this.projection.Page(provenance, offset, size)
    }

    public Hidden(nodeId: string): boolean
    {
        return this.projection.Hidden(nodeId)
    }
}
