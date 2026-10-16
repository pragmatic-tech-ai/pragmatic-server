import type { PrivilegeAction, Principal } from '@pragmatic-tech-ai/todl-identity'
import type { IMembership } from '@pragmatic-tech-ai/todl-identity-engine'
import { ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ShareStore } from './share-store.js'

/** Per-request view of the grants that apply to one principal (its own + its teams'), indexed for O(1) checks. */
export class ShareGrantIndex
{
    private static readonly KeySeparator = '\u0000'

    private constructor(
        private readonly byRecord: ReadonlyMap<string, ReadonlySet<string>>,
        private readonly byConcept: ReadonlyMap<string, ReadonlySet<string>>)
    {
    }

    public static Empty(): ShareGrantIndex
    {
        return new ShareGrantIndex(new Map(), new Map())
    }

    public static async For(store: ShareStore, principal: Principal, membership: IMembership): Promise<ShareGrantIndex>
    {
        const teams = new Set<string>(membership.teams)
        const byRecord = new Map<string, Set<string>>()
        const byConcept = new Map<string, Set<string>>()
        for (const grant of await store.LoadAll())
        {
            const applies = grant.subject.kind === ShareSubjectKind.Principal
                ? grant.subject.id === principal.Id
                : teams.has(grant.subject.id)
            if (!applies)
            {
                continue
            }
            ShareGrantIndex.AddAll(byRecord, ShareGrantIndex.RecordKey(grant.concept, grant.recordId), grant.rights)
            ShareGrantIndex.AddAll(byConcept, grant.concept, grant.rights)
        }
        return new ShareGrantIndex(byRecord, byConcept)
    }

    public AllowsRecord(concept: string, recordId: string | undefined, action: PrivilegeAction): boolean
    {
        if (recordId === undefined || recordId.length === 0)
        {
            return false
        }
        const rights = this.byRecord.get(ShareGrantIndex.RecordKey(concept, recordId))
        return rights !== undefined && rights.has(action)
    }

    public HasAnyGrant(concept: string, action: PrivilegeAction): boolean
    {
        const rights = this.byConcept.get(concept)
        return rights !== undefined && rights.has(action)
    }

    public IsEmpty(): boolean
    {
        return this.byRecord.size === 0
    }

    private static AddAll(map: Map<string, Set<string>>, key: string, rights: readonly string[]): void
    {
        let set = map.get(key)
        if (set === undefined)
        {
            set = new Set<string>()
            map.set(key, set)
        }
        for (const right of rights)
        {
            set.add(right)
        }
    }

    private static RecordKey(concept: string, recordId: string): string
    {
        return concept + ShareGrantIndex.KeySeparator + recordId
    }
}
