import type { Repository } from '@pragmatic-tech-ai/todl'
import type { IFieldReadMask } from './cypher/field-masked-graph-query.js'
import { FieldReadMaskGate } from './model-member-builder.js'
import { ModelProjection } from './model-projection.js'
import type { IModelNodeGate, ModelMemberPage } from './model-projection.js'

/** Keeps every model node: the runtime model/view has no per-instance visibility input. */
class KeepAllNodeGate implements IModelNodeGate
{
    public static readonly Instance = new KeepAllNodeGate()

    public Keeps(): boolean
    {
        return true
    }
}

/**
 * The runtime (non-dev) in-memory read gate over a model Repository: every node is kept and the field-read mask decides
 * attrs and edges (ModelProjection). The dev tenant's model/view uses DevModelView instead.
 */
export class ModelReadFilter
{
    private readonly projection: ModelProjection

    public constructor(model: Repository, mask: IFieldReadMask)
    {
        this.projection = new ModelProjection(model, KeepAllNodeGate.Instance, new FieldReadMaskGate(mask))
    }

    public Page(provenance: ReadonlyMap<string, string>, offset: number, size: number): ModelMemberPage
    {
        return this.projection.Page(provenance, offset, size)
    }
}
