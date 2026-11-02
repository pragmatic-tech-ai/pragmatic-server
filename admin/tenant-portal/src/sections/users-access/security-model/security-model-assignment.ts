import type {
    FieldProfileAssignmentDto, FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto, FieldSecurityDto,
    RoleAssignmentDto, RoleClaimRuleDto, RoleOverrideDto, SecurityModelDto, TeamRoleGrantDto
} from '../../../tenant-types.js'

// The live arrays one assignment edits (they belong to the draft's DTOs).
export interface IAssignmentArrays<TClaim, TOverride, TTeam>
{
    readonly ClaimsMapping: TClaim[]
    readonly Overrides: TOverride[]
    readonly TeamGrants: TTeam[]
}

// One claim rule granting the target, with its position in ClaimsMapping.
export interface IClaimGrantRow
{
    readonly Index: number
    readonly Claim: string
    readonly Value: string
}

// Shared edit logic for an id-set assignment (claim rules, principal overrides,
// team grants), scoped by a target id (a role id or a field-profile id). The
// subclasses supply only which live arrays and which id field are involved.
export abstract class SecurityModelAssignment<TClaim extends { claim: string; value: string }, TOverride extends { principalId: string }, TTeam extends { teamId: string }>
{
    private static readonly EmptyString = ''

    protected readonly model: SecurityModelDto
    private dirty = false

    protected constructor(model: SecurityModelDto)
    {
        this.model = model
    }

    public get Dirty(): boolean
    {
        return this.dirty
    }

    protected abstract Ensure(): IAssignmentArrays<TClaim, TOverride, TTeam>
    protected abstract Peek(): IAssignmentArrays<TClaim, TOverride, TTeam> | undefined
    protected abstract IdsOf(entry: TClaim | TOverride | TTeam): string[]
    protected abstract NewClaim(claim: string, value: string, id: string): TClaim
    protected abstract NewOverride(principalId: string, id: string): TOverride
    protected abstract NewTeam(teamId: string, id: string): TTeam

    public ClaimGrants(targetId: string): readonly IClaimGrantRow[]
    {
        const rows: IClaimGrantRow[] = []
        const claims = this.Peek()?.ClaimsMapping ?? []
        claims.forEach((rule, index) =>
        {
            if (this.IdsOf(rule).includes(targetId))
            {
                rows.push({ Index: index, Claim: rule.claim, Value: rule.value })
            }
        })
        return rows
    }

    public AddClaimGrant(targetId: string): void
    {
        this.Ensure().ClaimsMapping.push(this.NewClaim(SecurityModelAssignment.EmptyString, SecurityModelAssignment.EmptyString, targetId))
        this.dirty = true
    }

    public SetClaim(index: number, claim: string): void
    {
        const rule = this.Peek()?.ClaimsMapping[index]
        if (rule === undefined)
        {
            return
        }
        rule.claim = claim
        this.dirty = true
    }

    public SetValue(index: number, value: string): void
    {
        const rule = this.Peek()?.ClaimsMapping[index]
        if (rule === undefined)
        {
            return
        }
        rule.value = value
        this.dirty = true
    }

    public RemoveClaimGrant(targetId: string, index: number): void
    {
        const claims = this.Peek()?.ClaimsMapping
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
        return (this.Peek()?.Overrides ?? []).filter(o => this.IdsOf(o).includes(targetId)).map(o => o.principalId)
    }

    public AddPrincipalGrant(targetId: string, principalId: string): void
    {
        if (principalId.length === 0)
        {
            return
        }
        const overrides = this.Ensure().Overrides
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
        // The normal model has one entry per principalId; iterating all matches is defensive against duplicates.
        const overrides = this.Peek()?.Overrides
        if (overrides !== undefined && this.DropAll(overrides, o => o.principalId === principalId, targetId))
        {
            this.dirty = true
        }
    }

    public TeamGrants(targetId: string): readonly string[]
    {
        return (this.Peek()?.TeamGrants ?? []).filter(t => this.IdsOf(t).includes(targetId)).map(t => t.teamId)
    }

    public AddTeamGrant(targetId: string, teamId: string): void
    {
        if (teamId.length === 0)
        {
            return
        }
        const teams = this.Ensure().TeamGrants
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
        // The normal model has one entry per teamId; iterating all matches is defensive against duplicates.
        const teams = this.Peek()?.TeamGrants
        if (teams !== undefined && this.DropAll(teams, t => t.teamId === teamId, targetId))
        {
            this.dirty = true
        }
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

    private DropAll<T extends TOverride | TTeam>(entries: T[], matches: (entry: T) => boolean, targetId: string): boolean
    {
        let changed = false
        for (let i = entries.length - 1; i >= 0; i--)
        {
            if (matches(entries[i]) && this.Drop(entries[i], targetId))
            {
                changed = true
                if (this.IdsOf(entries[i]).length === 0)
                {
                    entries.splice(i, 1)
                }
            }
        }
        return changed
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
    public constructor(model: SecurityModelDto)
    {
        super(model)
    }

    protected Ensure(): IAssignmentArrays<RoleClaimRuleDto, RoleOverrideDto, TeamRoleGrantDto>
    {
        this.model.roleAssignment ??= { claimsMapping: [], overrides: [], teamRoles: [] }
        return RoleAssignmentSection.Arrays(this.model.roleAssignment)
    }

    protected Peek(): IAssignmentArrays<RoleClaimRuleDto, RoleOverrideDto, TeamRoleGrantDto> | undefined
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

    private static Arrays(a: RoleAssignmentDto): IAssignmentArrays<RoleClaimRuleDto, RoleOverrideDto, TeamRoleGrantDto>
    {
        return { ClaimsMapping: a.claimsMapping, Overrides: a.overrides, TeamGrants: a.teamRoles }
    }
}

export class ProfileAssignmentSection extends SecurityModelAssignment<FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto>
{
    private readonly ensure: () => FieldSecurityDto

    public constructor(model: SecurityModelDto, ensure: () => FieldSecurityDto)
    {
        super(model)
        this.ensure = ensure
    }

    protected Ensure(): IAssignmentArrays<FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto>
    {
        return ProfileAssignmentSection.Arrays(this.ensure().profileAssignment)
    }

    protected Peek(): IAssignmentArrays<FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto> | undefined
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

    private static Arrays(a: FieldProfileAssignmentDto): IAssignmentArrays<FieldProfileClaimRuleDto, FieldProfileOverrideDto, FieldProfileTeamGrantDto>
    {
        return { ClaimsMapping: a.claimsMapping, Overrides: a.overrides, TeamGrants: a.teamProfiles }
    }
}
