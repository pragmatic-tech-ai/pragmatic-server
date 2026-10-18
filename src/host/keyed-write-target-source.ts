import { QueryCompareOp } from '@pragmatic-tech-ai/todl'
import type { ConnectorSpec, IDataSourceAdapter, IInstanceView, ModelConnectorPlan } from '@pragmatic-tech-ai/todl'
import { ConnectorBindingResolver } from '../connectors/connector-binding-resolver.js'
import { ConnectorInstanceView } from './connector-instance-view.js'
import type { IWriteTargetSource } from './write-target-source.js'

/** Opens the adapter of ONE connector spec (satisfied by ConnectorRuntime). */
export interface IAdapterOpener
{
    OpenAdapter(spec: ConnectorSpec): Promise<IDataSourceAdapter>
}

/** Reconstructs a write target with a SINGLE keyed read (Query WHERE idKey = key); it never prefetches a concept.
 *  Single-binding only: a concept with other than exactly one binding yields undefined (multi-binding keyed writes are
 *  deferred, same scope boundary as readPage). Absent, ambiguous (more than one row) or unbound => undefined (fail closed). */
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
        const spec = ConnectorBindingResolver.SpecOf(this.plan, binding)
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
        return new ConnectorInstanceView(binding, rows[0]!)
    }
}
