import { AccessError, AccessScope, ConnectorError, EdgeDirection, ValueType } from '@pragmatic-tech-ai/graph'
import type { CellValue, Cypher, GraphEngine, GraphReader, GraphTransaction, IFetchKey, IFetchedView } from '@pragmatic-tech-ai/graph'
import { EngineBridgeErrorCode, ExternalWriteError, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import type { ExternalIdentity, IEnvironmentCatalog, IExternalBinding } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto, AppWriteOpResultDto, AppWriteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IGraphScopeSource } from '../engine/access-scope-source.js'
import type { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { EngineWriteFailure } from '../engine/engine-write-failure.js'
import type { IWriteFailureOutcome } from '../engine/engine-write-failure.js'
import type { IConceptType, RuntimeWritePayloadValidator } from '../runtime-write-payload-validator.js'
import type { EnvironmentEngineHost } from './environment-engine-host.js'
import { DeleteGrantsScope } from './service-scopes.js'

/**
 * One pre-checked data/write op: its kind, target id (an update's or delete's id; a create's client id on an engine
 * concept, else placed later) and engine cells.
 */
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

/** What a System reader found before the transaction began: the grants of deleted records and the create ids taken. */
interface IPreRead
{
    /** Grant id -> the deleted record it links. */
    readonly Grants: ReadonlyMap<string, string>
    /** Client ids of engine creates that already name a node. */
    readonly Taken: ReadonlySet<string>
}

/**
 * The batch as recorded on the transaction: which data/write op each recorded engine op belongs to (the index an
 * engine AccessError names), the op of each target public id (its first), and each create's id.
 */
class RecordedBatch
{
    public readonly Placed: (string | undefined)[] = []
    private readonly opOfBatch: number[] = []
    private readonly opOfId = new Map<string, number>()

    public constructor(private readonly transaction: GraphTransaction)
    {
    }

    public CreateNode(op: number, publicId: string, concept: string, owner: string | undefined): void
    {
        this.Target(op, publicId)
        this.Placed[op] = publicId
        this.transaction.CreateNode(publicId, concept, owner === undefined ? undefined : { Owner: owner })
        this.opOfBatch.push(op)
    }

    public SetProperty(op: number, publicId: string, member: string, value: CellValue): void
    {
        this.transaction.SetProperty(publicId, member, value)
        this.opOfBatch.push(op)
    }

    public SetDefault(op: number, publicId: string, member: string, value: CellValue): void
    {
        this.transaction.SetDefault(publicId, member, value)
        this.opOfBatch.push(op)
    }

    public DeleteNode(op: number, publicId: string): void
    {
        this.Target(op, publicId)
        this.transaction.DeleteNode(publicId)
        this.opOfBatch.push(op)
    }

    /** Records `publicId` as `op`'s target when no earlier op targets it. */
    public Target(op: number, publicId: string): void
    {
        if (!this.opOfId.has(publicId)) this.opOfId.set(publicId, op)
    }

    /** The data/write op of the recorded engine op at `index`, else the first op targeting `publicId`. */
    public OpOf(index: number | undefined, publicId: string | undefined): number | undefined
    {
        const byIndex = index === undefined ? undefined : this.opOfBatch[index]
        if (byIndex !== undefined) return byIndex
        return publicId === undefined ? undefined : this.opOfId.get(publicId)
    }
}

/**
 * `data/write` on the environment engine (ruling S10, owner answer Q3, rulings R9, R15, R31, R34, R38-R40): the whole
 * batch is ONE engine transaction under the caller's environment scope; the scope alone decides what each op may do (the
 * engine's WriteGate judges every op at commit: depth, share widening, read-only bindings, seeded nodes, S5), this
 * class never authorizes by itself. The app binding (`application/open`) selects nothing here (S7).
 *
 * - Pre-checks per op, before anything begins: a known op kind, an id for update / delete, and the payload
 *   (`RuntimeWritePayloadValidator.Check` over the engine description, required fields from the TODL type, R39). A
 *   create's client id (R38) is the engine node's public id, or for an external binding the value of its id member
 *   (the source row is keyed by it; a payload id member that differs, or a binding mapping no id member, is
 *   `invalid`); two creates with one client id are `invalid` "duplicate id in batch". The first failing op gets its
 *   status, every other op `failed` "atomic batch rolled back".
 * - A System reader then finds the grants linked to each deleted record (`Links(record, In, record)`, kept when the far
 *   node is exactly a `todl.system.ShareGrant`) and the engine create ids already taken (`denied` "not authorized for
 *   this record", as before: a create cannot overwrite). The batch runs under `DeleteGrantsScope.For(callerScope,
 *   grantIds, catalog, deletedIds)`: a caller scope never writes grants (R31), so the delete of each pre-read grant is
 *   admitted for exactly those ids, and every grant linking a deleted record is visible to the transaction whoever
 *   it is addressed to. Inside the transaction each deleted record's grants are read again: one the pre-read missed
 *   (linked since) refuses the batch as `conflict` "write conflict" and nothing is deleted (R40); the re-read is
 *   recorded, so OCC refuses a commit racing a grant linked after it (ConflictError -> `conflict`).
 * - Updates and deletes fetch their records in the transaction first (`GraphTransaction.Fetch`, R15 / plan O1 option
 *   (a); an external id is fetched as its binding's concept and model, `ExternalIdentity.Parse`), so a write to an
 *   external row is decided against the row the transaction read and carries its version (read-time OCC, spec 11.2).
 *   A record the transaction cannot see, or one of another concept, is `denied` "not authorized for this record" (the
 *   InvisibleNode outcome; R41: an Update-only share on an unreadable record no longer authorizes) and nothing commits.
 * - Creates: `IGraphScope.Placement().Place(concept, cells)` (S6; the client id replaces an engine node's placed id)
 *   -> `CreateNode(PublicId, concept, { Owner })`, `SetProperty` per field, `SetDefault` per placement default the
 *   payload left unset (as the engine's Cypher CREATE does, R91). Updates: `SetProperty` per field. Deletes:
 *   `DeleteNode` of each linked grant, then of the record.
 * - Commit. Engine-stored writes are all-or-nothing; external writes are written through their DataSourceConnector at
 *   commit and compensated in reverse when the batch fails (R9; engine 0.3.0 still writes them at commit). A failure
 *   maps through EngineWriteFailure (R34: a version conflict is `conflict` "write conflict"); the op it is attributed
 *   to gets that status, every other op `failed` "atomic batch rolled back". Attribution: an AccessError names the
 *   recorded engine op index (mapped to its data/write op) and the public id (the fallback); an ExternalWriteFailed
 *   names the row (`ExternalIdentity.Mint(binding, key)`). An unattributed failure (a CommitError, an Apply-phase
 *   refusal, a CompensationFailed or a failed revert) gives every op that status. An error outside the table
 *   propagates (InternalError).
 * - Success: every op `applied` with its id (a create's placed or client id).
 */
export class EnvironmentDataWriter
{
    private static readonly RolledBack = 'atomic batch rolled back'
    private static readonly IdRequired = 'id is required'
    private static readonly IdMismatch = 'id does not match the record\'s id field'
    private static readonly UnknownOperation = 'unknown operation kind'
    private static readonly NoOwner = ''
    private static readonly NoIdMember = 'the binding has no id field to take the id'
    private static readonly DuplicateId = 'duplicate id in batch'
    /** An engine AccessError: "Access denied: op N (Op) on '<id>' (<concept>): <reason>" (N the recorded op index). */
    private static readonly DeniedPattern = /^Access denied: op (\d+) \(\w+\) on '(.*?)' \(/s
    private static readonly NumericPattern = /^-?\d+(\.\d+)?$/
    private static readonly Kinds: ReadonlySet<string> = new Set<string>([AppWriteOpKind.Create, AppWriteOpKind.Update, AppWriteOpKind.Delete])
    private static readonly Invisible: IWriteFailureOutcome = { Status: AppWriteStatus.Denied, Reason: EngineWriteFailure.RecordDenied }

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
        const catalog = snapshot.SchemaCatalog
        const planned: IPlannedOp[] = []
        const clientIds = new Set<string>()
        for (let index = 0; index < operations.length; index++)
        {
            const op = this.Plan(operations[index]!, catalog, snapshot.Catalog, clientIds)
            if (!('Kind' in op)) return EnvironmentDataWriter.Refused(operations.length, { Op: index, Outcome: op })
            planned.push(op)
        }
        const pre = await EnvironmentDataWriter.PreRead(engine, planned)
        const taken = planned.findIndex(op => op.Kind === AppWriteOpKind.Create && op.Id !== undefined && pre.Taken.has(op.Id))
        if (taken >= 0) return EnvironmentDataWriter.Refused(operations.length, { Op: taken, Outcome: EnvironmentDataWriter.Invisible })
        const graphScope = await (await this.scopes()).ScopeFor(context)
        const deleted = new Set(planned.filter(op => op.Kind === AppWriteOpKind.Delete).map(op => op.Id!))
        const scope = DeleteGrantsScope.For(graphScope.Scope, new Set(pre.Grants.keys()), catalog, deleted)
        const transaction = await engine.Begin(scope)
        try
        {
            const batch = new RecordedBatch(transaction)
            const refusal = await EnvironmentDataWriter.Record(transaction, batch, planned, pre.Grants, graphScope.Placement(), snapshot.Catalog.Identity, catalog)
            if (refusal !== undefined) return EnvironmentDataWriter.Refused(operations.length, refusal)
            try
            {
                await transaction.Commit()
            }
            catch (error)
            {
                const outcome = EngineWriteFailure.Map(error)
                if (outcome === undefined) throw error
                return EnvironmentDataWriter.Refused(operations.length, { Op: EnvironmentDataWriter.Attribute(error, snapshot.Catalog.Identity, batch), Outcome: outcome })
            }
            return { results: planned.map((op, index) => ({ status: AppWriteStatus.Applied, id: op.Id ?? batch.Placed[index] })) }
        }
        finally
        {
            transaction.dispose()
        }
    }

    /** The pre-checked op, or the outcome refusing it; `clientIds` collects the batch's create client ids. */
    private Plan(op: AppWriteOpDto, catalog: EngineSchemaCatalog, environment: IEnvironmentCatalog, clientIds: Set<string>): IPlannedOp | IWriteFailureOutcome
    {
        if (!EnvironmentDataWriter.Kinds.has(op.op)) return EnvironmentDataWriter.Invalid(EnvironmentDataWriter.UnknownOperation)
        const id = op.id !== undefined && op.id.length > 0 ? op.id : undefined
        if (op.op !== AppWriteOpKind.Create && id === undefined) return EnvironmentDataWriter.Invalid(EnvironmentDataWriter.IdRequired)
        const create = op.op === AppWriteOpKind.Create
        if (create && id !== undefined)
        {
            if (clientIds.has(id)) return EnvironmentDataWriter.Invalid(EnvironmentDataWriter.DuplicateId)
            clientIds.add(id)
        }
        const binding = create ? environment.Identity.CreateTarget(op.concept) : undefined
        let fields = op.op === AppWriteOpKind.Delete ? undefined : op.fields
        if (create && id !== undefined && binding !== undefined)
        {
            const keyed = EnvironmentDataWriter.KeyedFields(environment.Identity, binding, fields, id)
            if (typeof keyed === 'string') return EnvironmentDataWriter.Invalid(keyed)
            fields = keyed
        }
        const type = environment.Snapshot.getType(op.concept) as IConceptType | undefined
        const checked = this.validator.Check(catalog, type, op.concept, create, fields)
        if (checked.Cells === undefined) return EnvironmentDataWriter.Invalid(checked.Reason!)
        // ruling R38: a client id on an engine create is its public id; on an external one it keyed the fields above
        return { Kind: op.op, Concept: op.concept, Id: create && binding !== undefined ? undefined : id, Cells: checked.Cells }
    }

    /**
     * `fields` with the external binding's id member set to the client id (numeric for a numeric id member, so the
     * validator converts it); else the reason refusing the client id: the binding maps no id member (or maps one the
     * concept does not declare as a property), or the payload already gives it a different value.
     */
    private static KeyedFields(identity: ExternalIdentity, binding: IExternalBinding, fields: Record<string, unknown> | undefined, id: string): Record<string, unknown> | string
    {
        const member = identity.IdMemberName(binding)
        const type = identity.IdMemberType(binding)
        // no member maps the source key, or the one that does is not a property of the concept
        if (member === undefined || type === undefined) return EnvironmentDataWriter.NoIdMember
        const numeric = (type === ValueType.Int64 || type === ValueType.Float64) && EnvironmentDataWriter.NumericPattern.test(id)
        const value: unknown = numeric ? Number(id) : id
        const given = fields?.[member]
        if (given !== undefined && given !== null && String(given) !== String(value)) return EnvironmentDataWriter.IdMismatch
        return { ...(fields ?? {}), [member]: value }
    }

    /** What a System reader sees before the transaction: the deleted records' grants and the engine create ids taken. */
    private static async PreRead(engine: GraphEngine, planned: readonly IPlannedOp[]): Promise<IPreRead>
    {
        const grants = new Map<string, string>()
        const taken = new Set<string>()
        const deleted = planned.filter(op => op.Kind === AppWriteOpKind.Delete).map(op => op.Id!)
        const created = planned.filter(op => op.Kind === AppWriteOpKind.Create && op.Id !== undefined).map(op => op.Id!)
        if (deleted.length === 0 && created.length === 0) return { Grants: grants, Taken: taken }
        const reader = await engine.BeginRead(AccessScope.System)
        try
        {
            for (const record of deleted)
            {
                for (const grant of await EnvironmentDataWriter.GrantsOf(reader, record))
                {
                    if (!grants.has(grant)) grants.set(grant, record)
                }
            }
            for (const id of created)
            {
                if (await reader.ConceptOf(id) !== undefined) taken.add(id)
            }
        }
        finally
        {
            reader.dispose()
        }
        return { Grants: grants, Taken: taken }
    }

    /** The ShareGrant nodes `reader` sees linking `record` (a lookalike `record` relationship is not a grant). */
    private static async GrantsOf(reader: GraphReader, record: string): Promise<string[]>
    {
        const grants: string[] = []
        for (const link of await reader.Links(record, EdgeDirection.In, SystemNames.Record))
        {
            if (await reader.ConceptOf(link.PublicId) === SystemNames.ShareGrant) grants.push(link.PublicId)
        }
        return grants
    }

    /**
     * Records every op on the transaction through `batch`. Returns the refusal of an op that cannot be recorded (a
     * record the transaction cannot see, a grant linked since the pre-read, a placement or recording error the
     * failure table maps).
     */
    private static async Record(transaction: GraphTransaction, batch: RecordedBatch, planned: readonly IPlannedOp[], grants: ReadonlyMap<string, string>,
        placement: Cypher.INodePlacement, identity: ExternalIdentity, catalog: EngineSchemaCatalog): Promise<IRefusal | undefined>
    {
        const fetched = await transaction.Fetch(planned.filter(op => op.Kind !== AppWriteOpKind.Create).map(op => EnvironmentDataWriter.FetchKey(op.Id!, identity)))
        const deletedGrants = new Set<string>()
        for (let index = 0; index < planned.length; index++)
        {
            const op = planned[index]!
            if (op.Kind !== AppWriteOpKind.Create && !EnvironmentDataWriter.IsRecordOf(fetched.get(op.Id!), op.Concept, catalog))
            {
                return { Op: index, Outcome: EnvironmentDataWriter.Invisible }
            }
            if (op.Kind === AppWriteOpKind.Delete && (await EnvironmentDataWriter.GrantsOf(transaction, op.Id!)).some(grant => !grants.has(grant)))
            {
                return { Op: index, Outcome: EngineWriteFailure.Conflict }
            }
            try
            {
                EnvironmentDataWriter.RecordOp(batch, op, index, grants, deletedGrants, placement)
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

    private static RecordOp(batch: RecordedBatch, op: IPlannedOp, index: number, grants: ReadonlyMap<string, string>, deletedGrants: Set<string>, placement: Cypher.INodePlacement): void
    {
        switch (op.Kind)
        {
            case AppWriteOpKind.Create:
            {
                const place = placement.Place(op.Concept, op.Cells)
                const id = op.Id ?? place.PublicId
                batch.CreateNode(index, id, op.Concept, place.Owner === EnvironmentDataWriter.NoOwner ? undefined : place.Owner)
                for (const [member, value] of op.Cells) batch.SetProperty(index, id, member, value)
                for (const [member, value] of place.Defaults ?? [])
                {
                    if (!op.Cells.has(member)) batch.SetDefault(index, id, member, value)
                }
                return
            }
            case AppWriteOpKind.Update:
                batch.Target(index, op.Id!)
                for (const [member, value] of op.Cells) batch.SetProperty(index, op.Id!, member, value)
                return
            default:
                for (const [grant, record] of grants)
                {
                    if (record !== op.Id || deletedGrants.has(grant)) continue
                    deletedGrants.add(grant)
                    batch.DeleteNode(index, grant)
                }
                batch.DeleteNode(index, op.Id!)
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
    private static Attribute(error: unknown, identity: ExternalIdentity, batch: RecordedBatch): number | undefined
    {
        if (error instanceof AccessError)
        {
            const denied = EnvironmentDataWriter.DeniedPattern.exec(error.message)
            return denied === null ? undefined : batch.OpOf(Number(denied[1]), denied[2])
        }
        if (!(error instanceof ConnectorError) || !(error.cause instanceof ExternalWriteError)) return undefined
        const cause = error.cause
        const failure = cause.Failures[0]
        if (cause.Code !== EngineBridgeErrorCode.ExternalWriteFailed || failure === undefined || failure.Key === null) return undefined
        // the placed id was minted from the id member's text (EnvironmentNodePlacement: String of a bigint / number / string)
        return batch.OpOf(undefined, identity.Mint(cause.Binding, String(failure.Key)))
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
}
