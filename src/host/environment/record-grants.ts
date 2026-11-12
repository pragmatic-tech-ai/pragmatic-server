import { AccessDefault, AccessScope, And, EdgeDirection, IdIn } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, GraphReader } from '@pragmatic-tech-ai/graph'
import { ShareGrants, ShareSubject, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import type { ExternalIdentity, IShareSubjects, ShareRight } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { TenantSecurityModel, Tier1Grants } from '@pragmatic-tech-ai/todl-identity-engine'
import { EngineInstanceView } from '../engine/engine-instance-view.js'
import type { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'

/**
 * The record reads the share and assign services share (rulings S8, S9, amendment A4): the record as the caller's
 * reader sees it, whether one of the caller's grants on it holds a right, and the external-record refusal.
 */
export class RecordGrants
{
    /** A4: shares and assign are platform security, which external (connector) records are outside of. */
    public static readonly ExternalRecordReason = 'external records are outside platform security'

    /** True when `id` is an external record's public id (minted by an external binding). */
    public static IsExternal(identity: ExternalIdentity, id: string): boolean
    {
        return identity.Parse(id) !== undefined
    }

    /** Who the caller is for share purposes: its principal and its active teams in the environment setting. */
    public static Subjects(context: AccessContext, model: TenantSecurityModel): IShareSubjects
    {
        return { PrincipalId: context.Principal.Id, Teams: model.Membership().Resolve(context.Principal).teams }
    }

    /**
     * True when the caller's tier-1 privilege `action` covers record `id` of `concept` at the caller's depth: a read under
     * `Rows[concept] = And(grants.Covers(action, concept), IdIn{id})` (Default Deny) returns it. `concept` is the record's
     * own concept, so the privilege is judged on it as the scope compiler judges each record (a share does not count).
     */
    public static async Covers(engine: GraphEngine, grants: Tier1Grants, action: PrivilegeAction, concept: string, id: string): Promise<boolean>
    {
        const rows = new Map([[concept, new And([grants.Covers(action, concept), new IdIn(new Set([id]))])]])
        const reader = await engine.BeginRead(AccessScope.Build({ Default: AccessDefault.Deny, Rows: rows }))
        try
        {
            return (await reader.ConceptOf(id)) === concept
        }
        finally
        {
            reader.dispose()
        }
    }

    /**
     * The record `id` as `reader` sees it when its concept is `concept` or a subconcept (an aspect the record carries
     * does not qualify); undefined when it does not exist, is not visible or is of another concept (the services answer
     * `not-found` for all three).
     */
    public static async View(reader: GraphReader, id: string, concept: string, catalog: EngineSchemaCatalog): Promise<EngineInstanceView | undefined>
    {
        const actual = await reader.ConceptOf(id)
        if (actual === undefined || !catalog.IsConceptOrSubtype(actual, concept)) return undefined
        return EngineInstanceView.Of(reader, id)
    }

    /**
     * True when a grant `reader` sees, addressed to one of `subjects` (`ShareGrants.PublicId(record, kind, id)` for
     * the principal and each team), is exactly a `todl.system.ShareGrant`, names that subject, links `record` and holds
     * `right`.
     */
    public static async Holds(reader: GraphReader, record: string, subjects: IShareSubjects, right: ShareRight): Promise<boolean>
    {
        const addressed: (readonly [ShareSubject, string])[] = [[ShareSubject.Principal, subjects.PrincipalId], ...subjects.Teams.map(team => [ShareSubject.Team, team] as const)]
        for (const [kind, subject] of addressed)
        {
            if (subject.length === 0) continue
            const id = ShareGrants.PublicId(record, kind, subject)
            const grant = await reader.ReadNode(id)
            if (grant === undefined || grant.Concept !== SystemNames.ShareGrant) continue
            if (grant.Properties.get(SystemNames.SubjectKind) !== kind || grant.Properties.get(SystemNames.SubjectId) !== subject) continue
            if (grant.Properties.get(right) !== true) continue
            if (await RecordGrants.Links(reader, id, record)) return true
        }
        return false
    }

    /** True when grant `grant` links `record` as its record. */
    public static async Links(reader: GraphReader, grant: string, record: string): Promise<boolean>
    {
        return (await reader.Links(grant, EdgeDirection.Out, SystemNames.Record)).some(link => link.PublicId === record)
    }
}
