import { toJSON, ModelShardExtractor, ConnectorPlanEmitter } from '@pragmatic-tech-ai/todl'
import type { Repository, TodlDocument, ModelConnectorPlan } from '@pragmatic-tech-ai/todl'

/** One connector-bearing model from an opened solution: its id, the plan reconstructed from the compiled
 *  graph, and the model's own base shard (own instances + shared ontology). Carries names/ids only. */
export interface ConnectorModel
{
    readonly ModelId: string
    readonly Plan: ModelConnectorPlan
    readonly Base: TodlDocument
}

/** Turns the whole-solution Repository into the set of models that declare connectors, each paired with its
 *  reconstructed plan and its own base shard. Models without connectors are omitted (PlanFor returns undefined). */
export class SolutionConnectorPlanner
{
    public static Plan(repo: Repository): readonly ConnectorModel[]
    {
        const full = toJSON(repo)
        const models: ConnectorModel[] = []
        for (const modelId of ModelShardExtractor.ModelsOf(full))
        {
            const plan = ConnectorPlanEmitter.PlanFor(repo, modelId)
            if (plan === undefined)
            {
                continue
            }
            models.push({ ModelId: modelId, Plan: plan, Base: ModelShardExtractor.Extract(full, modelId) })
        }
        return models
    }
}
