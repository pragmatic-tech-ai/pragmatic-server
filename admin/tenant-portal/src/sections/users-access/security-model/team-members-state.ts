import type { SecurityModelDto, TeamMemberDto } from '../../../tenant-types.js'
import type { TenantSessionService } from '../../../shell/tenant-session-service.js'
import type { ISelectedEnvironment } from './security-model-edit-host.js'
import { TeamInputField } from './security-model-edit-host.js'

// The editor's per-team member state, kept beside the draft: the server's
// member rows per saved team (loaded on demand), the last load failure per
// team, the text typed into each team's "add" boxes, and the manual members as
// last saved (the baseline for "not saved" marks). Reset with every new draft.
export class TeamMembersState
{
    private static readonly InputKeySeparator = '|'
    private static readonly Empty = ''

    private readonly members = new Map<string, readonly TeamMemberDto[]>()
    private readonly errors = new Map<string, string>()
    private readonly inputs = new Map<string, string>()
    private saved = new Map<string, readonly string[]>()
    // Bumped by Reset, so a load that lands after the draft changed is discarded.
    private generation = 0

    public constructor(private readonly session: TenantSessionService, private readonly selection: ISelectedEnvironment)
    {
    }

    // A new draft (undefined: none): forgets every loaded row, failure and
    // typed input; `saved` (the setting as last saved) is the new baseline.
    public Reset(saved: SecurityModelDto | undefined): void
    {
        this.generation++
        this.members.clear()
        this.errors.clear()
        this.inputs.clear()
        this.saved = new Map((saved?.teams ?? []).map(t => [t.id, t.manualMembers]))
    }

    // The server's member rows for a saved team, once loaded (undefined before).
    public ServerTeamMembers(teamId: string): readonly TeamMemberDto[] | undefined
    {
        return this.members.get(teamId)
    }

    // Whether the team exists in the saved setting (a team added in this draft has no server rows).
    public IsSavedTeam(teamId: string): boolean
    {
        return this.saved.has(teamId)
    }

    // The team's manual members as last saved.
    public SavedManualMembers(teamId: string): readonly string[]
    {
        return this.saved.get(teamId) ?? []
    }

    // The last members-load failure text for the team ('' when none).
    public TeamMembersError(teamId: string): string
    {
        return this.errors.get(teamId) ?? TeamMembersState.Empty
    }

    // The text typed into one of a team's "add" boxes, kept across rebuilds.
    public TeamInput(teamId: string, field: TeamInputField): string
    {
        return this.inputs.get(TeamMembersState.InputKey(teamId, field)) ?? TeamMembersState.Empty
    }

    public SetTeamInput(teamId: string, field: TeamInputField, value: string): void
    {
        this.inputs.set(TeamMembersState.InputKey(teamId, field), value)
    }

    // Loads the server's member rows for a saved team; a failure is recorded
    // as the team's error text. Never rejects. True when the result was kept
    // (the caller rebuilds the team rows); false for an unsaved team or a
    // result that landed after a Reset or an environment change.
    public async LoadTeamMembers(teamId: string): Promise<boolean>
    {
        const environment = this.selection.Environment
        const generation = this.generation
        if (environment === undefined || !this.IsSavedTeam(teamId))
        {
            return false
        }
        let rows: TeamMemberDto[] | undefined
        let failure = TeamMembersState.Empty
        try
        {
            rows = await this.session.Client.ListTeamMembers(environment, teamId)
        }
        catch (e)
        {
            failure = e instanceof Error ? e.message : String(e)
        }
        if (generation !== this.generation || this.selection.Environment !== environment)
        {
            return false
        }
        if (rows === undefined)
        {
            this.errors.set(teamId, failure)
        }
        else
        {
            this.errors.delete(teamId)
            this.members.set(teamId, rows)
        }
        return true
    }

    private static InputKey(teamId: string, field: TeamInputField): string
    {
        return `${field}${TeamMembersState.InputKeySeparator}${teamId}`
    }
}
