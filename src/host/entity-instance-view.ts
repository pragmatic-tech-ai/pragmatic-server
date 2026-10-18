import type { IInstanceView, ReflectedEntity, Scalar } from '@pragmatic-tech-ai/todl'

/** Adapts a materialized ReflectedEntity to an IInstanceView so the shared row filter can judge it. Members resolve
 *  against the entity's own scalar snapshot; a member with no value is undefined (a rule on it fails closed). */
export class EntityInstanceView implements IInstanceView
{
    private readonly entity: ReflectedEntity
    private snapshot: Record<string, Scalar> | undefined

    public constructor(entity: ReflectedEntity)
    {
        this.entity = entity
    }

    public get Concept(): string
    {
        return this.entity.concept
    }

    public Field(name: string): Scalar | undefined
    {
        this.snapshot ??= this.entity.Snapshot()
        return Object.hasOwn(this.snapshot, name) ? this.snapshot[name] : undefined
    }
}
