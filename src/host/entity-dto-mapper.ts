import type { ReflectedEntity } from '@pragmatic-tech-ai/todl'
import type { EntityDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { WireScalar } from './wire-scalar.js'

/** The one projection of a connector entity onto the wire EntityDto: id, concept, and scalar field values only. */
/** The minimal node shape projected (structurally satisfied by the engine's ReflectedNode). */
export interface EntityNodeShape
{
    readonly id: string
    readonly type: string
    readonly attrs: Record<string, unknown>
}

export class EntityDtoMapper
{
    public static FromEntity(entity: ReflectedEntity): EntityDto
    {
        return { id: entity.id, concept: entity.concept, fields: WireScalar.Record(entity.Snapshot()) }
    }

    public static FromNode(node: EntityNodeShape): EntityDto
    {
        return { id: node.id, concept: node.type, fields: WireScalar.Record(node.attrs) }
    }
}
