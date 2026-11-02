import type { RoleAssignmentDto, TeamDto } from '../../../tenant-types.js'

// Who holds a role, by how it is assigned.
export interface IRoleHolders
{
    readonly ByPrincipal: readonly string[]
    readonly ByClaim: readonly IRoleHolderClaim[]
    readonly ByTeam: readonly IRoleHolderTeam[]
    readonly DirectCount: number
}

export interface IRoleHolderClaim
{
    readonly Claim: string
    readonly Value: string
}

export interface IRoleHolderTeam
{
    readonly TeamId: string
    readonly TeamName: string
}

// Read-only projection of who holds a role. Claim rules and team grants assign
// the role dynamically (to whoever the IdP matches / any team member), which
// this process cannot resolve to people, so only per-principal overrides are
// counted and no head count or names are ever invented.
export class RoleHoldersDeriver
{
    public static Holders(roleId: string, assignment: RoleAssignmentDto | undefined, teams: readonly TeamDto[]): IRoleHolders
    {
        if (assignment === undefined)
        {
            return { ByPrincipal: [], ByClaim: [], ByTeam: [], DirectCount: 0 }
        }
        const byPrincipal = assignment.overrides.filter(o => o.roles.includes(roleId)).map(o => o.principalId)
        const byClaim = assignment.claimsMapping.filter(c => c.roles.includes(roleId)).map((c): IRoleHolderClaim => ({ Claim: c.claim, Value: c.value }))
        const byTeam = assignment.teamRoles
            .filter(t => t.roles.includes(roleId))
            .map((t): IRoleHolderTeam => ({ TeamId: t.teamId, TeamName: teams.find(x => x.id === t.teamId)?.name ?? t.teamId }))
        return { ByPrincipal: byPrincipal, ByClaim: byClaim, ByTeam: byTeam, DirectCount: byPrincipal.length }
    }
}
