import type { TeamMemberDto } from '../../../tenant-types.js'
import type { SecurityModelDraft } from './security-model-draft.js'

// One rebuildable part of the editor: a row collection (or the derived
// projection) the editor replaces as a whole after a structural change.
export enum SecurityModelPart
{
    Roles,
    Privileges,
    RoleAssignment,
    Profiles,
    FieldGrants,
    ProfileAssignment,
    BusinessUnits,
    Users,
    Teams,
}

// What a row view-model edits through: the editor owning the one draft.
// Every edit goes through Apply, which refuses it (false) while the operator
// lacks the permission, a load or save is in flight, or no model is loaded.
export interface ISecurityModelEditHost
{
    // Whether the operator may edit at all (the permission; static per session).
    readonly CanEdit: boolean

    // Applies one in-place edit to the draft and refreshes the dirty state.
    Apply(change: (draft: SecurityModelDraft) => void): boolean

    // Rebuilds every part but `except` (the part holding the control being
    // edited, so it is never torn down under its own edit).
    Rebuild(except?: SecurityModelPart): void

    // Rebuilds just `part` (a projection that follows an in-place edit).
    RebuildPart(part: SecurityModelPart): void

    // Re-derives the business-unit tree (depths and parent choices) in place.
    RefreshUnitTree(): void

    // The server's member rows for a saved team, once loaded (undefined before).
    ServerTeamMembers(teamId: string): readonly TeamMemberDto[] | undefined

    // Whether the team exists in the saved setting (a team added in this draft has no server rows).
    IsSavedTeam(teamId: string): boolean

    // The team's manual members as last saved: the baseline for "not saved" marks.
    SavedManualMembers(teamId: string): readonly string[]

    // The last members-load failure text for the team ('' when none).
    TeamMembersError(teamId: string): string

    // Loads the server's member rows for a team into the editor's state and
    // rebuilds the team rows; a failure is recorded as the team's error text.
    // Never rejects; a result that lands after the draft changed is discarded.
    LoadTeamMembers(teamId: string): Promise<void>

    // The text typed into one of a team's "add" boxes, kept across rebuilds.
    TeamInput(teamId: string, field: TeamInputField): string
    SetTeamInput(teamId: string, field: TeamInputField, value: string): void
}

// The typed-in boxes on a team row.
export enum TeamInputField
{
    IdpGroup,
    Member,
}
