import { WriteOperationKind, WriteConcurrency, WriteAtomicity } from '@pragmatic-tech-ai/todl'
import type { ConnectorBinding, ConnectorSpec, ModelConnectorPlan, WriteBatch, WriteOperation, WriteResult, WriteFailure } from '@pragmatic-tech-ai/todl'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteStatus, ConnectorWriteOp } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ConnectorPagedWriteParams, ConnectorPagedWriteResultDto, ConnectorWriteOpDto, ConnectorWriteOpResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AppWriteStatuses } from './app-write-status.js'
import { ConnectorWrites } from './connector-writes.js'
import { KeyedWriteTargetSource } from './keyed-write-target-source.js'
import type { IAdapterOpener } from './keyed-write-target-source.js'
import type { IConceptType } from './runtime-write-payload-validator.js'
import { RuntimeWritePayloadValidator } from './runtime-write-payload-validator.js'
import type { IWriteAuthorizer } from './cypher/read-filter-source.js'
import type { IWriteInstanceGate } from './cypher/write-instance-gate.js'
import { AllowAllWriteInstanceGate } from './cypher/write-instance-gate.js'

/** Resolves the reflected concept type used to validate a write payload. */
export interface IConceptTypeSource
{
    TypeOf(concept: string): IConceptType | undefined
}

/** Permits every concept/action (identity-less hosts; per-method policy still gates the call). */
export class AllowAllConnectorWriteAuthorizer implements IWriteAuthorizer
{
    public Allows(): boolean
    {
        return true
    }
}

/** The authorizer + gate pair a hydrate writer authorizes through. */
export interface IHydrateAuthorization
{
    authorizer: IWriteAuthorizer
    gate: IWriteInstanceGate
}

interface PlannedOp
{
    index: number
    key: string | number | boolean
    operation: WriteOperation
}

interface HydrateGroup
{
    binding: ConnectorBinding
    spec: ConnectorSpec
    items: PlannedOp[]
    keys: Set<string>
}

/** Executes connector/writePaged: edits paged entities by id+fields. Each op is authorized through the gate (which reads
 *  the target via a single KEYED fetch, never a whole-concept prefetch), validated, then grouped per binding into one
 *  adapter batch. An Optimistic binding with no expectedVersion fails closed to Conflict without sending a write.
 *  Results carry key/status/reason only: never a Config, secret or field value. */
export class ConnectorHydrateWriter
{
    private static readonly UnknownBinding = 'unknown binding'
    private static readonly UnknownOperation = 'unknown operation kind'
    private static readonly Forbidden = 'not authorized for this concept and action'
    private static readonly ReadOnlyBinding = 'binding is read-only'
    private static readonly NotAuthorizedRecord = 'not authorized for this record'
    private static readonly VersionRequired = 'expectedVersion is required for an optimistic binding'
    private static readonly FieldNotWritable = 'field not writable'
    private static readonly DuplicateKey = 'duplicate key in batch'
    private static readonly MissingConnector = 'connector not found for binding'
    private static readonly DefaultRefusal = 'write was refused'
    private static readonly WriteFailed = 'write failed'
    private static readonly RolledBack = 'atomic batch rolled back'
    private static readonly NotProcessed = 'operation was not processed'
    private static readonly GroupKeySeparator = '\u0000'

    private readonly plan: ModelConnectorPlan
    private readonly opener: IAdapterOpener
    private readonly authorization: IHydrateAuthorization
    private readonly types: IConceptTypeSource | undefined
    private readonly validator = new RuntimeWritePayloadValidator()

    public constructor(plan: ModelConnectorPlan, opener: IAdapterOpener, authorization: IHydrateAuthorization, types?: IConceptTypeSource)
    {
        this.plan = plan
        this.opener = opener
        this.authorization = authorization
        this.types = types
    }

    /** Allow-all authorization (identity-less host; the per-method policy gate still guards the call). */
    public static AllowAll(): IHydrateAuthorization
    {
        return { authorizer: new AllowAllConnectorWriteAuthorizer(), gate: AllowAllWriteInstanceGate.Instance }
    }

    /** The keyed write-target source an identity gate should read through. This is the ready seam for the per-row-identity
     *  program item: the keyed Fetch is wired-but-dormant until a ConnectorService authorizationFor factory activates it. */
    public static KeyedTarget(plan: ModelConnectorPlan, opener: IAdapterOpener): KeyedWriteTargetSource
    {
        return new KeyedWriteTargetSource(plan, opener)
    }

    public async Apply(params: ConnectorPagedWriteParams): Promise<ConnectorPagedWriteResultDto>
    {
        const operations = params.operations
        const results: (ConnectorWriteOpResultDto | undefined)[] = new Array(operations.length)
        const groups = new Map<string, HydrateGroup>()
        for (let index = 0; index < operations.length; index++)
        {
            const op = operations[index]!
            try
            {
                await this.Plan(op, index, results, groups)
            }
            catch
            {
                results[index] = { key: op.key, status: AppWriteStatus.Failed, reason: ConnectorHydrateWriter.WriteFailed }
            }
        }
        for (const group of groups.values())
        {
            await this.ApplyGroup(group, results)
        }
        return { results: operations.map((op, i) => results[i] ?? { key: op.key, status: AppWriteStatus.Invalid, reason: ConnectorHydrateWriter.NotProcessed }) }
    }

    private async Plan(op: ConnectorWriteOpDto, index: number, results: (ConnectorWriteOpResultDto | undefined)[], groups: Map<string, HydrateGroup>): Promise<void>
    {
        const binding = this.plan.Bindings.find(b => b.Concept === op.concept && b.Connector === op.connector && b.Source === op.source)
        if (binding === undefined)
        {
            results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Invalid, ConnectorHydrateWriter.UnknownBinding)
            return
        }
        if (op.op !== ConnectorWriteOp.Upsert && op.op !== ConnectorWriteOp.Delete)
        {
            results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Invalid, ConnectorHydrateWriter.UnknownOperation)
            return
        }
        const spec = KeyedWriteTargetSource.SpecOf(this.plan, binding)
        if (spec === undefined)
        {
            results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Invalid, ConnectorHydrateWriter.MissingConnector)
            return
        }
        const { authorizer, gate } = this.authorization
        const action = op.op === ConnectorWriteOp.Delete ? PrivilegeAction.Delete : PrivilegeAction.Update
        if (!authorizer.Allows(op.concept, action))
        {
            results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Denied, ConnectorHydrateWriter.Forbidden)
            return
        }
        if (!binding.Writable)
        {
            results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Denied, ConnectorHydrateWriter.ReadOnlyBinding)
            return
        }
        if (op.op === ConnectorWriteOp.Upsert && !ConnectorHydrateWriter.FieldsWritable(binding, op.fields))
        {
            results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Invalid, ConnectorHydrateWriter.FieldNotWritable)
            return
        }
        if (op.op === ConnectorWriteOp.Upsert && this.types !== undefined)
        {
            const reason = this.validator.Validate(this.types.TypeOf(op.concept), false, op.fields)
            if (reason !== undefined)
            {
                results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Invalid, reason)
                return
            }
        }
        if (!(await gate.AuthorizeById(action, op.concept, String(op.key))))
        {
            results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Denied, ConnectorHydrateWriter.NotAuthorizedRecord)
            return
        }
        if (op.op === ConnectorWriteOp.Upsert)
        {
            for (const field of Object.keys(op.fields ?? {}))
            {
                if (!gate.CanWriteField(op.concept, field, PrivilegeAction.Update))
                {
                    results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Denied, ConnectorHydrateWriter.NotAuthorizedRecord)
                    return
                }
            }
        }
        if (ConnectorHydrateWriter.IsOptimistic(binding) && op.expectedVersion === undefined)
        {
            results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Conflict, ConnectorHydrateWriter.VersionRequired)
            return
        }
        const operation = ConnectorHydrateWriter.OperationFor(op, binding)
        const group = ConnectorHydrateWriter.GroupFor(groups, binding, spec)
        const keyText = String(op.key)
        if (group.keys.has(keyText))
        {
            results[index] = ConnectorHydrateWriter.Refuse(op, AppWriteStatus.Invalid, ConnectorHydrateWriter.DuplicateKey)
            return
        }
        group.keys.add(keyText)
        group.items.push({ index, key: op.key, operation })
    }

    /** Only members mapped by the binding are writable, and never its id or version column (client keys are never raw column names). */
    private static FieldsWritable(binding: ConnectorBinding, fields: Record<string, unknown> | undefined): boolean
    {
        for (const member of Object.keys(fields ?? {}))
        {
            const external = binding.FieldMap[member]
            if (!Object.prototype.hasOwnProperty.call(binding.FieldMap, member) || external === binding.IdKey || external === binding.VersionField)
            {
                return false
            }
        }
        return true
    }

    private static IsOptimistic(binding: ConnectorBinding): boolean
    {
        return binding.Concurrency === WriteConcurrency.Optimistic || binding.VersionField !== undefined
    }

    private static OperationFor(op: ConnectorWriteOpDto, binding: ConnectorBinding): WriteOperation
    {
        if (op.op === ConnectorWriteOp.Delete)
        {
            return op.expectedVersion === undefined
                ? { Kind: WriteOperationKind.Delete, Key: op.key, Fields: {} }
                : { Kind: WriteOperationKind.Delete, Key: op.key, Fields: {}, Version: op.expectedVersion }
        }
        const fields = ConnectorWrites.ToExternalFields(binding, op.fields ?? {})
        return op.expectedVersion === undefined
            ? { Kind: WriteOperationKind.Upsert, Key: op.key, Fields: fields }
            : { Kind: WriteOperationKind.Upsert, Key: op.key, Fields: fields, Version: op.expectedVersion }
    }

    private static Refuse(op: ConnectorWriteOpDto, status: AppWriteStatus, reason: string): ConnectorWriteOpResultDto
    {
        return { key: op.key, status, reason }
    }

    private static GroupFor(groups: Map<string, HydrateGroup>, binding: ConnectorBinding, spec: ConnectorSpec): HydrateGroup
    {
        const key = [binding.Connector, binding.Source, binding.IdKey, binding.VersionField ?? ''].join(ConnectorHydrateWriter.GroupKeySeparator)
        let group = groups.get(key)
        if (group === undefined)
        {
            group = { binding, spec, items: [], keys: new Set<string>() }
            groups.set(key, group)
        }
        return group
    }

    private async ApplyGroup(group: HydrateGroup, results: (ConnectorWriteOpResultDto | undefined)[]): Promise<void>
    {
        const binding = group.binding
        const batch: WriteBatch = { Source: binding.Source, IdKey: binding.IdKey, Operations: group.items.map(i => i.operation), Concurrency: binding.Concurrency, Atomicity: binding.Atomicity, VersionField: binding.VersionField }
        let result: WriteResult
        try
        {
            const adapter = await this.opener.OpenAdapter(group.spec)
            result = await adapter.Apply(batch)
        }
        catch
        {
            for (const item of group.items)
            {
                results[item.index] = { key: item.key, status: AppWriteStatus.Failed, reason: ConnectorHydrateWriter.WriteFailed }
            }
            return
        }
        const failures = new Map<string, WriteFailure>(result.Failures.map(f => [String(f.Key), f]))
        // A transactional batch that applied nothing rolled back wholesale: ops absent from Failures persisted nothing.
        const rolledBack = binding.Atomicity === WriteAtomicity.Transactional && result.Applied === 0 && group.items.length > 0
        for (const item of group.items)
        {
            const failure = failures.get(String(item.key))
            if (failure !== undefined)
            {
                results[item.index] = { key: item.key, status: AppWriteStatuses.Of(failure.Kind), reason: failure.Reason.length > 0 ? failure.Reason : ConnectorHydrateWriter.DefaultRefusal }
            }
            else if (rolledBack)
            {
                results[item.index] = { key: item.key, status: AppWriteStatus.Failed, reason: ConnectorHydrateWriter.RolledBack }
            }
            else
            {
                results[item.index] = { key: item.key, status: AppWriteStatus.Applied }
            }
        }
    }
}
