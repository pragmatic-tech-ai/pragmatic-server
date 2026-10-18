import type { ConnectorBinding, ConnectorSpec, ModelConnectorPlan } from '@pragmatic-tech-ai/todl'

/** Shared binding-to-spec resolution for the raw-record connector paths. */
export class ConnectorBindingResolver
{
    /** Links by the qualified ConnectorId when present, else the bare Connector name (same rule as the engine's ConnectorLookup). */
    public static SpecOf(plan: ModelConnectorPlan, binding: ConnectorBinding): ConnectorSpec | undefined
    {
        const key = binding.ConnectorId ?? binding.Connector
        return plan.Connectors.find(c => (c.Id ?? c.Name) === key)
    }
}
