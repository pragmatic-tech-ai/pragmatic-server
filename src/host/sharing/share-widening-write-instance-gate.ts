import type { IInstanceView } from '@pragmatic-tech-ai/todl'
import type { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { IWriteInstanceGate } from '../cypher/write-instance-gate.js'
import type { ShareGrantIndex } from './share-grant-index.js'
import type { ConceptIdFields } from './concept-id-fields.js'
import { RecordKey } from './record-keyed-view.js'

/** Write-OR: an inner deny is overridden by a per-record share grant for the same action. Never narrows. */
export class ShareWideningWriteInstanceGate implements IWriteInstanceGate
{
    constructor(
        private readonly inner: IWriteInstanceGate,
        private readonly index: ShareGrantIndex,
        private readonly idFields: ConceptIdFields)
    {
    }

    public CreateDefaults(concept: string): readonly { field: string; value: string }[]
    {
        return this.inner.CreateDefaults(concept)
    }

    public Authorize(action: PrivilegeAction, view: IInstanceView): boolean
    {
        if (this.inner.Authorize(action, view))
        {
            return true
        }
        const recordId = RecordKey.Of(view) ?? ShareWideningWriteInstanceGate.AsId(view.Field(this.idFields.IdFieldFor(view.Concept)))
        return this.index.AllowsRecord(view.Concept, recordId, action)
    }

    public async AuthorizeById(action: PrivilegeAction, concept: string, id: string): Promise<boolean>
    {
        if (this.index.AllowsRecord(concept, id, action))
        {
            return true
        }
        return this.inner.AuthorizeById(action, concept, id)
    }

    public Resolve(concept: string, id: string): Promise<IInstanceView | undefined>
    {
        return this.inner.Resolve(concept, id)
    }

    public CanWriteField(concept: string, field: string, action: PrivilegeAction): boolean
    {
        return this.inner.CanWriteField(concept, field, action)
    }

    private static AsId(value: unknown): string | undefined
    {
        return typeof value === 'string' ? value : value === undefined ? undefined : String(value)
    }
}
