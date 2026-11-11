import { AccessError, AccessScope, ConnectorError, EdgeDirection } from '@pragmatic-tech-ai/graph'
import type { CellValue, Cypher, GraphEngine, GraphTransaction, IFetchKey, IFetchedView } from '@pragmatic-tech-ai/graph'
import { EngineBridgeErrorCode, ExternalWriteError, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import type { ExternalIdentity } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto, AppWriteOpResultDto, AppWriteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IGraphScopeSource } from '../engine/access-scope-source.js'
import { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { EngineWriteFailure } from '../engine/engine-write-failure.js'
import type { IWriteFailureOutcome } from '../engine/engine-write-failure.js'
import type { RuntimeWritePayloadValidator } from '../runtime-write-payload-validator.js'
import type { EnvironmentEngineHost } from './environment-engine-host.js'
import { DeleteGrantsScope } from './service-scopes.js'

/** One pre-checked data/write op: its kind, target id (the op's id; a create's is placed later) and engine cells. */
interface IPlannedOp
{
    readonly Kind: AppWriteOpKind
    readonly Concept: string
    readonly Id: string | undefined
    readonly Cells: ReadonlyMap<string, CellValue>
}

/** The outcome that refuses a batch: which op it is attributed to (undefined = every op) and what it means. */
interface IRefusal
{
    readonly Op: number | undefined
    readonly Outcome: IWriteFailureOutcome
}

/**
 * `data/write` on the environment engine (ruling S10, owner answer Q3, rulings R9, R15, R31, R34): the whole batch is
 * ONE engine transaction under the caller's environment scope; the scope alone decides what each op may do (the
 * engine's WriteGate judges every op at commit: depth, share widening, read-only bindings, seeded nodes, S5), this
 * class never authorizes by itself. The app binding (`application/open`) selects nothing here (S7).
 *
 * - Pre-checks per op, before anything begins: a known op kind, an id for update / delete, and the payload
 *   (`RuntimeWritePayloadValidator.Check` over the engine description: unknown concept, unknown or relationship member,
 *   value types, required properties). The first failing op gets its status, every other op `failed` "atomic batch
 *   rolled back".
 * - Deletes first find the grants linked to each deleted record (`Links(record, In, record)` of a System reader, kept
 *   when the far node is exactly a `todl.system.ShareGrant`), and the batch runs under
 *   `DeleteGrantsScope.For(callerScope, grantIds)`: a caller scope never writes grants (R31), so the delete of each
 *   such grant is admitted for exactly those ids, in the same transaction as the record's delete.
 * - Updates and deletes fetch their records in the transaction first (`GraphTransaction.Fetch`, R15 / plan O1 option
 *   (a); an external id is fetched as its binding's concept and model, `ExternalIdentity.Parse`), so a write to an
 *   external row is decided against the row the transaction read and carries its version (read-time OCC, spec 11.2).
 *   A record the transaction cannot see, or one of another concept, is `denied` "not authorized for this record" (the
 *   InvisibleNode outcome) and nothing commits.
 * - Creates: `IGraphScope.Placement().Place(concept, cells)` (S6) -> `CreateNode(PublicId, concept, { Owner })`,
 *   `SetProperty` per field, `SetDefault` per placement default the payload left unset (as the engine's Cypher CREATE
 *   does, R91). Updates: `SetProperty` per field. Deletes: `DeleteNode` of each linked grant, then of the record.
 * - Commit. Engine-stored writes are all-or-nothing; external writes are written through their DataSourceConnector at
 *   commit and compensated in reverse when the batch fails (R9; engine 0.3.0 still writes them at commit). A failure
 *   maps through EngineWriteFailure (R34: a version conflict is `conflict` "write conflict"); the op it is attributed
 *   to (the public id an AccessError names, or the row an ExternalWriteFailed reports, equals the op's id or placed id)
 *   gets that status, every other op `failed` "atomic batch rolled back"; an unattributed failure (a CommitError, an
 *   Apply-phase refusal, a CompensationFailed or a failed revert) gives every op that status. An error outside the
 *   table propagates (InternalError).
 * - Success: every op `applied` with its id (a create's placed id).
 */
export class EnvironmentDataWriter
{
    private static readonly RolledBack = 'atomic batch rolled back'
    private static readonly IdRequired = 'id is required'
    private static readonly UnknownOperation = 'unknown operation kind'
    private static readonly NoOwner = ''
    /** The public id an engine AccessError names: "Access denied: op N (Op) on '<id>' (<concept>): <reason>". */
    private static readonly DeniedIdPattern = /^Access denied: op \d+ \(\w+\) on '(.*?)' \(/s
    private static readonly Kinds: ReadonlySet<string> = new Set<string>([AppWriteOpKind.Create, AppWriteOpKind.Update, AppWriteOpKind.Delete])
    private static readonly Invisible: IWriteFailureOutcome = { Status: AppWriteStatus.Denied, Reason: EngineWriteFailure.RecordDenied }

    private catalog: EngineSchemaCatalog | undefined

    public constructor(
        private readonly host: EnvironmentEngineHost,
        private readonly scopes: () => Promise<IGraphScopeSource>,
        private readonly validator: RuntimeWritePayloadValidator)
    {
    }

    public async Apply(context: AccessContext, operations: readonly AppWriteOpDto[]): Promise<AppWriteResultDto>
    {
        if (operations.length === 0) return { results: [] }
        const [engine, snapshot] = await this.host.Settled()
        const catalog = this.CatalogOf(snapshot.Description)
        const planned: IPlannedOp[] = []
        for (let index = 0; index < operations.length; index++)
        {
            const op = EnvironmentDataWriter.Plan(operations[index]!, catalog, this.validator)
            if (!('Kind' in op)) return EnvironmentDataWriter.Refused(operations.length, { Op: index, Outcome: op })
            planned.push(op)
        }
        const grants = await EnvironmentDataWriter.Grants(engine, planned)
        const graphScope = await (await this.scopes()).ScopeFor(context)
        const scope = DeleteGrantsScope.For(graphScope.Scope, new Set(grants.keys()), catalog)
        const transaction = await engine.Begin(scope)
        try
        {
            const ids = new Map<string, number>()
            const placed: string[] = []
            const refusal = await EnvironmentDataWriter.Record(transaction, planned, grants, graphScope.Placement(), snapshot.Catalog.Identity, catalog, ids, placed)
            if (refusal !== undefined) return EnvironmentDataWriter.Refused(operations.length, refusal)
            try
            {
                await transaction.Commit()
            }
            catch (error)
            {
                const outcome = EngineWriteFailure.Map(error)
                if (outcome === undefined) throw error
                return EnvironmentDataWriter.Refused(operations.length, { Op: EnvironmentDataWriter.Attribute(error, snapshot.Catalog.Identity, ids), Outcome: outcome })
            }
            return { results: planned.map((op, index) => ({ status: AppWriteStatus.Applied, id: op.Id ?? placed[index] })) }
        }
        finally
        {
            transaction.dispose()
        }
    }

    /** The pre-checked op, or the outcome refusing it. */
    private static Plan(op: AppWriteOpDto, catalog: EngineSchemaCatalog, validator: RuntimeWritePayloadValidator): IPlannedOp | IWriteFailureOutcome
    {
        if (!EnvironmentDataWriter.Kinds.has(op.op)) return EnvironmentDataWriter.Invalid(EnvironmentDataWriter.UnknownOperation)
        const id = op.id !== undefined && op.id.length > 0 ? op.id : undefined
        if (op.op !== AppWriteOpKind.Create && id === undefined) return EnvironmentDataWriter.Invalid(EnvironmentDataWriter.IdRequired)
        const checked = validator.Check(catalog, op.concept, op.op === AppWriteOpKind.Create, op.op === AppWriteOpKind.Delete ? undefined : op.fields)
        if (checked.Cells === undefined) return EnvironmentDataWriter.Invalid(checked.Reason!)
        // ruling S6: placement decides a create's id; a client id on a create is not used
        return { Kind: op.op, Concept: op.concept, Id: op.op === AppWriteOpKind.Create ? undefined : id, Cells: checked.Cells }
    }

    /** The grants linked to the records the batch deletes (grant id -> the deleted record), read under System. */
    private static async Grants(engine: GraphEngine, planned: readonly IPlannedOp[]): Promise<ReadonlyMap<string, string>>
    {
        const grants = new Map<string, string>()
        const deleted = planned.filter(op => op.Kind === AppWriteOpKind.Delete).map(op => op.Id!)
        if (deleted.length === 0) return grants
        const reader = await engine.BeginRead(AccessScope.System)
        try
        {
            for (const record of deleted)
            {
                for (const link of await reader.Links(record, EdgeDirection.In, SystemNames.Record))
                {
                    if (!grants.has(link.PublicId) && await reader.ConceptOf(link.PublicId) === SystemNames.ShareGrant) grants.set(link.PublicId, record)
                }
            }
        }
        finally
        {
            reader.dispose()
        }
        return grants
    }

    /**
     * Records every op on the transaction; `ids` gets each target public id -> its first op (a create's placed id, a
     * deleted grant -> its record's delete), `placed` each create's placed id at its op index. Returns the refusal of an op that cannot be recorded (a record the transaction
     * cannot see, a placement or recording error the failure table maps).
     */
    private static async Record(transaction: GraphTransaction, planned: readonly IPlannedOp[], grants: ReadonlyMap<string, string>, placement: Cypher.INodePlacement,
        identity: ExternalIdentity, catalog: EngineSchemaCatalog, ids: Map<string, number>, placed: string[]): Promise<IRefusal | undefined>
    {
        const fetched = await transaction.Fetch(planned.filter(op => op.Kind !== AppWriteOpKind.Create).map(op => EnvironmentDataWriter.FetchKey(op.Id!, identity)))
        const deletedGrants = new Set<string>()
        for (let index = 0; index < planned.length; index++)
        {
            const op = planned[index]!
            if (op.Id !== undefined && !ids.has(op.Id)) ids.set(op.Id, index)
            if (op.Kind !== AppWriteOpKind.Create && !EnvironmentDataWriter.IsRecordOf(fetched.get(op.Id!), op.Concept, catalog))
            {
                return { Op: index, Outcome: EnvironmentDataWriter.Invisible }
            }
            try
            {
                EnvironmentDataWriter.RecordOp(transaction, op, index, grants, deletedGrants, placement, ids, placed)
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

    private static RecordOp(transaction: GraphTransaction, op: IPlannedOp, index: number, grants: ReadonlyMap<string, string>, deletedGrants: Set<string>,
        placement: Cypher.INodePlacement, ids: Map<string, number>, placed: string[]): void
    {
        switch (op.Kind)
        {
            case AppWriteOpKind.Create:
            {
                const place = placement.Place(op.Concept, op.Cells)
                placed[index] = place.PublicId
                if (!ids.has(place.PublicId)) ids.set(place.PublicId, index)
                transaction.CreateNode(place.PublicId, op.Concept, place.Owner === EnvironmentDataWriter.NoOwner ? undefined : { Owner: place.Owner })
                for (const [member, value] of op.Cells) transaction.SetProperty(place.PublicId, member, value)
                for (const [member, value] of place.Defaults ?? [])
                {
                    if (!op.Cells.has(member)) transaction.SetDefault(place.PublicId, member, value)
                }
                return
            }
            case AppWriteOpKind.Update:
                for (const [member, value] of op.Cells) transaction.SetProperty(op.Id!, member, value)
                return
            default:
                for (const [grant, record] of grants)
                {
                    if (record !== op.Id || deletedGrants.has(grant)) continue
                    deletedGrants.add(grant)
                    ids.set(grant, index)
                    transaction.DeleteNode(grant)
                }
                transaction.DeleteNode(op.Id!)
        }
    }

    /** True when the transaction sees the record as an instance of `concept` (or a subconcept). */
    private static IsRecordOf(view: IFetchedView | undefined, concept: string, catalog: EngineSchemaCatalog): boolean
    {
        return view !== undefined && catalog.Applicable(view.Concept).has(concept)
    }

    /** An external id is fetched as its binding's concept and model (TODL ids are opaque to the engine); any other by id. */
    private static FetchKey(id: string, identity: ExternalIdentity): IFetchKey
    {
        const parsed = identity.Parse(id)
        return parsed === undefined ? { PublicId: id } : { PublicId: id, Concept: parsed.Binding.Binding.Concept, Owner: parsed.Binding.Model }
    }

    /** The op a commit failure names (see the class remarks), else undefined (unattributed). */
    private static Attribute(error: unknown, identity: ExternalIdentity, ids: ReadonlyMap<string, number>): number | undefined
    {
        const id = EnvironmentDataWriter.FailedId(error, identity)
        return id === undefined ? undefined : ids.get(id)
    }

    private static FailedId(error: unknown, identity: ExternalIdentity): string | undefined
    {
        if (error instanceof AccessError) return EnvironmentDataWriter.DeniedIdPattern.exec(error.message)?.[1]
        if (!(error instanceof ConnectorError) || !(error.cause instanceof ExternalWriteError)) return undefined
        const cause = error.cause
        const failure = cause.Failures[0]
        if (cause.Code !== EngineBridgeErrorCode.ExternalWriteFailed || failure === undefined) return undefined
        return identity.Mint(cause.Binding, String(failure.Key))
    }

    /** Every op's result for a refused batch: the attributed op gets the outcome, the others are rolled back. */
    private static Refused(count: number, refusal: IRefusal): AppWriteResultDto
    {
        const results: AppWriteOpResultDto[] = []
        for (let index = 0; index < count; index++)
        {
            const outcome = refusal.Op === undefined || refusal.Op === index ? refusal.Outcome : { Status: AppWriteStatus.Failed, Reason: EnvironmentDataWriter.RolledBack }
            results.push({ status: outcome.Status, reason: outcome.Reason })
        }
        return { results }
    }

    private static Invalid(reason: string): IWriteFailureOutcome
    {
        return { Status: AppWriteStatus.Invalid, Reason: reason }
    }

    /** The schema catalog of `description`, rebuilt when the environment upgraded. */
    private CatalogOf(description: EngineSchemaCatalog['Description']): EngineSchemaCatalog
    {
        if (this.catalog?.Description !== description) this.catalog = new EngineSchemaCatalog(description)
        return this.catalog
    }
}
