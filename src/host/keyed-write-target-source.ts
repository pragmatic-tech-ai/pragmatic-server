import { QueryCompareOp } from '@pragmatic-tech-ai/todl'
import type { ConnectorBinding, ConnectorSpec, IDataSourceAdapter, IInstanceView, ModelConnectorPlan, Scalar } from '@pragmatic-tech-ai/todl'
import type { IWriteTargetSource } from './write-target-source.js'

/** Opens the adapter of ONE connector spec (satisfied by ConnectorRuntime). */
export interface IAdapterOpener
{
    OpenAdapter(spec: ConnectorSpec): Promise<IDataSourceAdapter>
}

/** Reconstructs a write target with a SINGLE keyed read (Query WHERE idKey = key); it never prefetches a concept.
 *  Absent, ambiguous (more than one row) or unbound => undefined (fail closed). */
export class KeyedWriteTargetSource implements IWriteTargetSource
{
    private readonly plan: ModelConnectorPlan
    private readonly opener: IAdapterOpener

    public constructor(plan: ModelConnectorPlan, opener: IAdapterOpener)
    {
        this.plan = plan
        this.opener = opener
    }

    public async Fetch(concept: string, id: string): Promise<IInstanceView | undefined>
    {
        const bindings = this.plan.Bindings.filter(b => b.Concept === concept)
        if (bindings.length !== 1)
        {
            return undefined
        }
        const binding = bindings[0]!
        const spec = KeyedWriteTargetSource.SpecOf(this.plan, binding)
        if (spec === undefined)
        {
            return undefined
        }
        const adapter = await this.opener.OpenAdapter(spec)
        const fields = [...new Set([binding.IdKey, ...Object.values(binding.FieldMap)])]
        const rows = await adapter.Query({ Source: binding.Source, Fields: fields, Where: { All: [{ Field: binding.IdKey, Op: QueryCompareOp.Eq, Value: id }] } })
        if (rows.length !== 1)
        {
            return undefined
        }
        const row = rows[0]!
        return { Concept: concept, Field: name => (row[binding.FieldMap[name] ?? name] ?? undefined) as Scalar | undefined }
    }

    /** Links by the qualified ConnectorId when present, else the bare Connector name (same rule as the engine's ConnectorLookup). */
    public static SpecOf(plan: ModelConnectorPlan, binding: ConnectorBinding): ConnectorSpec | undefined
    {
        const key = binding.ConnectorId ?? binding.Connector
        return plan.Connectors.find(c => (c.Id ?? c.Name) === key)
    }
}
