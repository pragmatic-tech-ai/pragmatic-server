import { AccessLevel, LevelCycle, PrivilegeAction } from './security-model-enums.js'
import type { OwnershipRuleDto, PrivilegeDto, RoleConfigDto } from './tenant-types.js'

export interface RecordSharingRowData
{
    concept: string
    scopeText: string
    canShare: boolean
    canAssign: boolean
}

// Read-only projection of what records a role can reach, in plain words. Takes
// no business-unit names, so a level that points at a removed unit still reads
// as generic scope wording.
export class RecordSharingDeriver
{
    private static readonly UserScope = 'only records they own (user)'
    private static readonly BusinessUnitScope = 'records in their business unit'
    private static readonly BusinessUnitAndChildrenScope = 'records in their business unit and children'
    private static readonly OrganizationScope = 'all records in the organization'
    private static readonly Scopes: ReadonlyMap<AccessLevel, string> = new Map<AccessLevel, string>([
        [AccessLevel.User, RecordSharingDeriver.UserScope],
        [AccessLevel.BusinessUnit, RecordSharingDeriver.BusinessUnitScope],
        [AccessLevel.BusinessUnitAndChildren, RecordSharingDeriver.BusinessUnitAndChildrenScope],
        [AccessLevel.Organization, RecordSharingDeriver.OrganizationScope]
    ])
    private static readonly NoDirectAccess = 'no direct record access'
    private static readonly Unset = ''
    private static readonly OwnershipClause = ' (records owned per the ownership rules)'

    public static Rows(role: RoleConfigDto | undefined, ownershipRules: readonly OwnershipRuleDto[]): readonly RecordSharingRowData[]
    {
        if (role === undefined)
        {
            return []
        }
        const byConcept = new Map<string, PrivilegeDto[]>()
        for (const p of role.privileges)
        {
            const list = byConcept.get(p.concept) ?? []
            list.push(p)
            byConcept.set(p.concept, list)
        }
        const owned = new Set<string>(ownershipRules.filter(r => r.owningBusinessUnit.value !== RecordSharingDeriver.Unset).map(r => r.concept))
        const rows: RecordSharingRowData[] = []
        for (const concept of [...byConcept.keys()].sort())
        {
            const privileges = byConcept.get(concept) ?? []
            rows.push({
                concept,
                scopeText: RecordSharingDeriver.ScopeText(privileges) + (owned.has(concept) ? RecordSharingDeriver.OwnershipClause : RecordSharingDeriver.Unset),
                canShare: RecordSharingDeriver.Grants(privileges, PrivilegeAction.Share),
                canAssign: RecordSharingDeriver.Grants(privileges, PrivilegeAction.Assign)
            })
        }
        return rows
    }

    // Unknown levels rank -1, so the > 0 check below excludes them.
    private static Grants(privileges: readonly PrivilegeDto[], action: PrivilegeAction): boolean
    {
        return privileges.some(p => p.action === action && RecordSharingDeriver.Rank(p.level) > 0)
    }

    private static Rank(level: string): number
    {
        return (LevelCycle as readonly string[]).indexOf(level)
    }

    private static ScopeText(privileges: readonly PrivilegeDto[]): string
    {
        let best = 0
        for (const p of privileges)
        {
            if (p.action !== PrivilegeAction.Share && p.action !== PrivilegeAction.Assign)
            {
                best = Math.max(best, RecordSharingDeriver.Rank(p.level))
            }
        }
        return RecordSharingDeriver.Scopes.get(LevelCycle[best]) ?? RecordSharingDeriver.NoDirectAccess
    }
}
