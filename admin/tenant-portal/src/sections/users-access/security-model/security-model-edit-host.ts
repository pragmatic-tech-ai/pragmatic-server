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
}
