import type {
    FieldProfileAssignmentDto, FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto, FieldSecurityDto,
    RoleAssignmentDto, RoleClaimRuleDto, RoleOverrideDto, SecurityModelDto, TeamRoleGrantDto
} from './tenant-types.js'

export interface AssignmentArrays<TClaim, TOverride, TTeam>
{
    claimsMapping: TClaim[]
    overrides: TOverride[]
    teamGrants: TTeam[]
}

export interface ClaimGrantRow
{
    index: number
    claim: string
    value: string
}

// Shared edit logic for an id-set assignment (claim rules, principal overrides,
// team grants), scoped by a target id (a role id or a field-profile id). The
// subclasses supply only which live arrays and which id field are involved.
export abstract class SecurityModelAssignment<TClaim extends { claim: string; value: string }, TOverride extends { principalId: string }, TTeam extends { teamId: string }>
{
    private static readonly EmptyString = ''

    private dirty = false

    public get Dirty(): boolean
    {
        return this.dirty
    }

    protected abstract Ensure(): AssignmentArrays<TClaim, TOverride, TTeam>
    protected abstract Peek(): AssignmentArrays<TClaim, TOverride, TTeam> | undefined
    protected abstract IdsOf(entry: TClaim | TOverride | TTeam): string[]
    protected abstract NewClaim(claim: string, value: string, id: string): TClaim
    protected abstract NewOverride(principalId: string, id: string): TOverride
    protected abstract NewTeam(teamId: string, id: string): TTeam

    public ClaimGrants(targetId: string): readonly ClaimGrantRow[]
    {
        const rows: ClaimGrantRow[] = []
        const claims = this.Peek()?.claimsMapping ?? []
        claims.forEach((rule, index) =>
        {
            if (this.IdsOf(rule).includes(targetId))
            {
                rows.push({ index, claim: rule.claim, value: rule.value })
            }
        })
        return rows
    }

    public AddClaimGrant(targetId: string): void
    {
        this.Ensure().claimsMapping.push(this.NewClaim(SecurityModelAssignment.EmptyString, SecurityModelAssignment.EmptyString, targetId))
        this.dirty = true
    }

    public SetClaim(index: number, claim: string): void
    {
        const rule = this.Peek()?.claimsMapping[index]
        if (rule === undefined)
        {
            return
        }
        rule.claim = claim
        this.dirty = true
    }

    public SetValue(index: number, value: string): void
    {
        const rule = this.Peek()?.claimsMapping[index]
        if (rule === undefined)
        {
            return
        }
        rule.value = value
        this.dirty = true
    }

    public RemoveClaimGrant(targetId: string, index: number): void
    {
        const claims = this.Peek()?.claimsMapping
        const rule = claims?.[index]
        if (claims === undefined || rule === undefined || !this.Drop(rule, targetId))
        {
            return
        }
        if (this.IdsOf(rule).length === 0)
        {
            claims.splice(index, 1)
        }
        this.dirty = true
    }

    public PrincipalGrants(targetId: string): readonly string[]
    {
        return (this.Peek()?.overrides ?? []).filter(o => this.IdsOf(o).includes(targetId)).map(o => o.principalId)
    }

    public AddPrincipalGrant(targetId: string, principalId: string): void
    {
        if (principalId.length === 0)
        {
            return
        }
        const overrides = this.Ensure().overrides
        const entry = overrides.find(o => o.principalId === principalId)
        if (entry === undefined)
        {
            overrides.push(this.NewOverride(principalId, targetId))
            this.dirty = true
        }
        else if (this.Add(entry, targetId))
        {
            this.dirty = true
        }
    }

    public RemovePrincipalGrant(targetId: string, principalId: string): void
    {
        const overrides = this.Peek()?.overrides
        const entry = overrides?.find(o => o.principalId === principalId)
        if (overrides === undefined || entry === undefined || !this.Drop(entry, targetId))
        {
            return
        }
        if (this.IdsOf(entry).length === 0)
        {
            overrides.splice(overrides.indexOf(entry), 1)
        }
        this.dirty = true
    }

    public TeamGrants(targetId: string): readonly string[]
    {
        return (this.Peek()?.teamGrants ?? []).filter(t => this.IdsOf(t).includes(targetId)).map(t => t.teamId)
    }

    public AddTeamGrant(targetId: string, teamId: string): void
    {
        if (teamId.length === 0)
        {
            return
        }
        const teams = this.Ensure().teamGrants
        const entry = teams.find(t => t.teamId === teamId)
        if (entry === undefined)
        {
            teams.push(this.NewTeam(teamId, targetId))
            this.dirty = true
        }
        else if (this.Add(entry, targetId))
        {
            this.dirty = true
        }
    }

    public RemoveTeamGrant(targetId: string, teamId: string): void
    {
        const teams = this.Peek()?.teamGrants
        const entry = teams?.find(t => t.teamId === teamId)
        if (teams === undefined || entry === undefined || !this.Drop(entry, targetId))
        {
            return
        }
        if (this.IdsOf(entry).length === 0)
        {
            teams.splice(teams.indexOf(entry), 1)
        }
        this.dirty = true
    }

    private Add(entry: TClaim | TOverride | TTeam, targetId: string): boolean
    {
        const ids = this.IdsOf(entry)
        if (ids.includes(targetId))
        {
            return false
        }
        ids.push(targetId)
        return true
    }

    private Drop(entry: TClaim | TOverride | TTeam, targetId: string): boolean
    {
        const ids = this.IdsOf(entry)
        const i = ids.indexOf(targetId)
        if (i < 0)
        {
            return false
        }
        ids.splice(i, 1)
        return true
    }
}

export class RoleAssignmentSection extends SecurityModelAssignment<RoleClaimRuleDto, RoleOverrideDto, TeamRoleGrantDto>
{
    private readonly model: SecurityModelDto
    private readonly ensure: () => RoleAssignmentDto

    public constructor(model: SecurityModelDto, ensure: () => RoleAssignmentDto)
    {
        super()
        this.model = model
        this.ensure = ensure
    }

    protected Ensure(): AssignmentArrays<RoleClaimRuleDto, RoleOverrideDto, TeamRoleGrantDto>
    {
        return RoleAssignmentSection.Arrays(this.ensure())
    }

    protected Peek(): AssignmentArrays<RoleClaimRuleDto, RoleOverrideDto, TeamRoleGrantDto> | undefined
    {
        const a = this.model.roleAssignment
        return a === undefined ? undefined : RoleAssignmentSection.Arrays(a)
    }

    protected IdsOf(entry: RoleClaimRuleDto | RoleOverrideDto | TeamRoleGrantDto): string[]
    {
        return entry.roles
    }

    protected NewClaim(claim: string, value: string, id: string): RoleClaimRuleDto
    {
        return { claim, value, roles: [id] }
    }

    protected NewOverride(principalId: string, id: string): RoleOverrideDto
    {
        return { principalId, roles: [id] }
    }

    protected NewTeam(teamId: string, id: string): TeamRoleGrantDto
    {
        return { teamId, roles: [id] }
    }

    private static Arrays(a: RoleAssignmentDto): AssignmentArrays<RoleClaimRuleDto, RoleOverrideDto, TeamRoleGrantDto>
    {
        return { claimsMapping: a.claimsMapping, overrides: a.overrides, teamGrants: a.teamRoles }
    }
}

export class ProfileAssignmentSection extends SecurityModelAssignment<FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto>
{
    private readonly model: SecurityModelDto
    private readonly ensure: () => FieldSecurityDto

    public constructor(model: SecurityModelDto, ensure: () => FieldSecurityDto)
    {
        super()
        this.model = model
        this.ensure = ensure
    }

    protected Ensure(): AssignmentArrays<FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto>
    {
        return ProfileAssignmentSection.Arrays(this.ensure().profileAssignment)
    }

    protected Peek(): AssignmentArrays<FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto> | undefined
    {
        const a = this.model.fieldSecurity?.profileAssignment
        return a === undefined ? undefined : ProfileAssignmentSection.Arrays(a)
    }

    protected IdsOf(entry: FieldProfileClaimRuleDto | FieldProfileOverrideDto | FieldProfileTeamGrantDto): string[]
    {
        return entry.profiles
    }

    protected NewClaim(claim: string, value: string, id: string): FieldProfileClaimRuleDto
    {
        return { claim, value, profiles: [id] }
    }

    protected NewOverride(principalId: string, id: string): FieldProfileOverrideDto
    {
        return { principalId, profiles: [id] }
    }

    protected NewTeam(teamId: string, id: string): FieldProfileTeamGrantDto
    {
        return { teamId, profiles: [id] }
    }

    private static Arrays(a: FieldProfileAssignmentDto): AssignmentArrays<FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto>
    {
        return { claimsMapping: a.claimsMapping, overrides: a.overrides, teamGrants: a.teamProfiles }
    }
}
