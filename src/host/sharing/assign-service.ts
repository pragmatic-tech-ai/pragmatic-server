import type { IInstanceView, ModelConnectorPlan, WriteBatch, WriteOperation, WriteResult, WriteFailure, DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import { WriteOperationKind, WriteFailureKind } from '@pragmatic-tech-ai/todl'
import type { IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { Principal } from '@pragmatic-tech-ai/todl-identity'
import { AssignOutcome } from '@pragmatic-tech-ai/todl-identity-engine'
import type { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { AssignStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AssignParams, AssignResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IWriteTargetSource } from '../write-target-source.js'
import type { ShareGrantIndex } from './share-grant-index.js'
import type { ConceptIdFields } from './concept-id-fields.js'
import { ConnectorWrites } from '../connector-writes.js'
import { RecordKey } from './record-keyed-view.js'

/** Executes one record-assign op: changes the owner/owningBU columns under the Assign right (role OR share), without the Update gate. */
export class AssignService
{
    private static readonly RecordNotFound = 'record not found or not visible'
    private static readonly NotAuthorized = 'not authorized to assign this record'
    private static readonly NotAssignable = 'concept is not assignable'
    private static readonly OwningBuRequired = 'an owning business unit is required'
    private static readonly UnknownBusinessUnit = 'unknown owning business unit'
    private static readonly UnknownTeam = 'unknown team owner'
    private static readonly NotWritable = 'concept is not bound to a writable source'
    private static readonly WriteConflictReason = 'write conflict'
    private static readonly WriteFailedReason = 'write failed'
    private static readonly NoOwnershipColumns = 'no ownership columns to write'

    constructor(
        private readonly evaluator: AccessDepthEvaluator,
        private readonly index: ShareGrantIndex,
        private readonly principal: Principal,
        private readonly target: IWriteTargetSource,
        private readonly idFields: ConceptIdFields,
        private readonly plan: ModelConnectorPlan,
        private readonly catalog: DataSourceAdapterCatalog,
        private readonly services: IServiceProvider)
    {
    }

    public async Assign(params: AssignParams): Promise<AssignResultDto>
    {
        const view = await this.target.Fetch(params.concept, params.id)
        const concept = view !== undefined ? view.Concept : params.concept
        const recordId = view !== undefined ? (this.RecordId(concept, view) ?? params.id) : params.id
        if (!this.Authorized(concept, view, recordId))
        {
            return view === undefined
                ? { status: AssignStatus.NotFound, reason: AssignService.RecordNotFound }
                : { status: AssignStatus.Denied, reason: AssignService.NotAuthorized }
        }
        const computed = this.evaluator.AssignWrites(concept, params.owner.id, params.owner.kind === ShareSubjectKind.Team, params.owningBu)
        const rejection = AssignService.StatusFor(computed.outcome)
        if (rejection !== undefined)
        {
            return rejection
        }
        return this.ApplyWrites(concept, recordId, computed.writes)
    }

    private Authorized(concept: string, view: IInstanceView | undefined, recordId: string): boolean
    {
        if (view !== undefined && this.evaluator.Allows(this.principal, PrivilegeAction.Assign, view))
        {
            return true
        }
        return this.index.AllowsRecord(concept, recordId, PrivilegeAction.Assign)
    }

    private RecordId(concept: string, view: IInstanceView): string | undefined
    {
        const key = RecordKey.Of(view)
        if (key !== undefined)
        {
            return key
        }
        const value = view.Field(this.idFields.IdFieldFor(concept))
        return typeof value === 'string' ? value : value === undefined ? undefined : String(value)
    }

    private static StatusFor(outcome: AssignOutcome): AssignResultDto | undefined
    {
        switch (outcome)
        {
            case AssignOutcome.Unsupported:
                return { status: AssignStatus.Unsupported, reason: AssignService.NotAssignable }
            case AssignOutcome.UnknownTeam:
                return { status: AssignStatus.Invalid, reason: AssignService.UnknownTeam }
            case AssignOutcome.UnknownBusinessUnit:
                return { status: AssignStatus.Invalid, reason: AssignService.UnknownBusinessUnit }
            case AssignOutcome.OwningBusinessUnitRequired:
                return { status: AssignStatus.Invalid, reason: AssignService.OwningBuRequired }
            default:
                return undefined
        }
    }

    private async ApplyWrites(concept: string, recordId: string, writes: readonly { field: string; value: string }[]): Promise<AssignResultDto>
    {
        const binding = this.plan.Bindings.find(b => b.Concept === concept)
        if (binding === undefined || !binding.Writable)
        {
            return { status: AssignStatus.Invalid, reason: AssignService.NotWritable }
        }
        const spec = this.plan.Connectors.find(c => c.Name === binding.Connector)
        if (spec === undefined)
        {
            return { status: AssignStatus.Invalid, reason: AssignService.NotWritable }
        }
        const fields: Record<string, unknown> = {}
        for (const write of writes)
        {
            fields[write.field] = write.value
        }
        const mapped = ConnectorWrites.ToExternalFields(binding, fields)
        if (Object.keys(mapped).length === 0)
        {
            return { status: AssignStatus.Invalid, reason: AssignService.NoOwnershipColumns }
        }
        const operation: WriteOperation = { Kind: WriteOperationKind.Upsert, Key: recordId, Fields: mapped }
        const batch: WriteBatch = { Source: binding.Source, IdKey: binding.IdKey, Operations: [operation], Concurrency: binding.Concurrency, Atomicity: binding.Atomicity, VersionField: binding.VersionField }
        let result: WriteResult
        try
        {
            const adapter = await this.catalog.Open(spec, this.services)
            result = await adapter.Apply(batch)
        }
        catch
        {
            return { status: AssignStatus.Denied, reason: AssignService.WriteFailedReason }
        }
        const failure = result.Failures.find((f: WriteFailure) => String(f.Key) === String(recordId))
        if (failure === undefined)
        {
            return { status: AssignStatus.Applied }
        }
        return failure.Kind === WriteFailureKind.Conflict
            ? { status: AssignStatus.Denied, reason: AssignService.WriteConflictReason }
            : { status: AssignStatus.Denied, reason: AssignService.WriteFailedReason }
    }
}
