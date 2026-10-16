import type { IInstanceView } from '@pragmatic-tech-ai/todl'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { Principal } from '@pragmatic-tech-ai/todl-identity'
import type { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { ShareStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ShareParams, ShareResultDto, UnshareParams, UnshareResultDto, ListSharesParams, ListSharesResultDto, ShareGrantDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IWriteTargetSource } from '../write-target-source.js'
import type { ShareStore } from './share-store.js'
import type { ShareGrantIndex } from './share-grant-index.js'
import type { ConceptIdFields } from './concept-id-fields.js'
import { RecordKey } from './record-keyed-view.js'

/** Executes one record-sharing op against the per-app store, authorizing the actor's Share right on the target record. */
export class ShareService
{
    private static readonly RecordNotFound = 'record not found or not visible'
    private static readonly NotAuthorized = 'not authorized to share this record'
    private static readonly NoRights = 'at least one valid right is required'
    private static readonly UnknownTeam = 'unknown team subject'
    private static readonly ValidRights: readonly PrivilegeAction[] = [PrivilegeAction.Read, PrivilegeAction.Update, PrivilegeAction.Delete, PrivilegeAction.Assign, PrivilegeAction.Share]

    constructor(
        private readonly store: ShareStore,
        private readonly index: ShareGrantIndex,
        private readonly evaluator: AccessDepthEvaluator,
        private readonly principal: Principal,
        private readonly target: IWriteTargetSource,
        private readonly idFields: ConceptIdFields)
    {
    }

    public async Share(params: ShareParams): Promise<ShareResultDto>
    {
        const view = await this.target.Fetch(params.concept, params.id)
        if (view === undefined)
        {
            return { status: ShareStatus.NotFound, reason: ShareService.RecordNotFound }
        }
        if (!this.CanShare(view.Concept, view, params.id))
        {
            return { status: ShareStatus.Denied, reason: ShareService.NotAuthorized }
        }
        const rights = ShareService.NormalizeRights(params.rights)
        if (rights.length === 0)
        {
            return { status: ShareStatus.Invalid, reason: ShareService.NoRights }
        }
        if (params.subject.kind === ShareSubjectKind.Team && !this.evaluator.IsKnownTeam(params.subject.id))
        {
            return { status: ShareStatus.Invalid, reason: ShareService.UnknownTeam }
        }
        const recordId = this.RecordId(view.Concept, view) ?? params.id
        await this.store.Grant({ concept: view.Concept, recordId, subject: params.subject, rights })
        return { status: ShareStatus.Applied }
    }

    public async Unshare(params: UnshareParams): Promise<UnshareResultDto>
    {
        const view = await this.target.Fetch(params.concept, params.id)
        if (view === undefined)
        {
            return { status: ShareStatus.NotFound, reason: ShareService.RecordNotFound }
        }
        if (!this.CanShare(view.Concept, view, params.id))
        {
            return { status: ShareStatus.Denied, reason: ShareService.NotAuthorized }
        }
        const recordId = this.RecordId(view.Concept, view) ?? params.id
        const removed = await this.store.Revoke(view.Concept, recordId, params.subject.kind, params.subject.id)
        return removed ? { status: ShareStatus.Applied } : { status: ShareStatus.NotFound }
    }

    public async List(params: ListSharesParams): Promise<ListSharesResultDto>
    {
        const view = await this.target.Fetch(params.concept, params.id)
        if (view === undefined)
        {
            return { grants: [] }
        }
        const recordId = this.RecordId(view.Concept, view) ?? params.id
        const grants = await this.store.ListForRecord(view.Concept, recordId)
        return { grants: [...grants] as ShareGrantDto[] }
    }

    private CanShare(concept: string, view: IInstanceView, fallbackId: string): boolean
    {
        if (this.evaluator.Allows(this.principal, PrivilegeAction.Share, view))
        {
            return true
        }
        const recordId = this.RecordId(concept, view) ?? fallbackId
        return this.index.AllowsRecord(concept, recordId, PrivilegeAction.Share)
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

    private static NormalizeRights(rights: readonly string[]): PrivilegeAction[]
    {
        const valid = new Set<string>(ShareService.ValidRights)
        const out: PrivilegeAction[] = []
        for (const right of rights)
        {
            if (valid.has(right) && !out.includes(right as PrivilegeAction))
            {
                out.push(right as PrivilegeAction)
            }
        }
        return out
    }
}
