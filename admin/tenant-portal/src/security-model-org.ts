import type { BusinessUnitDto, OwnershipSourceDto, SecurityModelDto, TeamDto } from './tenant-types.js'

// Edits the organization-structure sections (business units, teams) of a live
// SecurityModelDto and keeps every dependent reference consistent on removal.
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

    public RemoveBusinessUnit(id: string): void
    {
        const units = this.model.businessUnits
        const i = units.findIndex(u => u.id === id)
        if (i < 0)
        {
            return
        }
        units.splice(i, 1)
        for (const unit of units)
        {
            if (unit.parent === id)
            {
                delete unit.parent
            }
        }
        for (const team of this.model.teams)
        {
            if (team.owningBusinessUnit === id)
            {
                delete team.owningBusinessUnit
            }
        }
        for (const rule of this.model.membership.claimsMapping)
        {
            if (rule.homeBusinessUnit === id)
            {
                delete rule.homeBusinessUnit
            }
        }
        for (const override of this.model.membership.overrides)
        {
            if (override.homeBusinessUnit === id)
            {
                delete override.homeBusinessUnit
            }
        }
        for (const rule of this.model.ownershipRules)
        {
            if (SecurityModelOrg.References(rule.owningBusinessUnit, id))
            {
                // The empty kind/value pair is the unset sentinel the editor surfaces.
                rule.owningBusinessUnit = { kind: SecurityModelOrg.EmptyString, value: SecurityModelOrg.EmptyString }
            }
            if (SecurityModelOrg.References(rule.owner, id))
            {
                delete rule.owner
            }
        }
        this.dirty = true
    }

    public AddTeam(name: string): string
    {
        const teams = this.model.teams
        const id = SecurityModelOrg.NextId(SecurityModelOrg.TeamIdPrefix, name, SecurityModelOrg.FallbackTeamSlug, teams.map(t => t.id))
        teams.push({ id, name })
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

    public SetTeamOwningBusinessUnit(id: string, businessUnitId: string | undefined): void
    {
        const team = this.model.teams.find(t => t.id === id)
        if (team === undefined || this.UnknownUnit(businessUnitId))
        {
            return
        }
        if (businessUnitId === undefined)
        {
            delete team.owningBusinessUnit
        }
        else
        {
            team.owningBusinessUnit = businessUnitId
        }
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
        for (const rule of this.model.membership.claimsMapping)
        {
            SecurityModelOrg.Without(rule.teams, id)
        }
        for (const override of this.model.membership.overrides)
        {
            SecurityModelOrg.Without(override.teams, id)
        }
        const roleAssignment = this.model.roleAssignment
        if (roleAssignment !== undefined)
        {
            roleAssignment.teamRoles = roleAssignment.teamRoles.filter(g => g.teamId !== id)
        }
        const profileAssignment = this.model.fieldSecurity?.profileAssignment
        if (profileAssignment !== undefined)
        {
            profileAssignment.teamProfiles = profileAssignment.teamProfiles.filter(g => g.teamId !== id)
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

    private static References(source: OwnershipSourceDto | undefined, id: string): boolean
    {
        return source !== undefined && source.value === id
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
