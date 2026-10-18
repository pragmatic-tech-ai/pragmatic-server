import type { ReflectedEntity } from '@pragmatic-tech-ai/todl'
import type { EntityDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { WireScalar } from './wire-scalar.js'
import type { IFieldReadMask } from './cypher/field-masked-graph-query.js'

/** The minimal node shape projected (structurally satisfied by the engine's ReflectedNode). */
export interface EntityNodeShape
{
    readonly id: string
    readonly type: string
    readonly attrs: Record<string, unknown>
}

/** The one projection of a connector entity onto the wire EntityDto: id, concept, and scalar field values only. */
export class EntityDtoMapper
{
    public static FromEntity(entity: ReflectedEntity, mask?: IFieldReadMask): EntityDto
    {
        const fields = WireScalar.Record(entity.Snapshot())
        if (mask === undefined)
        {
            return { id: entity.id, concept: entity.concept, fields }
        }
        const visible: typeof fields = {}
        for (const name of Object.keys(fields))
        {
            if (mask.CanRead(entity.concept, name))
            {
                visible[name] = fields[name]!
            }
        }
        return { id: entity.id, concept: entity.concept, fields: visible }
    }

    public static FromNode(node: EntityNodeShape, mask?: IFieldReadMask): EntityDto
    {
        const fields = WireScalar.Record(node.attrs)
        if (mask === undefined)
        {
            return { id: node.id, concept: node.type, fields }
        }
        const visible: typeof fields = {}
        for (const name of Object.keys(fields))
        {
            if (mask.CanRead(node.type, name))
            {
                visible[name] = fields[name]!
            }
        }
        return { id: node.id, concept: node.type, fields: visible }
    }
}
