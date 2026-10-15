import { randomUUID } from 'node:crypto'
import { WriteOperationKind, DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { ModelConnectorPlan, ConnectorBinding, ConnectorSpec, WriteBatch, WriteOperation, WriteResult, ExternalFieldValue, DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto, AppWriteOpResultDto, AppWriteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IConceptType } from './runtime-write-payload-validator.js'
import { RuntimeWritePayloadValidator } from './runtime-write-payload-validator.js'
import type { IWriteAuthorizer } from './cypher/read-filter-source.js'

interface PlannedWrite
{
    index: number
    key: ExternalFieldValue
    operation: WriteOperation
}

interface WriteGroup
{
    binding: ConnectorBinding
    spec: ConnectorSpec
    items: PlannedWrite[]
    keys: Set<string>
}

/** Applies a batch of runtime writes: per-op gate + validate + id + build, grouped by binding, routed to adapters. */
export class RuntimeAppWriter
{
    private static readonly UnknownConcept = 'unknown concept'
    private static readonly Forbidden = 'not authorized for this concept and action'
    private static readonly ReadOnlyBinding = 'binding is read-only'
    private static readonly IdRequired = 'id is required'
    private static readonly IdRequiredExternal = 'id is required for an external concept'
    private static readonly MissingConnector = 'connector not found for binding'
    private static readonly DefaultConflict = 'write was refused'
    private static readonly DuplicateKey = 'duplicate key in batch'
    private static readonly WriteFailed = 'write failed'
    private static readonly NotProcessed = 'operation was not processed'
    private static readonly UnknownOperation = 'unknown operation kind'
    private static readonly GroupKeySeparator = '\u0000'

    constructor(
        private readonly plan: ModelConnectorPlan,
        private readonly graph: IGraphQuery,
        private readonly catalog: DataSourceAdapterCatalog,
        private readonly services: IServiceProvider,
        private readonly authorizer: IWriteAuthorizer,
        private readonly validator: RuntimeWritePayloadValidator)
    {
    }

    public async Apply(operations: readonly AppWriteOpDto[]): Promise<AppWriteResultDto>
    {
        const results: (AppWriteOpResultDto | undefined)[] = new Array(operations.length)
        const groups = new Map<string, WriteGroup>()
        for (let index = 0; index < operations.length; index++)
        {
            let planned: { binding: ConnectorBinding; spec: ConnectorSpec; write: PlannedWrite } | undefined
            try
            {
                planned = this.Plan(operations[index], index, results)
            }
            catch
            {
                results[index] = { status: AppWriteStatus.Invalid, reason: RuntimeAppWriter.WriteFailed }
                continue
            }
            if (planned === undefined)
            {
                continue
            }
            const group = this.GroupFor(groups, planned.binding, planned.spec)
            const keyText = String(planned.write.key)
            if (group.keys.has(keyText))
            {
                results[index] = { status: AppWriteStatus.Invalid, reason: RuntimeAppWriter.DuplicateKey }
                continue
            }
            group.keys.add(keyText)
            group.items.push(planned.write)
        }
        for (const group of groups.values())
        {
            await this.ApplyGroup(group, results)
        }
        return { results: results.map(r => r ?? { status: AppWriteStatus.Invalid, reason: RuntimeAppWriter.NotProcessed }) }
    }

    private Plan(op: AppWriteOpDto, index: number, results: (AppWriteOpResultDto | undefined)[]): { binding: ConnectorBinding; spec: ConnectorSpec; write: PlannedWrite } | undefined
    {
        const binding = this.plan.Bindings.find(b => b.Concept === op.concept)
        if (binding === undefined)
        {
            results[index] = { status: AppWriteStatus.Invalid, reason: RuntimeAppWriter.UnknownConcept }
            return undefined
        }
        if (op.op !== AppWriteOpKind.Create && op.op !== AppWriteOpKind.Update && op.op !== AppWriteOpKind.Delete)
        {
            results[index] = { status: AppWriteStatus.Invalid, reason: RuntimeAppWriter.UnknownOperation }
            return undefined
        }
        const action = this.ActionFor(op.op)
        if (!this.authorizer.Allows(op.concept, action))
        {
            results[index] = { status: AppWriteStatus.Denied, reason: RuntimeAppWriter.Forbidden }
            return undefined
        }
        if (!binding.Writable)
        {
            results[index] = { status: AppWriteStatus.Denied, reason: RuntimeAppWriter.ReadOnlyBinding }
            return undefined
        }
        const spec = this.plan.Connectors.find(c => c.Name === binding.Connector)
        if (spec === undefined)
        {
            results[index] = { status: AppWriteStatus.Invalid, reason: RuntimeAppWriter.MissingConnector }
            return undefined
        }
        if (op.op === AppWriteOpKind.Delete)
        {
            return this.PlanDelete(op, index, binding, spec, results)
        }
        return this.PlanUpsert(op, index, binding, spec, results)
    }

    private PlanUpsert(op: AppWriteOpDto, index: number, binding: ConnectorBinding, spec: ConnectorSpec, results: (AppWriteOpResultDto | undefined)[]): { binding: ConnectorBinding; spec: ConnectorSpec; write: PlannedWrite } | undefined
    {
        const reason = this.validator.Validate(this.graph.Type(op.concept) as IConceptType | undefined, op.op === AppWriteOpKind.Create, op.fields)
        if (reason !== undefined)
        {
            results[index] = { status: AppWriteStatus.Invalid, reason }
            return undefined
        }
        const id = this.ResolveUpsertId(op, spec)
        if (id === undefined)
        {
            const missing = op.op === AppWriteOpKind.Create ? RuntimeAppWriter.IdRequiredExternal : RuntimeAppWriter.IdRequired
            results[index] = { status: AppWriteStatus.Invalid, reason: missing }
            return undefined
        }
        const operation: WriteOperation = { Kind: WriteOperationKind.Upsert, Key: id, Fields: this.MapFields(binding, op.fields) }
        return { binding, spec, write: { index, key: id, operation } }
    }

    private PlanDelete(op: AppWriteOpDto, index: number, binding: ConnectorBinding, spec: ConnectorSpec, results: (AppWriteOpResultDto | undefined)[]): { binding: ConnectorBinding; spec: ConnectorSpec; write: PlannedWrite } | undefined
    {
        if (op.id === undefined || op.id.length === 0)
        {
            results[index] = { status: AppWriteStatus.Invalid, reason: RuntimeAppWriter.IdRequired }
            return undefined
        }
        const operation: WriteOperation = { Kind: WriteOperationKind.Delete, Key: op.id, Fields: {} }
        return { binding, spec, write: { index, key: op.id, operation } }
    }

    private ResolveUpsertId(op: AppWriteOpDto, spec: ConnectorSpec): string | undefined
    {
        if (op.id !== undefined && op.id.length > 0)
        {
            return op.id
        }
        if (op.op === AppWriteOpKind.Create && spec.Kind === DataSourceKind.Builtin)
        {
            return randomUUID()
        }
        return undefined
    }

    private MapFields(binding: ConnectorBinding, fields: Record<string, unknown> | undefined): Record<string, ExternalFieldValue>
    {
        const out: Record<string, ExternalFieldValue> = {}
        const payload = fields ?? {}
        for (const member of Object.keys(payload))
        {
            const external = binding.FieldMap[member] ?? member
            if (external === binding.IdKey)
            {
                continue
            }
            out[external] = payload[member] as ExternalFieldValue
        }
        return out
    }

    private ActionFor(kind: AppWriteOpKind): PrivilegeAction
    {
        if (kind === AppWriteOpKind.Create)
        {
            return PrivilegeAction.Create
        }
        if (kind === AppWriteOpKind.Delete)
        {
            return PrivilegeAction.Delete
        }
        return PrivilegeAction.Update
    }

    private GroupFor(groups: Map<string, WriteGroup>, binding: ConnectorBinding, spec: ConnectorSpec): WriteGroup
    {
        const key = [binding.Connector, binding.Source, binding.IdKey, binding.VersionField ?? ''].join(RuntimeAppWriter.GroupKeySeparator)
        let group = groups.get(key)
        if (group === undefined)
        {
            group = { binding, spec, items: [], keys: new Set<string>() }
            groups.set(key, group)
        }
        return group
    }

    private async ApplyGroup(group: WriteGroup, results: (AppWriteOpResultDto | undefined)[]): Promise<void>
    {
        const batch: WriteBatch = { Source: group.binding.Source, IdKey: group.binding.IdKey, Operations: group.items.map(i => i.operation), VersionField: group.binding.VersionField }
        let result: WriteResult
        try
        {
            const adapter = await this.catalog.Open(group.spec, this.services)
            result = await adapter.Apply(batch)
        }
        catch
        {
            const reason = RuntimeAppWriter.WriteFailed
            for (const item of group.items)
            {
                results[item.index] = { status: AppWriteStatus.Conflict, id: String(item.key), reason }
            }
            return
        }
        const conflicts = new Map(result.Conflicts.map(c => [String(c.Key), c.Reason]))
        for (const item of group.items)
        {
            const conflict = conflicts.get(String(item.key))
            results[item.index] = conflict === undefined
                ? { status: AppWriteStatus.Applied, id: String(item.key) }
                : { status: AppWriteStatus.Conflict, id: String(item.key), reason: conflict.length > 0 ? conflict : RuntimeAppWriter.DefaultConflict }
        }
    }
}
