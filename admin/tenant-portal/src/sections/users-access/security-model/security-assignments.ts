import type { ProfileAssignmentDto, RoleAssignmentDto, SecurityModelDto } from '../../../tenant-types.js'

// Who holds a role or field profile: people by principal id, and teams.
export interface IAssignmentHolders
{
    readonly PrincipalIds: readonly string[]
    readonly TeamIds: readonly string[]
}

// The setting's role and profile assignments, edited in the live model. An
// assignment left with no holders stays in the model while editing; the
// draft drops it from ToDto().
export class SecurityAssignments
{
    private static readonly NoHolders: IAssignmentHolders = { PrincipalIds: [], TeamIds: [] }

    private dirty = false

    public constructor(private readonly model: SecurityModelDto)
    {
    }

    public get Dirty(): boolean
    {
        return this.dirty
    }

    // ---- Roles ---------------------------------------------------------

    public Holders(role: string): IAssignmentHolders
    {
        return SecurityAssignments.HoldersOf(this.model.roleAssignments.find(a => a.role === role))
    }

    public AddPrincipal(role: string, id: string): void
    {
        this.Add(this.RoleRow(role).principalIds, id)
    }

    public RemovePrincipal(role: string, id: string): void
    {
        this.Remove(this.model.roleAssignments.find(a => a.role === role)?.principalIds, id)
    }

    public AddTeam(role: string, teamId: string): void
    {
        this.Add(this.RoleRow(role).teamIds, teamId)
    }

    public RemoveTeam(role: string, teamId: string): void
    {
        this.Remove(this.model.roleAssignments.find(a => a.role === role)?.teamIds, teamId)
    }

    // ---- Field profiles ------------------------------------------------

    public ProfileHolders(profile: string): IAssignmentHolders
    {
        return SecurityAssignments.HoldersOf(this.model.profileAssignments.find(a => a.profile === profile))
    }

    public AddProfilePrincipal(profile: string, id: string): void
    {
        this.Add(this.ProfileRow(profile).principalIds, id)
    }

    public RemoveProfilePrincipal(profile: string, id: string): void
    {
        this.Remove(this.model.profileAssignments.find(a => a.profile === profile)?.principalIds, id)
    }

    public AddProfileTeam(profile: string, teamId: string): void
    {
        this.Add(this.ProfileRow(profile).teamIds, teamId)
    }

    public RemoveProfileTeam(profile: string, teamId: string): void
    {
        this.Remove(this.model.profileAssignments.find(a => a.profile === profile)?.teamIds, teamId)
    }

    // ---- Plumbing ------------------------------------------------------

    // Whether an assignment row still names anyone (the draft emits only those).
    public static HasHolders(row: { principalIds: readonly string[]; teamIds: readonly string[] }): boolean
    {
        return row.principalIds.length + row.teamIds.length > 0
    }

    private static HoldersOf(row: RoleAssignmentDto | ProfileAssignmentDto | undefined): IAssignmentHolders
    {
        return row === undefined ? SecurityAssignments.NoHolders : { PrincipalIds: [...row.principalIds], TeamIds: [...row.teamIds] }
    }

    private RoleRow(role: string): RoleAssignmentDto
    {
        const found = this.model.roleAssignments.find(a => a.role === role)
        if (found !== undefined)
        {
            return found
        }
        const row: RoleAssignmentDto = { role, principalIds: [], teamIds: [] }
        this.model.roleAssignments.push(row)
        return row
    }

    private ProfileRow(profile: string): ProfileAssignmentDto
    {
        const found = this.model.profileAssignments.find(a => a.profile === profile)
        if (found !== undefined)
        {
            return found
        }
        const row: ProfileAssignmentDto = { profile, principalIds: [], teamIds: [] }
        this.model.profileAssignments.push(row)
        return row
    }

    private Add(list: string[], id: string): void
    {
        if (id.length === 0 || list.includes(id))
        {
            return
        }
        list.push(id)
        this.dirty = true
    }

    private Remove(list: string[] | undefined, id: string): void
    {
        const i = list?.indexOf(id) ?? -1
        if (list === undefined || i < 0)
        {
            return
        }
        list.splice(i, 1)
        this.dirty = true
    }
}
