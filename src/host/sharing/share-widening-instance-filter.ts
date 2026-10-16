import type { IInstanceFilter, IInstanceView } from '@pragmatic-tech-ai/todl'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { ShareGrantIndex } from './share-grant-index.js'
import type { ConceptIdFields } from './concept-id-fields.js'
import { RecordKey } from './record-keyed-view.js'

/** Read-OR (record id: the node-derived key if the view carries one, else the id field): keeps a view if the inner (predicate ∧ depth) filter keeps it, OR a per-record Read share grants it. */
export class ShareWideningInstanceFilter implements IInstanceFilter
{
    constructor(
        private readonly inner: IInstanceFilter,
        private readonly index: ShareGrantIndex,
        private readonly idFields: ConceptIdFields)
    {
    }

    public Keep(view: IInstanceView): boolean
    {
        if (this.inner.Keep(view))
        {
            return true
        }
        const idField = this.idFields.IdFieldFor(view.Concept)
        const recordId = RecordKey.Of(view) ?? view.Field(idField)
        return this.index.AllowsRecord(view.Concept, ShareWideningInstanceFilter.AsId(recordId), PrivilegeAction.Read)
    }

    private static AsId(value: unknown): string | undefined
    {
        return typeof value === 'string' ? value : value === undefined ? undefined : String(value)
    }
}
