import { EdgeDirection } from '@pragmatic-tech-ai/graph'
import type { CellValue, GraphTransaction } from '@pragmatic-tech-ai/graph'
import { ShareGrants, ShareRight, ShareSubject, SystemNames, SystemPackage } from '@pragmatic-tech-ai/todl/engine'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteStatus, ErrorCodes, ResponseError, ShareStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ListSharesParams, ListSharesResultDto, ShareGrantDto, ShareParams, ShareResultDto, UnshareParams, UnshareResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IGraphScopeSource, ITenantSecuritySource } from '../engine/access-scope-source.js'
import { EngineWriteFailure } from '../engine/engine-write-failure.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import type { EnvironmentEngineHost } from './environment-engine-host.js'
import { RecordGrants } from './record-grants.js'
import { ShareServiceScope } from './service-scopes.js'

/** What a grant write does to the addressed grant. */
enum GrantWrite
{
    /** Create it, or update it in place (rights replaced, the `record` link restored when missing). */
    Put = 'put',
    /** Delete it. */
    Remove = 'remove',
}

/**
 * Record shares as graph data on the environment engine (ruling S8, amendment A4, R31): a share is one
 * `todl.system.ShareGrant` node, id `ShareGrants.PublicId(record, kind, subject)` (deterministic, so a re-share updates
 * the same grant), Owner `todl.system`, the subject and every ShareRight as properties (`ShareGrants.Properties`), and
 * a `record` link to the shared record. The scope then widens the subject's reads and writes through it (S5 Finish).
 *
 * - Share / Unshare run in ONE transaction under `ShareServiceScope.For(callerScope, {grant id}, record)`, the only scope that
 *   writes grants: the engine confines the transaction's grant writes to that one grant. Inside it the record is read
 *   under the caller's rules (`reader.ConceptOf(id)` must be `params.concept` or a subconcept, else `not-found`); the
 *   caller may share when the tenant security model allows Share on the record (`Allows(principal, Share, view)`) or
 *   one of its own grants on the record holds `share`, else `denied`. Rights are the known ShareRights given (none:
 *   `invalid`); a team subject must be a known team (`invalid`). A re-share replaces the rights and restores the
 *   `record` link of a grant whose record was deleted and recreated. Unshare deletes the grant; no grant linking that
 *   record: `not-found`. Every read is recorded, so a commit racing a change to the record or the grant conflicts.
 * - List reads under `ShareServiceScope.Listing(callerScope, record)`: a record the caller cannot see lists nothing;
 *   otherwise every grant linking it, each as `{ concept: record concept, recordId, subject, rights }` (rights in
 *   ShareRight order). No Share right is needed to list (as before).
 * - An external record (A4) is `invalid` "external records are outside platform security" for Share and Unshare, and
 *   InvalidParams with that reason for List (whose result has no status).
 * - A commit failure maps through EngineWriteFailure: `invalid` stays `invalid`, anything else is `denied` with the
 *   mapped reason ("write conflict" for a conflict); an error outside the table propagates (InternalError).
 */
export class EnvironmentShareService
{
    private static readonly RecordNotFound = 'record not found or not visible'
    private static readonly NotAuthorized = 'not authorized to share this record'
    private static readonly NoRights = 'at least one valid right is required'
    private static readonly UnknownTeam = 'unknown team subject'
    private static readonly UnknownSubjectKind = 'unknown subject kind'
    private static readonly SubjectIdRequired = 'subject id is required'
    /** The protocol's ShareSubjectKind values (equal to ShareSubject's) to the grant subject kind. */
    private static readonly Kinds: ReadonlyMap<string, ShareSubject> = new Map<string, ShareSubject>([[ShareSubjectKind.Principal, ShareSubject.Principal], [ShareSubjectKind.Team, ShareSubject.Team]])
    /** A grant subject kind as the protocol names it. */
    private static readonly WireKinds: ReadonlyMap<ShareSubject, ShareSubjectKind> = new Map<ShareSubject, ShareSubjectKind>([[ShareSubject.Principal, ShareSubjectKind.Principal], [ShareSubject.Team, ShareSubjectKind.Team]])
    private static readonly Rights: ReadonlySet<string> = new Set<string>(ShareGrants.Rights)

    public constructor(
        private readonly host: Pick<EnvironmentEngineHost, 'Settled'>,
        private readonly scopes: () => Promise<IGraphScopeSource>,
        private readonly security: () => Promise<ITenantSecuritySource>)
    {
    }

    public Share(context: AccessContext, params: ShareParams): Promise<ShareResultDto>
    {
        return this.Write(context, params, GrantWrite.Put, EnvironmentShareService.NormalizeRights(params.rights))
    }

    public Unshare(context: AccessContext, params: UnshareParams): Promise<UnshareResultDto>
    {
        return this.Write(context, params, GrantWrite.Remove, [])
    }

    public async List(context: AccessContext, params: ListSharesParams): Promise<ListSharesResultDto>
    {
        const [engine, snapshot] = await this.host.Settled()
        if (RecordGrants.IsExternal(snapshot.Catalog.Identity, params.id))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, InvalidParamsPrefix.Text + RecordGrants.ExternalRecordReason)
        }
        const scope = await (await this.scopes()).ScopeFor(context)
        const reader = await engine.BeginRead(ShareServiceScope.Listing(scope.Scope, params.id, snapshot.SchemaCatalog))
        try
        {
            const view = await RecordGrants.View(reader, params.id, params.concept, snapshot.SchemaCatalog)
            if (view === undefined) return { grants: [] }
            const grants: ShareGrantDto[] = []
            for (const link of await reader.Links(params.id, EdgeDirection.In, SystemNames.Record))
            {
                const grant = await reader.ReadNode(link.PublicId)
                if (grant === undefined || grant.Concept !== SystemNames.ShareGrant) continue
                const kind = EnvironmentShareService.KindOf(grant.Properties.get(SystemNames.SubjectKind))
                const subject = grant.Properties.get(SystemNames.SubjectId)
                // a grant with no known subject kind or no subject id addresses no one: never listed
                if (kind === undefined || typeof subject !== 'string' || subject.length === 0) continue
                const rights = ShareGrants.Rights.filter(right => grant.Properties.get(right) === true)
                grants.push({ concept: view.Concept, recordId: params.id, subject: { kind: EnvironmentShareService.WireKinds.get(kind)!, id: subject }, rights })
            }
            return { grants }
        }
        finally
        {
            reader.dispose()
        }
    }

    /** Share (`Put`) or Unshare (`Remove`) of the grant of `params.id` to `params.subject`; see the class remarks. */
    private async Write(context: AccessContext, params: UnshareParams, write: GrantWrite, rights: readonly ShareRight[]): Promise<ShareResultDto>
    {
        const [engine, snapshot] = await this.host.Settled()
        if (RecordGrants.IsExternal(snapshot.Catalog.Identity, params.id)) return { status: ShareStatus.Invalid, reason: RecordGrants.ExternalRecordReason }
        const kind = EnvironmentShareService.KindOf(params.subject?.kind)
        if (kind === undefined) return { status: ShareStatus.Invalid, reason: EnvironmentShareService.UnknownSubjectKind }
        if (typeof params.subject.id !== 'string' || params.subject.id.length === 0) return { status: ShareStatus.Invalid, reason: EnvironmentShareService.SubjectIdRequired }
        const evaluator = await (await this.security()).EvaluatorForContext(context)
        const scope = await (await this.scopes()).ScopeFor(context)
        const grant = ShareGrants.PublicId(params.id, kind, params.subject.id)
        const transaction = await engine.Begin(ShareServiceScope.For(scope.Scope, new Set([grant]), params.id, snapshot.SchemaCatalog))
        try
        {
            const view = await RecordGrants.View(transaction, params.id, params.concept, snapshot.SchemaCatalog)
            if (view === undefined) return { status: ShareStatus.NotFound, reason: EnvironmentShareService.RecordNotFound }
            const allowed = evaluator.Allows(context.Principal, PrivilegeAction.Share, view)
                || await RecordGrants.Holds(transaction, params.id, RecordGrants.Subjects(context, evaluator), ShareRight.Share)
            if (!allowed) return { status: ShareStatus.Denied, reason: EnvironmentShareService.NotAuthorized }
            if (write === GrantWrite.Put)
            {
                if (rights.length === 0) return { status: ShareStatus.Invalid, reason: EnvironmentShareService.NoRights }
                if (kind === ShareSubject.Team && !evaluator.IsKnownTeam(params.subject.id)) return { status: ShareStatus.Invalid, reason: EnvironmentShareService.UnknownTeam }
            }
            const existing = await transaction.ConceptOf(grant)
            // a node of another concept under a grant id is no grant: never written over
            if (existing !== undefined && existing !== SystemNames.ShareGrant) return { status: ShareStatus.Denied, reason: EnvironmentShareService.NotAuthorized }
            const linked = existing !== undefined && await RecordGrants.Links(transaction, grant, params.id)
            if (write === GrantWrite.Remove)
            {
                if (!linked) return { status: ShareStatus.NotFound }
                transaction.DeleteNode(grant)
            }
            else
            {
                EnvironmentShareService.Put(transaction, grant, params.id, existing !== undefined, linked, ShareGrants.Properties(kind, params.subject.id, rights))
            }
            return await EnvironmentShareService.Commit(transaction)
        }
        finally
        {
            transaction.dispose()
        }
    }

    /** Records the create or in-place update of `grant` (its properties, and its `record` link unless already there). */
    private static Put(transaction: GraphTransaction, grant: string, record: string, exists: boolean, linked: boolean, properties: ReadonlyMap<string, CellValue>): void
    {
        if (!exists) transaction.CreateNode(grant, SystemNames.ShareGrant, { Owner: SystemPackage.Ref.model })
        for (const [member, value] of properties) transaction.SetProperty(grant, member, value)
        if (!linked) transaction.Link(grant, SystemNames.Record, record)
    }

    private static async Commit(transaction: GraphTransaction): Promise<ShareResultDto>
    {
        try
        {
            await transaction.Commit()
        }
        catch (error)
        {
            const outcome = EngineWriteFailure.Map(error)
            if (outcome === undefined) throw error
            return { status: outcome.Status === AppWriteStatus.Invalid ? ShareStatus.Invalid : ShareStatus.Denied, reason: outcome.Reason }
        }
        return { status: ShareStatus.Applied }
    }

    /** The grant subject kind a protocol (or stored) kind value names; undefined for any other value. */
    private static KindOf(value: unknown): ShareSubject | undefined
    {
        return typeof value === 'string' ? EnvironmentShareService.Kinds.get(value) : undefined
    }

    /** The known ShareRights of `rights`, once each, in the order given. */
    private static NormalizeRights(rights: readonly string[] | undefined): ShareRight[]
    {
        const out: ShareRight[] = []
        for (const right of rights ?? [])
        {
            if (EnvironmentShareService.Rights.has(right) && !out.includes(right as ShareRight)) out.push(right as ShareRight)
        }
        return out
    }
}
