import { AccessScope, Cypher, ValueType } from '@pragmatic-tech-ai/graph'
import type { CellValue, ConnectorContext, GraphEngine, GraphTransaction, IFetchedView } from '@pragmatic-tech-ai/graph'
import type { DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import type { ExternalIdentity, IExternalBinding } from '@pragmatic-tech-ai/todl/engine'
import type { IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { AppWriteStatus, ConnectorWriteOp, CursorStaleError, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type {
    ConnectionProbeDto, ConnectorMergeDecisionDto, ConnectorModelDto, ConnectorPagedWriteParams, ConnectorPagedWriteResultDto, ConnectorReadParams,
    ConnectorRefreshOutcomeDto, ConnectorWriteBackParams, ConnectorWriteOpDto, ConnectorWriteOpResultDto, EntityDto, FlushOutcomeDto, Page, PageParams,
} from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { PagingLimits } from '../../config/paging-limits.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import { PageFingerprint } from '../paging/page-request.js'
import { RuntimeWritePayloadValidator } from '../runtime-write-payload-validator.js'
import type { IGraphScopeSource } from './access-scope-source.js'
import { ConnectorEntity } from './connector-entity.js'
import { ConnectorWhereClause } from './connector-where-clause.js'
import { CypherKeysetPage } from './cypher-keyset-page.js'
import { EngineCypherQuery, EngineCypherQueryError, EngineCypherQueryErrorCode } from './engine-cypher-query.js'
import type { EngineSchemaCatalog } from './engine-schema-catalog.js'
import { EngineWriteFailure } from './engine-write-failure.js'
import type { IWriteFailureOutcome } from './engine-write-failure.js'
import type { IEngineSnapshot, IGraphEngineHost } from './graph-engine-host.js'
import { ModelScopes } from './model-scopes.js'
import { DeleteGrantsScope, RecordGrantDeletion } from './record-grant-deletion.js'
import { EngineWriteAttribution, RecordedBatch } from './recorded-batch.js'
import { CallerConnectorContext } from '../environment/caller-connector-context.js'

/** The `connector/*` endpoints' engine side, for any engine host (ruling S1); the wire DTOs are the protocol's. */
export interface IGraphConnectorService
{
    List(): Promise<ConnectorModelDto[]>
    Prepare(modelId: string): Promise<void>
    Refresh(): Promise<void>
    RefreshModel(modelId: string): Promise<ConnectorRefreshOutcomeDto>
    Read(context: AccessContext, params: ConnectorReadParams, limits: PagingLimits): Promise<Page<EntityDto>>
    ReadPage(context: AccessContext, params: ConnectorReadParams, limits: PagingLimits): Promise<Page<EntityDto>>
    WritePaged(context: AccessContext, params: ConnectorPagedWriteParams): Promise<ConnectorPagedWriteResultDto>
    WriteBack(context: AccessContext, params: ConnectorWriteBackParams): Promise<FlushOutcomeDto>
    Decisions(context: AccessContext, modelId: string, canonical: string | undefined): Promise<ConnectorMergeDecisionDto[]>
    Test(modelId: string, connectorName: string): Promise<ConnectionProbeDto>
}

/** One pre-checked `connector/writePaged` op. */
interface IPagedOp
{
    readonly Key: ConnectorWriteOpDto['key']
    readonly Kind: ConnectorWriteOp
    readonly Id: string
    readonly Binding: IExternalBinding
    readonly Cells: ReadonlyMap<string, CellValue>
    /** The client's write guard (R16); undefined when it sent none. */
    readonly Expected: ConnectorWriteOpDto['expectedVersion'] | undefined
}

/** The outcome refusing a batch: which op it is attributed to (undefined = every op) and what it means. */
interface IRefusal
{
    readonly Op: number | undefined
    readonly Outcome: IWriteFailureOutcome
}

/** The engine and the snapshot it runs, once their versions agree. */
interface ISettled
{
    readonly Engine: GraphEngine
    readonly Snapshot: IEngineSnapshot
}

/**
 * Every `connector/*` endpoint on a host's graph engine, dev and runtime alike (rulings S1, S14; amendment A6). There is
 * no per-connection connector runtime and no materialized working copy any more: connector data is read and written
 * through the engine's external connectors under the caller's {@link IGraphScope}, which alone decides what a caller
 * sees and may write (connector-bound concepts are outside platform security, R12/A6: their rows are all visible and
 * writable unless their binding is read-only; engine-stored concepts keep the caller's depth). `modelId` is a dev model
 * id or a runtime package id (one of the snapshot's `Models`, else InvalidParams "model not found").
 *
 * - `List`: the snapshot's external bindings grouped by binding model (connector name and kind, binding concept,
 *   connector, source, writable), sorted by model id. `Prepare` and `RefreshModel` are no-ops (nothing is
 *   materialized); `Decisions` is `[]` (the engine merges nothing, Q4).
 * - `Read` / `ReadPage`: `MATCH (n:<concept>)[ WHERE ...] RETURN n` under the caller scope AND the S12 model filter
 *   ({@link ModelScopes}), keyset-paged ({@link CypherKeysetPage}, S11); `where` ({@link ConnectorWhereClause}) on
 *   ReadPage only (Read refuses it, as before). Push-down to the source is the engine's and limited (P10): only `eq` /
 *   `in` on String or Boolean members and `isNull` / `isNotNull` reach the source; numeric, temporal and range terms are
 *   evaluated by the engine over every row the binding fetches. Cursor fingerprint: `connector`, model, concept, the
 *   canonical filter, the schema version and the scope digest (a commit between pages neither repeats nor skips rows).
 *   A read that saw the engine upgrade while it ran is run again (as EngineCypherQuery does).
 * - `WritePaged`: one engine transaction for the batch. Each op's binding is found by `(concept, connector, source)`
 *   among the model's external bindings; its key is the public id `Identity.Mint(binding, String(key))`; its fields are
 *   the concept's members the binding maps (never its id or version member), checked as `data/write` checks them. Every
 *   row is fetched in the transaction first (`GraphTransaction.Fetch`, R15): an upsert updates the row when the fetch
 *   returns it, else creates it with that public id, its id member set to the key and Owner = the binding model; a
 *   delete deletes the fetched row; a key the source no longer holds records nothing and is `applied` (idempotent, R48:
 *   connector concepts are not scope-gated, A6, so an absent fetch means absent). A non-null `expectedVersion` is the
 *   write guard (R16): it needs a binding with a version field (else `invalid`), the fetched row's version must equal it
 *   (else `conflict` "write conflict" and nothing is written), and the engine carries that version to the source as
 *   ExpectedVersion. A pre-check or commit failure gives the op it names the mapped status (EngineWriteFailure) and
 *   every other op `failed` "atomic batch rolled back". Results carry no `version` (R50: reporting the new version waits
 *   for the engine to report the source versions a commit wrote).
 * - `WriteBack`: writes commit when made, so `dirty` ids flush nothing (diagnostic `NothingToFlush`); `deleted` ids are
 *   deleted in one transaction under the caller scope after a fetch (audit defect 2): an id the transaction cannot see,
 *   or one another model owns, or a delete the scope refuses, is a failure and nothing is removed. The share grants
 *   linking a deleted record are deleted in the same transaction (R49, {@link RecordGrantDeletion}, as `data/write`:
 *   pre-read by a System reader, the scope widened by {@link DeleteGrantsScope}, a grant linked since refuses the batch
 *   as a conflict).
 * - `Refresh`: invalidates the snapshot specs' adapters in the process-wide `DataSourceAdapterCatalog` and resets the
 *   host's lazy external connectors (R23), so the next use re-opens with fresh credentials. `Test` probes one connector:
 *   it opens the adapter through the catalog and queries the id field of the first binding (never a secret or raw error).
 */
export class EngineConnectorService implements IGraphConnectorService
{
    public static readonly MaxAttempts = EngineCypherQuery.MaxAttempts
    private static readonly FingerprintTag = 'connector'
    private static readonly ReadWhereUnsupportedMessage = `${InvalidParamsPrefix.Text}where is supported on connector/readPage only`
    private static readonly UnknownConceptMessage = `${InvalidParamsPrefix.Text}unknown concept`
    private static readonly MatchOpen = 'MATCH (n:`'
    private static readonly MatchClose = '`)'
    private static readonly ReturnNode = ' RETURN n'
    private static readonly RolledBack = 'atomic batch rolled back'
    private static readonly UnknownOperation = 'unknown operation kind'
    private static readonly NoBinding = 'no binding for this connector and source'
    private static readonly FieldNotWritable = 'field not writable'
    private static readonly DuplicateKey = 'duplicate key in batch'
    private static readonly NoIdMember = 'the binding has no id field to take the id'
    private static readonly KeyNotFit = 'the key does not fit the binding\'s id field'
    private static readonly NoVersionField = 'expectedVersion needs a binding with a version field'
    private static readonly NothingToFlushCode = 'NothingToFlush'
    private static readonly NothingToFlushMessage = 'writes are committed when made; nothing is pending'
    private static readonly UnknownConnectorDetail = 'unknown connector'
    private static readonly ProbeFailedDetail = 'connection probe failed'
    private static readonly IntegerKey = /^-?\d+$/
    private static readonly DecimalKey = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/
    private static readonly Int64Min = -(2n ** 63n)
    private static readonly Int64Max = 2n ** 63n - 1n
    private static readonly Invisible: IWriteFailureOutcome = { Status: AppWriteStatus.Denied, Reason: EngineWriteFailure.RecordDenied }

    private readonly modelScopes = new ModelScopes()
    private readonly validator = new RuntimeWritePayloadValidator()

    public constructor(
        private readonly host: IGraphEngineHost,
        private readonly scopes: () => Promise<IGraphScopeSource>,
        private readonly adapters: DataSourceAdapterCatalog,
        private readonly services: IServiceProvider)
    {
    }

    public async List(): Promise<ConnectorModelDto[]>
    {
        const snapshot = await this.host.Snapshot()
        const models = new Map<string, ConnectorModelDto>()
        for (const plan of snapshot.Connectors)
        {
            for (const binding of plan.Bindings)
            {
                let model = models.get(binding.Model)
                if (model === undefined)
                {
                    model = { modelId: binding.Model, connectors: [], bindings: [] }
                    models.set(binding.Model, model)
                }
                if (!model.connectors.some(connector => connector.name === plan.Spec.Name)) model.connectors.push({ name: plan.Spec.Name, kind: plan.Spec.Kind })
                const b = binding.Binding
                model.bindings.push({ concept: b.Concept, connector: b.Connector, source: b.Source, writable: b.Writable })
            }
        }
        return [...models.values()].sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0))
    }

    public async Prepare(_modelId: string): Promise<void>
    {
    }

    public async RefreshModel(_modelId: string): Promise<ConnectorRefreshOutcomeDto>
    {
        return { diagnostics: [] }
    }

    public async Decisions(_context: AccessContext, _modelId: string, _canonical: string | undefined): Promise<ConnectorMergeDecisionDto[]>
    {
        return []
    }

    public async Refresh(): Promise<void>
    {
        const snapshot = await this.host.Snapshot()
        for (const plan of snapshot.Connectors) await this.adapters.Invalidate(plan.Spec)
        this.host.ResetConnectors()
    }

    public async Test(modelId: string, connectorName: string): Promise<ConnectionProbeDto>
    {
        const snapshot = await this.host.Snapshot()
        for (const plan of snapshot.Connectors)
        {
            const binding = plan.Bindings.find(b => b.Model === modelId && b.Binding.Connector === connectorName)
            if (binding === undefined) continue
            try
            {
                const adapter = await this.adapters.Open(plan.Spec, this.services)
                await adapter.Query({ Source: binding.Binding.Source, Fields: [binding.Binding.IdKey] })
                return { ok: true }
            }
            catch
            {
                return { ok: false, detail: EngineConnectorService.ProbeFailedDetail }
            }
        }
        return { ok: false, detail: EngineConnectorService.UnknownConnectorDetail }
    }

    public Read(context: AccessContext, params: ConnectorReadParams, limits: PagingLimits): Promise<Page<EntityDto>>
    {
        if (params.where !== undefined && params.where !== null)
        {
            return Promise.reject(new ResponseError(ErrorCodes.InvalidParams, EngineConnectorService.ReadWhereUnsupportedMessage))
        }
        return this.Page(context, params, limits)
    }

    public ReadPage(context: AccessContext, params: ConnectorReadParams, limits: PagingLimits): Promise<Page<EntityDto>>
    {
        return this.Page(context, params, limits)
    }

    public async WritePaged(context: AccessContext, params: ConnectorPagedWriteParams): Promise<ConnectorPagedWriteResultDto>
    {
        const operations = params.operations ?? []
        if (operations.length === 0) return { results: [] }
        const { Engine: engine, Snapshot: snapshot } = await this.Settled()
        const catalog = this.modelScopes.CatalogOf(snapshot.Description)
        const planned: IPagedOp[] = []
        const ids = new Set<string>()
        for (let index = 0; index < operations.length; index++)
        {
            const op = this.Plan(operations[index]!, params.modelId, snapshot.Identity, catalog, ids)
            if (!('Kind' in op)) return EngineConnectorService.Refused(operations, { Op: index, Outcome: op })
            planned.push(op)
        }
        const identity = snapshot.Identity!
        const graphScope = await (await this.scopes()).ScopeFor(context)
        const transaction = await engine.Begin(graphScope.Scope, { Connector: graphScope.Connector })
        try
        {
            const batch = new RecordedBatch(transaction)
            const refusal = await EngineConnectorService.RecordPaged(transaction, batch, planned, identity)
            if (refusal !== undefined) return EngineConnectorService.Refused(operations, refusal)
            const failure = await EngineConnectorService.Commit(transaction, identity, batch)
            if (failure !== undefined) return EngineConnectorService.Refused(operations, failure)
        }
        finally
        {
            transaction.dispose()
        }
        return { results: planned.map((op): ConnectorWriteOpResultDto => ({ key: op.Key, status: AppWriteStatus.Applied })) }
    }

    public async WriteBack(context: AccessContext, params: ConnectorWriteBackParams): Promise<FlushOutcomeDto>
    {
        const diagnostics = (params.dirty ?? []).length > 0 ? [{ code: EngineConnectorService.NothingToFlushCode, message: EngineConnectorService.NothingToFlushMessage }] : []
        const deleted = [...new Set(params.deleted ?? [])]
        if (deleted.length === 0) return { results: [{ applied: 0, failures: [] }], diagnostics }
        const { Engine: engine, Snapshot: snapshot } = await this.Settled()
        EngineConnectorService.RequireModel(snapshot, params.modelId)
        const catalog = this.modelScopes.CatalogOf(snapshot.Description)
        const grants = await EngineConnectorService.GrantsOf(engine, deleted, CallerConnectorContext.For(context.Principal))
        const graphScope = await (await this.scopes()).ScopeFor(context)
        const transaction = await engine.Begin(DeleteGrantsScope.For(graphScope.Scope, new Set(grants.keys()), catalog, new Set(deleted)), { Connector: graphScope.Connector })
        let refusal: IRefusal | undefined
        try
        {
            const fetched = await EngineConnectorService.Fetch(transaction, deleted, snapshot.Identity)
            if (EngineConnectorService.IsRefusal(fetched))
            {
                refusal = fetched
            }
            else
            {
                // the model filter: a record another model owns is not this model's to delete
                const invisible = deleted.filter(id => fetched.get(id)?.Owner !== params.modelId)
                if (invisible.length > 0)
                {
                    return { results: [{ applied: 0, failures: invisible.map(id => EngineConnectorService.Failure(id, EngineConnectorService.Invisible)) }], diagnostics }
                }
                const batch = new RecordedBatch(transaction)
                refusal = await EngineConnectorService.RecordDeletes(transaction, batch, deleted, grants)
                refusal ??= await EngineConnectorService.Commit(transaction, snapshot.Identity, batch)
            }
        }
        finally
        {
            transaction.dispose()
        }
        if (refusal === undefined) return { results: [{ applied: deleted.length, failures: [] }], diagnostics }
        const named = refusal.Op === undefined ? deleted : [deleted[refusal.Op]!]
        return { results: [{ applied: 0, failures: named.map(id => EngineConnectorService.Failure(id, refusal!.Outcome)) }], diagnostics }
    }

    /** One read page (see the class remarks), run again while the engine upgrades under it. */
    private async Page(context: AccessContext, params: ConnectorReadParams, limits: PagingLimits): Promise<Page<EntityDto>>
    {
        for (let attempt = 1; attempt <= EngineConnectorService.MaxAttempts; attempt++)
        {
            const last = attempt === EngineConnectorService.MaxAttempts
            const engine = await this.host.Engine()
            const before = engine.SchemaVersion
            const snapshot = await this.host.Snapshot()
            if (snapshot.Description.Version !== before)
            {
                await EngineConnectorService.Yield()
                continue
            }
            EngineConnectorService.RequireModel(snapshot, params.modelId)
            const catalog = this.modelScopes.CatalogOf(snapshot.Description)
            if (typeof params.concept !== 'string' || !catalog.IsConcept(params.concept))
            {
                throw new ResponseError(ErrorCodes.InvalidParams, EngineConnectorService.UnknownConceptMessage)
            }
            const where = ConnectorWhereClause.Of(params.where, params.concept, catalog)
            const graphScope = await (await this.scopes()).ScopeFor(context)
            const scope = this.modelScopes.For(graphScope.Scope, params.modelId, snapshot.Description)
            const fingerprint = PageFingerprint.Of(EngineConnectorService.FingerprintTag, params.modelId, params.concept, where.Canonical, before, graphScope.Digest)
            const page = CypherKeysetPage.Resolve(params as PageParams, fingerprint, limits)
            const source = EngineConnectorService.MatchOpen + params.concept + EngineConnectorService.MatchClose + where.Text + EngineConnectorService.ReturnNode
            let result: Cypher.CypherResult
            try
            {
                result = await new Cypher.CypherEngine(engine).Execute(scope, source, { Parameters: where.Parameters, Limits: page.Limits(), Connector: graphScope.Connector })
            }
            catch (error)
            {
                if (!last && engine.SchemaVersion !== before) continue
                throw EngineCypherQuery.WireError(error)
            }
            if (engine.SchemaVersion !== before && !last) continue
            const items = result.Rows.map(row => ConnectorEntity.Of((row[0] as Cypher.NodeValue).Node))
            const nextCursor = page.NextCursor(result)
            return nextCursor === undefined ? { items } : { items, nextCursor }
        }
        if (params.cursor !== undefined && params.cursor !== null) throw new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
        throw new EngineCypherQueryError(EngineCypherQueryErrorCode.Unsettled)
    }

    /** The pre-checked op, or the outcome refusing it; `ids` collects the batch's target ids. */
    private Plan(op: ConnectorWriteOpDto, modelId: string, identity: ExternalIdentity | undefined, catalog: EngineSchemaCatalog, ids: Set<string>): IPagedOp | IWriteFailureOutcome
    {
        if (op.op !== ConnectorWriteOp.Upsert && op.op !== ConnectorWriteOp.Delete) return EngineConnectorService.Invalid(EngineConnectorService.UnknownOperation)
        const binding = identity?.Bindings().find(b => b.Model === modelId && b.Binding.Concept === op.concept && b.Binding.Connector === op.connector && b.Binding.Source === op.source)
        if (identity === undefined || binding === undefined) return EngineConnectorService.Invalid(EngineConnectorService.NoBinding)
        const id = identity.Mint(binding, String(op.key))
        if (ids.has(id)) return EngineConnectorService.Invalid(EngineConnectorService.DuplicateKey)
        ids.add(id)
        let cells: ReadonlyMap<string, CellValue> = new Map()
        if (op.op === ConnectorWriteOp.Upsert)
        {
            const fields = op.fields ?? {}
            const idMember = identity.IdMemberName(binding)
            for (const member of Object.keys(fields))
            {
                const external = Object.hasOwn(binding.Binding.FieldMap, member) ? binding.Binding.FieldMap[member] : undefined
                if (external === undefined || member === idMember || external === binding.Binding.IdKey || external === binding.Binding.VersionField)
                {
                    return EngineConnectorService.Invalid(EngineConnectorService.FieldNotWritable)
                }
            }
            const checked = this.validator.Check(catalog, undefined, op.concept, false, fields)
            if (checked.Cells === undefined) return EngineConnectorService.Invalid(checked.Reason!)
            cells = checked.Cells
        }
        const expected = op.expectedVersion === null ? undefined : op.expectedVersion
        if (expected !== undefined && binding.Binding.VersionField === undefined) return EngineConnectorService.Invalid(EngineConnectorService.NoVersionField)
        return { Key: op.key, Kind: op.op, Id: id, Binding: binding, Cells: cells, Expected: expected }
    }

    /**
     * Fetches every op's row in the transaction, checks each guard, then records the ops through `batch`. Returns the
     * refusal of an op that cannot be recorded (a stale version, a create with no id member, a recording error the
     * failure table maps), or a failed fetch (every op).
     */
    private static async RecordPaged(transaction: GraphTransaction, batch: RecordedBatch, planned: readonly IPagedOp[], identity: ExternalIdentity): Promise<IRefusal | undefined>
    {
        const fetched = await EngineConnectorService.Fetch(transaction, planned.map(op => op.Id), identity)
        if (EngineConnectorService.IsRefusal(fetched)) return fetched
        for (let index = 0; index < planned.length; index++)
        {
            const op = planned[index]!
            const row = fetched.get(op.Id)
            if (op.Expected !== undefined && (row?.Version === undefined || String(row.Version) !== String(op.Expected)))
            {
                return { Op: index, Outcome: EngineWriteFailure.Conflict }
            }
            try
            {
                const refusal = EngineConnectorService.RecordOp(batch, op, index, row, identity)
                if (refusal !== undefined) return { Op: index, Outcome: refusal }
            }
            catch (error)
            {
                const outcome = EngineWriteFailure.Map(error)
                if (outcome === undefined) throw error
                return { Op: index, Outcome: outcome }
            }
        }
        return undefined
    }

    private static RecordOp(batch: RecordedBatch, op: IPagedOp, index: number, row: IFetchedView | undefined, identity: ExternalIdentity): IWriteFailureOutcome | undefined
    {
        if (op.Kind === ConnectorWriteOp.Delete)
        {
            // R48: a key the source no longer holds is already deleted (connector rows are not scope-gated, A6)
            if (row !== undefined) batch.DeleteNode(index, op.Id)
            return undefined
        }
        if (row === undefined)
        {
            const member = identity.IdMemberName(op.Binding)
            const type = identity.IdMemberType(op.Binding)
            if (member === undefined || type === undefined) return EngineConnectorService.Invalid(EngineConnectorService.NoIdMember)
            const key = EngineConnectorService.KeyCell(op.Key, type)
            if (key === undefined) return EngineConnectorService.Invalid(EngineConnectorService.KeyNotFit)
            batch.CreateNode(index, op.Id, op.Binding.Binding.Concept, op.Binding.Model)
            batch.SetProperty(index, op.Id, member, key)
        }
        else
        {
            batch.Target(index, op.Id)
        }
        for (const [member, value] of op.Cells) batch.SetProperty(index, op.Id, member, value)
        return undefined
    }

    /**
     * The source key as the id member's cell: an integer for an Int64 id member, a number for a Float64 one, the text for a
     * String one; undefined when the key's text does not fit the member (empty or non-numeric text on a numeric member,
     * an integer outside the Int64 range, a boolean key, or another type).
     */
    private static KeyCell(key: ConnectorWriteOpDto['key'], type: ValueType): CellValue | undefined
    {
        const text = String(key)
        switch (type)
        {
            case ValueType.Int64:
                return EngineConnectorService.IntegerKey.test(text) ? EngineConnectorService.Int64Of(BigInt(text)) : undefined
            case ValueType.Float64:
                return EngineConnectorService.DecimalKey.test(text) && Number.isFinite(Number(text)) ? Number(text) : undefined
            case ValueType.String:
                return typeof key === 'boolean' ? undefined : text
            default:
                return undefined
        }
    }

    /** `value` when it lies in the Int64 range, else undefined. */
    private static Int64Of(value: bigint): bigint | undefined
    {
        return value >= EngineConnectorService.Int64Min && value <= EngineConnectorService.Int64Max ? value : undefined
    }

    /** The rows of `ids` the transaction sees (TODL ids fetched as their binding's concept and model), or the refusal of a failed fetch. */
    private static async Fetch(transaction: GraphTransaction, ids: readonly string[], identity: ExternalIdentity | undefined): Promise<ReadonlyMap<string, IFetchedView> | IRefusal>
    {
        try
        {
            return await transaction.Fetch(ids.map(id => EngineWriteAttribution.FetchKey(id, identity)))
        }
        catch (error)
        {
            const outcome = EngineWriteFailure.Map(error)
            if (outcome === undefined) throw error
            return { Op: undefined, Outcome: outcome }
        }
    }

    /** Commits; the refusal a mapped commit failure means (attributed per EngineWriteAttribution), else undefined. */
    private static async Commit(transaction: GraphTransaction, identity: ExternalIdentity | undefined, batch: RecordedBatch): Promise<IRefusal | undefined>
    {
        try
        {
            await transaction.Commit()
            return undefined
        }
        catch (error)
        {
            const outcome = EngineWriteFailure.Map(error)
            if (outcome === undefined) throw error
            return { Op: EngineWriteAttribution.Attribute(error, identity, batch), Outcome: outcome }
        }
    }

    /** Grant id -> the deleted record it links, as a System reader sees them before the transaction (R49). */
    private static async GrantsOf(engine: GraphEngine, records: readonly string[], connector: ConnectorContext): Promise<ReadonlyMap<string, string>>
    {
        const reader = await engine.BeginRead(AccessScope.System, { Connector: connector })
        try
        {
            return await RecordGrantDeletion.PreRead(reader, records)
        }
        finally
        {
            reader.dispose()
        }
    }

    /**
     * Records each deleted record's grants then the record (as op `index`, R49), or the refusal of a record a grant was
     * linked to since the pre-read (R40: `conflict`).
     */
    private static async RecordDeletes(transaction: GraphTransaction, batch: RecordedBatch, deleted: readonly string[], grants: ReadonlyMap<string, string>): Promise<IRefusal | undefined>
    {
        const recorded = new Set<string>()
        for (let index = 0; index < deleted.length; index++)
        {
            const id = deleted[index]!
            if (await RecordGrantDeletion.LinkedSince(transaction, id, grants)) return { Op: index, Outcome: EngineWriteFailure.Conflict }
            try
            {
                RecordGrantDeletion.Record(batch, index, id, grants, recorded)
                batch.DeleteNode(index, id)
            }
            catch (error)
            {
                const outcome = EngineWriteFailure.Map(error)
                if (outcome === undefined) throw error
                return { Op: index, Outcome: outcome }
            }
        }
        return undefined
    }

    /** The engine and its snapshot once their versions agree (an upgrade being applied installs its snapshot after the engine). */
    private async Settled(): Promise<ISettled>
    {
        for (let attempt = 1; attempt <= EngineConnectorService.MaxAttempts; attempt++)
        {
            const engine = await this.host.Engine()
            const snapshot = await this.host.Snapshot()
            if (snapshot.Description.Version === engine.SchemaVersion) return { Engine: engine, Snapshot: snapshot }
            await EngineConnectorService.Yield()
        }
        throw new EngineCypherQueryError(EngineCypherQueryErrorCode.Unsettled)
    }

    private static RequireModel(snapshot: IEngineSnapshot, modelId: string): void
    {
        if (!snapshot.Models.includes(modelId)) throw new ResponseError(ErrorCodes.InvalidParams, EngineCypherQuery.ModelNotFoundMessage)
    }

    /** Every op's result for a refused batch: the attributed op gets the outcome, the others are rolled back. */
    private static Refused(operations: readonly ConnectorWriteOpDto[], refusal: IRefusal): ConnectorPagedWriteResultDto
    {
        return {
            results: operations.map((op, index): ConnectorWriteOpResultDto =>
            {
                const outcome = refusal.Op === undefined || refusal.Op === index ? refusal.Outcome : { Status: AppWriteStatus.Failed, Reason: EngineConnectorService.RolledBack }
                return { key: op.key, status: outcome.Status, reason: outcome.Reason }
            }),
        }
    }

    private static IsRefusal(value: ReadonlyMap<string, IFetchedView> | IRefusal): value is IRefusal
    {
        return 'Outcome' in value
    }

    private static Failure(id: string, outcome: IWriteFailureOutcome): { key: string; kind: string; reason: string }
    {
        return { key: id, kind: outcome.Status, reason: outcome.Reason }
    }

    private static Invalid(reason: string): IWriteFailureOutcome
    {
        return { Status: AppWriteStatus.Invalid, Reason: reason }
    }

    private static Yield(): Promise<void>
    {
        return new Promise<void>(resolve => setImmediate(resolve))
    }
}
