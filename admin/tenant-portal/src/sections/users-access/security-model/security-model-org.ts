import type { BusinessUnitDto, SecurityModelDto, TeamDto, UserPlacementDto } from '../../../tenant-types.js'

// Edits the organization-structure sections (business units, user placement, teams) of a live
// SecurityModelDto and keeps dependent references consistent on removal.
export class SecurityModelOrg
{
    private static readonly BusinessUnitIdPrefix = 'bu-'
    private static readonly TeamIdPrefix = 'team-'
    private static readonly SlugSeparator = '-'
    private static readonly NonSlug = /[^a-z0-9]+/g
    private static readonly EdgeDashes = /^-+|-+$/g
    private static readonly EmptyString = ''
    private static readonly FallbackBusinessUnitSlug = 'business-unit'
    private static readonly FallbackTeamSlug = 'team'

    private readonly model: SecurityModelDto
    private dirty = false

    public constructor(model: SecurityModelDto)
    {
        this.model = model
    }

    public get Dirty(): boolean
    {
        return this.dirty
    }

    public get BusinessUnits(): readonly BusinessUnitDto[]
    {
        return this.model.businessUnits
    }

    public get Teams(): readonly TeamDto[]
    {
        return this.model.teams
    }

    public get Users(): readonly UserPlacementDto[]
    {
        return this.model.users
    }

    // The root unit (the one with no parent); undefined before any unit exists.
    public get RootBusinessUnitId(): string | undefined
    {
        return this.model.businessUnits.find(u => u.parent === undefined)?.id
    }

    // A unit can be removed only when nothing depends on it: not the root,
    // and no child units, teams or placed users reference it.
    public CanRemoveBusinessUnit(id: string): boolean
    {
        const unit = this.model.businessUnits.find(u => u.id === id)
        return unit !== undefined && unit.parent !== undefined
            && !this.model.businessUnits.some(u => u.parent === id)
            && !this.model.teams.some(t => t.businessUnitId === id)
            && !this.model.users.some(p => p.businessUnitId === id)
    }

    public AddBusinessUnit(name: string): string
    {
        const units = this.model.businessUnits
        const id = SecurityModelOrg.NextId(SecurityModelOrg.BusinessUnitIdPrefix, name, SecurityModelOrg.FallbackBusinessUnitSlug, units.map(u => u.id))
        units.push({ id, name })
        this.dirty = true
        return id
    }

    public RenameBusinessUnit(id: string, name: string): void
    {
        const unit = this.model.businessUnits.find(u => u.id === id)
        if (unit === undefined)
        {
            return
        }
        unit.name = name
        this.dirty = true
    }

    public SetBusinessUnitParent(id: string, parent: string | undefined): void
    {
        const unit = this.model.businessUnits.find(u => u.id === id)
        if (unit === undefined || this.UnknownUnit(parent) || this.WouldCycle(id, parent))
        {
            return
        }
        if (parent === undefined)
        {
            delete unit.parent
        }
        else
        {
            unit.parent = parent
        }
        this.dirty = true
    }

    // A no-op unless CanRemoveBusinessUnit, so no reference is ever left dangling.
    public RemoveBusinessUnit(id: string): void
    {
        if (!this.CanRemoveBusinessUnit(id))
        {
            return
        }
        const units = this.model.businessUnits
        units.splice(units.findIndex(u => u.id === id), 1)
        this.dirty = true
    }

    // Places a principal in a unit; one placement per principal, so an
    // existing one is replaced. A blank id or an unknown unit is a no-op.
    public PlaceUser(principalId: string, businessUnitId: string): void
    {
        const id = principalId.trim()
        if (id.length === 0 || this.UnknownUnit(businessUnitId))
        {
            return
        }
        const placement = this.model.users.find(p => p.principalId === id)
        if (placement === undefined)
        {
            this.model.users.push({ principalId: id, businessUnitId })
        }
        else if (placement.businessUnitId !== businessUnitId)
        {
            placement.businessUnitId = businessUnitId
        }
        else
        {
            return
        }
        this.dirty = true
    }

    public UnplaceUser(principalId: string): void
    {
        const users = this.model.users
        const i = users.findIndex(p => p.principalId === principalId)
        if (i < 0)
        {
            return
        }
        users.splice(i, 1)
        this.dirty = true
    }

    // A team always sits in a unit: a new one starts in the root. Refused
    // (undefined) while there is no unit at all.
    public AddTeam(name: string): string | undefined
    {
        const root = this.RootBusinessUnitId
        if (root === undefined)
        {
            return undefined
        }
        const teams = this.model.teams
        const id = SecurityModelOrg.NextId(SecurityModelOrg.TeamIdPrefix, name, SecurityModelOrg.FallbackTeamSlug, teams.map(t => t.id))
        teams.push({ id, name, businessUnitId: root, idpGroups: [], manualMembers: [] })
        this.dirty = true
        return id
    }

    public RenameTeam(id: string, name: string): void
    {
        const team = this.model.teams.find(t => t.id === id)
        if (team === undefined)
        {
            return
        }
        team.name = name
        this.dirty = true
    }

    public SetTeamBusinessUnit(id: string, businessUnitId: string): void
    {
        const team = this.model.teams.find(t => t.id === id)
        if (team === undefined || this.UnknownUnit(businessUnitId) || team.businessUnitId === businessUnitId)
        {
            return
        }
        team.businessUnitId = businessUnitId
        this.dirty = true
    }

    public RemoveTeam(id: string): void
    {
        const teams = this.model.teams
        const i = teams.findIndex(t => t.id === id)
        if (i < 0)
        {
            return
        }
        teams.splice(i, 1)
        for (const assignment of [...this.model.roleAssignments, ...this.model.profileAssignments])
        {
            SecurityModelOrg.Without(assignment.teamIds, id)
        }
        this.dirty = true
    }

    private UnknownUnit(id: string | undefined): boolean
    {
        return id !== undefined && !this.model.businessUnits.some(u => u.id === id)
    }

    private WouldCycle(id: string, parent: string | undefined): boolean
    {
        const seen = new Set<string>()
        let cursor = parent
        while (cursor !== undefined && !seen.has(cursor))
        {
            if (cursor === id)
            {
                return true
            }
            seen.add(cursor)
            const current = cursor
            cursor = this.model.businessUnits.find(u => u.id === current)?.parent
        }
        return false
    }

    private static Without(list: string[] | undefined, id: string): void
    {
        if (list === undefined)
        {
            return
        }
        for (let i = list.length - 1; i >= 0; i--)
        {
            if (list[i] === id)
            {
                list.splice(i, 1)
            }
        }
    }

    private static NextId(prefix: string, name: string, fallback: string, existing: readonly string[]): string
    {
        const slug = name.toLowerCase().replace(SecurityModelOrg.NonSlug, SecurityModelOrg.SlugSeparator)
            .replace(SecurityModelOrg.EdgeDashes, SecurityModelOrg.EmptyString) || fallback
        let n = 1
        while (existing.includes(`${prefix}${slug}${SecurityModelOrg.SlugSeparator}${n}`))
        {
            n++
        }
        return `${prefix}${slug}${SecurityModelOrg.SlugSeparator}${n}`
    }
}
