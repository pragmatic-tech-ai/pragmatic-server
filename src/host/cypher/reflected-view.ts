import type { Cypher, IInstanceView, Scalar } from '@pragmatic-tech-ai/todl'

/** Builds the policy-facing IInstanceView from a reflected graph mirror (one home for concept + field resolution). */
export class ReflectedView
{
    /** Undefined when NO concept can be resolved (typeless mirror and no fallback) - callers must fail closed. */
    public static Of(mirror: NonNullable<ReturnType<Cypher.ICypherGraph['Reflect']>>, fallbackConcept?: string): IInstanceView | undefined
    {
        const concept = mirror.type?.fullName ?? fallbackConcept
        if (concept === undefined) return undefined
        return {
            Concept: concept,
            Field: (name: string): Scalar | undefined => mirror.field(name)?.value,
        }
    }
}
