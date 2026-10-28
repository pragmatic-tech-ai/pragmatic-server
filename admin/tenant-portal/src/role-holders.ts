import type { RoleAssignmentDto, TeamDto } from './tenant-types.js'

export interface RoleHolderData
{
    byPrincipal: readonly string[]
    byClaim: readonly { claim: string; value: string }[]
    byTeam: readonly { teamId: string; teamName: string }[]
    directCount: number
}

// Read-only projection of who holds a role. Claim rules and team grants assign
// the role dynamically (to whoever the IdP matches / any team member), which
// this process cannot resolve to people, so only per-principal overrides are
// counted and no head count or names are ever invented.
export class RoleHoldersDeriver
{
    public static Holders(roleId: string, assignment: RoleAssignmentDto | undefined, teams: readonly TeamDto[]): RoleHolderData
    {
        if (assignment === undefined)
        {
            return { byPrincipal: [], byClaim: [], byTeam: [], directCount: 0 }
        }
        const byPrincipal = assignment.overrides.filter(o => o.roles.includes(roleId)).map(o => o.principalId)
        const byClaim = assignment.claimsMapping.filter(c => c.roles.includes(roleId)).map(c => ({ claim: c.claim, value: c.value }))
        const byTeam = assignment.teamRoles
            .filter(t => t.roles.includes(roleId))
            .map(t => ({ teamId: t.teamId, teamName: teams.find(x => x.id === t.teamId)?.name ?? t.teamId }))
        return { byPrincipal, byClaim, byTeam, directCount: byPrincipal.length }
    }
}
