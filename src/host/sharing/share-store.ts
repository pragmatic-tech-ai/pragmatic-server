import type { IDocumentSession } from '@pragmatic-tech-ai/todl-connectors-host'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ShareGrantDto, ShareSubjectDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/** Per-app persistence of record-share grants in a reserved document-store collection. One document per grant. */
export class ShareStore
{
    private static readonly ValidShareRights: readonly PrivilegeAction[] = [PrivilegeAction.Read, PrivilegeAction.Update, PrivilegeAction.Delete, PrivilegeAction.Assign, PrivilegeAction.Share]
    private static readonly Collection = '__shares'
    private static readonly IdField = 'grantKey'
    private static readonly KeySeparator = '\u0000'
    private static readonly SubjectSeparator = ':'
    private static readonly ConceptKey = 'concept'
    private static readonly RecordIdKey = 'recordId'
    private static readonly SubjectKey = 'subject'
    private static readonly KindKey = 'kind'
    private static readonly SubjectIdKey = 'id'
    private static readonly RightsKey = 'rights'

    constructor(private readonly session: IDocumentSession)
    {
    }

    public async Grant(grant: ShareGrantDto): Promise<void>
    {
        const key = ShareStore.KeyFor(grant.concept, grant.recordId, grant.subject.kind, grant.subject.id)
        await this.session.Upsert(ShareStore.Collection, ShareStore.IdField, key, ShareStore.Serialize(grant, key))
    }

    public Revoke(concept: string, recordId: string, kind: ShareSubjectKind, subjectId: string): Promise<boolean>
    {
        return this.session.Delete(ShareStore.Collection, ShareStore.IdField, ShareStore.KeyFor(concept, recordId, kind, subjectId))
    }

    public async ListForRecord(concept: string, recordId: string): Promise<readonly ShareGrantDto[]>
    {
        const all = await this.LoadAll()
        return all.filter(g => g.concept === concept && g.recordId === recordId)
    }

    public async RevokeAllForRecord(concept: string, recordId: string): Promise<number>
    {
        const grants = await this.ListForRecord(concept, recordId)
        for (const grant of grants)
        {
            await this.Revoke(grant.concept, grant.recordId, grant.subject.kind, grant.subject.id)
        }
        return grants.length
    }

    public async LoadAll(): Promise<readonly ShareGrantDto[]>
    {
        const rows = await this.session.Find(ShareStore.Collection, {})
        const grants: ShareGrantDto[] = []
        for (const row of rows)
        {
            const grant = ShareStore.Deserialize(row)
            if (grant !== undefined)
            {
                grants.push(grant)
            }
        }
        return grants
    }

    private static KeyFor(concept: string, recordId: string, kind: ShareSubjectKind, subjectId: string): string
    {
        return concept + ShareStore.KeySeparator + recordId + ShareStore.KeySeparator + kind + ShareStore.SubjectSeparator + subjectId
    }

    private static Serialize(grant: ShareGrantDto, key: string): Record<string, unknown>
    {
        return {
            [ShareStore.IdField]: key,
            [ShareStore.ConceptKey]: grant.concept,
            [ShareStore.RecordIdKey]: grant.recordId,
            [ShareStore.SubjectKey]: { [ShareStore.KindKey]: grant.subject.kind, [ShareStore.SubjectIdKey]: grant.subject.id },
            [ShareStore.RightsKey]: [...grant.rights],
        }
    }

    /** Fail-closed: a row that is not a well-formed grant with at least one valid right is ignored (never widens access). */
    private static Deserialize(row: Record<string, unknown>): ShareGrantDto | undefined
    {
        const concept = row[ShareStore.ConceptKey]
        const recordId = row[ShareStore.RecordIdKey]
        const subject = row[ShareStore.SubjectKey]
        const rights = row[ShareStore.RightsKey]
        if (typeof concept !== 'string' || concept.length === 0 || typeof recordId !== 'string' || recordId.length === 0)
        {
            return undefined
        }
        const parsedSubject = ShareStore.ParseSubject(subject)
        if (parsedSubject === undefined)
        {
            return undefined
        }
        const parsedRights = ShareStore.ParseRights(rights)
        if (parsedRights.length === 0)
        {
            return undefined
        }
        return { concept, recordId, subject: parsedSubject, rights: parsedRights }
    }

    private static ParseSubject(value: unknown): ShareSubjectDto | undefined
    {
        if (typeof value !== 'object' || value === null)
        {
            return undefined
        }
        const record = value as Record<string, unknown>
        const kind = record[ShareStore.KindKey]
        const id = record[ShareStore.SubjectIdKey]
        if ((kind !== ShareSubjectKind.Principal && kind !== ShareSubjectKind.Team) || typeof id !== 'string' || id.length === 0)
        {
            return undefined
        }
        return { kind, id }
    }

    private static ParseRights(value: unknown): string[]
    {
        if (!Array.isArray(value))
        {
            return []
        }
        const known = new Set<string>(ShareStore.ValidShareRights)
        const out: string[] = []
        for (const right of value)
        {
            if (typeof right === 'string' && known.has(right) && !out.includes(right))
            {
                out.push(right)
            }
        }
        return out
    }
}
