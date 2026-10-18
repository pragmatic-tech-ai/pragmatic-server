import type { Cypher, IInstanceView, Scalar } from '@pragmatic-tech-ai/todl'

/** Builds the policy-facing IInstanceView from a reflected graph mirror (one home for concept + field resolution). */
export class ReflectedView
{
    public static Of(mirror: NonNullable<ReturnType<Cypher.ICypherGraph['Reflect']>>, fallbackConcept?: string): IInstanceView
    {
        return {
            Concept: mirror.type?.fullName ?? fallbackConcept ?? '',
            Field: (name: string): Scalar | undefined => mirror.field(name)?.value,
        }
    }
}
