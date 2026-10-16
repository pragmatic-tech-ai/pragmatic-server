import type { ModelConnectorPlan } from '@pragmatic-tech-ai/todl'

/** Maps a concept to the record field that carries its id (the binding IdKey); defaults to 'id'. */
export class ConceptIdFields
{
    private static readonly DefaultIdField = 'id'

    private constructor(private readonly byConcept: ReadonlyMap<string, string>)
    {
    }

    public static From(plan: ModelConnectorPlan): ConceptIdFields
    {
        const map = new Map<string, string>()
        for (const binding of plan.Bindings)
        {
            map.set(binding.Concept, binding.IdKey)
        }
        return new ConceptIdFields(map)
    }

    public IdFieldFor(concept: string): string
    {
        return this.byConcept.get(concept) ?? ConceptIdFields.DefaultIdField
    }
}
