import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { OptionViewModel } from '../../../shell/option-view-model.js'
import type { IAssignmentHolders, SecurityAssignments } from './security-assignments.js'
import type { SecurityModelDraft } from './security-model-draft.js'
import type { ISecurityModelEditHost } from './security-model-edit-host.js'

// Which assignment surface an editor addresses: the selected role or the
// selected field profile.
export enum AssignmentSide
{
    Role,
    Profile,
}

// One person granted the role / profile directly.
export class AssignmentPrincipalRowViewModel extends Observable
{
    private readonly removeCommand: RelayCommand

    public constructor(private readonly editor: AssignmentEditorViewModel, public readonly PrincipalId: string)
    {
        super()
        this.removeCommand = new RelayCommand(() => this.editor.RemovePrincipal(this.PrincipalId), () => this.editor.CanEdit)
    }

    public get RemoveCommand(): RelayCommand
    {
        return this.removeCommand
    }
}

// One team granted the role / profile; the name resolved from the org.
export class AssignmentTeamRowViewModel extends Observable
{
    private readonly removeCommand: RelayCommand

    public constructor(private readonly editor: AssignmentEditorViewModel, public readonly TeamId: string, public readonly TeamName: string)
    {
        super()
        this.removeCommand = new RelayCommand(() => this.editor.RemoveTeam(this.TeamId), () => this.editor.CanEdit)
    }

    public get RemoveCommand(): RelayCommand
    {
        return this.removeCommand
    }
}

// Who holds the selected role (People tab) or field profile (Fields tab):
// by person (principal ids) and by team (a picker over the teams not yet
// granted). One instance per side lives as long as the editor; Rebuild
// points it at the current draft and target (a role or profile name).
export class AssignmentEditorViewModel extends Observable
{
    private static readonly PrincipalRowsProperty = 'PrincipalRows'
    private static readonly TeamRowsProperty = 'TeamRows'
    private static readonly TeamOptionsProperty = 'TeamOptions'
    private static readonly SelectedTeamOptionProperty = 'SelectedTeamOption'
    private static readonly NewPrincipalProperty = 'NewPrincipal'
    private static readonly HasNoAssignmentsProperty = 'HasNoAssignments'
    private static readonly HasTeamOptionsProperty = 'HasTeamOptions'
    private static readonly NoRoleHoldersText = 'No one is assigned this role yet. Add people or teams below.'
    private static readonly NoProfileHoldersText = 'No one has this profile yet. Add people or teams below.'
    private static readonly Empty = ''

    private draft: SecurityModelDraft | undefined
    private targetId: string | undefined
    private principalRows = new ObservableCollection<AssignmentPrincipalRowViewModel>()
    private teamRows = new ObservableCollection<AssignmentTeamRowViewModel>()
    private teamOptions = new ObservableCollection<OptionViewModel<string>>()
    private selectedTeamOption: OptionViewModel<string> | undefined
    private newPrincipal = AssignmentEditorViewModel.Empty
    private readonly addPersonCommand: RelayCommand
    private readonly addTeamCommand: RelayCommand

    public constructor(private readonly host: ISecurityModelEditHost, public readonly Side: AssignmentSide)
    {
        super()
        this.addPersonCommand = new RelayCommand(() => this.AddPerson(), () => this.CanEdit)
        this.addTeamCommand = new RelayCommand(() => this.AddTeam(), () => this.CanEdit)
    }

    public get CanEdit(): boolean
    {
        return this.host.CanEdit
    }

    public get PrincipalRows(): ObservableCollection<AssignmentPrincipalRowViewModel>
    {
        return this.principalRows
    }

    public get TeamRows(): ObservableCollection<AssignmentTeamRowViewModel>
    {
        return this.teamRows
    }

    // The teams not yet granted, for the Add team picker.
    public get TeamOptions(): ObservableCollection<OptionViewModel<string>>
    {
        return this.teamOptions
    }

    public get HasTeamOptions(): boolean
    {
        return this.teamOptions.Count > 0
    }

    public get SelectedTeamOption(): OptionViewModel<string> | undefined
    {
        return this.selectedTeamOption
    }

    public set SelectedTeamOption(value: OptionViewModel<string> | undefined)
    {
        if (!(value instanceof OptionViewModel) || value === this.selectedTeamOption)
        {
            return
        }
        const old = this.selectedTeamOption
        this.selectedTeamOption = value
        this.RaisePropertyChanged(AssignmentEditorViewModel.SelectedTeamOptionProperty, old, value)
    }

    // The principal id typed for Add person.
    public get NewPrincipal(): string
    {
        return this.newPrincipal
    }

    public set NewPrincipal(value: string)
    {
        const next = typeof value === 'string' ? value : AssignmentEditorViewModel.Empty
        if (next === this.newPrincipal)
        {
            return
        }
        const old = this.newPrincipal
        this.newPrincipal = next
        this.RaisePropertyChanged(AssignmentEditorViewModel.NewPrincipalProperty, old, next)
    }

    public get HasNoAssignments(): boolean
    {
        return this.principalRows.Count + this.teamRows.Count === 0
    }

    public get NoAssignmentsText(): string
    {
        return this.Side === AssignmentSide.Role ? AssignmentEditorViewModel.NoRoleHoldersText : AssignmentEditorViewModel.NoProfileHoldersText
    }

    public get AddPersonCommand(): RelayCommand
    {
        return this.addPersonCommand
    }

    public get AddTeamCommand(): RelayCommand
    {
        return this.addTeamCommand
    }

    // Points the editor at `targetId` (a role or profile name) in `draft` and
    // rebuilds its rows; no target (or no draft) leaves it empty.
    public Rebuild(draft: SecurityModelDraft | undefined, targetId: string | undefined): void
    {
        const before = [this.principalRows, this.teamRows, this.teamOptions, this.selectedTeamOption, this.HasNoAssignments, this.HasTeamOptions] as const
        this.draft = draft
        this.targetId = targetId
        this.principalRows = new ObservableCollection<AssignmentPrincipalRowViewModel>()
        this.teamRows = new ObservableCollection<AssignmentTeamRowViewModel>()
        this.teamOptions = new ObservableCollection<OptionViewModel<string>>()
        this.selectedTeamOption = undefined
        if (draft !== undefined && targetId !== undefined)
        {
            const holders = this.HoldersOf(draft.Assignments, targetId)
            for (const principal of holders.PrincipalIds)
            {
                this.principalRows.Add(new AssignmentPrincipalRowViewModel(this, principal))
            }
            const teams = draft.Org.Teams
            const granted = new Set<string>(holders.TeamIds)
            for (const teamId of granted)
            {
                this.teamRows.Add(new AssignmentTeamRowViewModel(this, teamId, teams.find(t => t.id === teamId)?.name ?? teamId))
            }
            for (const team of teams)
            {
                if (!granted.has(team.id))
                {
                    this.teamOptions.Add(new OptionViewModel<string>(team.id, team.name))
                }
            }
            this.selectedTeamOption = this.teamOptions.ToArray()[0]
        }
        const P = AssignmentEditorViewModel
        this.RaisePropertyChanged(P.PrincipalRowsProperty, before[0], this.principalRows)
        this.RaisePropertyChanged(P.TeamRowsProperty, before[1], this.teamRows)
        this.RaisePropertyChanged(P.TeamOptionsProperty, before[2], this.teamOptions)
        this.RaisePropertyChanged(P.SelectedTeamOptionProperty, before[3], this.selectedTeamOption)
        this.RaisePropertyChanged(P.HasNoAssignmentsProperty, before[4], this.HasNoAssignments)
        this.RaisePropertyChanged(P.HasTeamOptionsProperty, before[5], this.HasTeamOptions)
    }

    // Grants the typed principal; blank input is a no-op.
    public AddPerson(): void
    {
        const principal = this.newPrincipal.trim()
        const target = this.targetId
        if (principal.length === 0 || target === undefined)
        {
            return
        }
        if (this.host.Apply(d => this.AddPrincipalTo(d.Assignments, target, principal)))
        {
            this.NewPrincipal = AssignmentEditorViewModel.Empty
            this.host.Rebuild()
        }
    }

    public RemovePrincipal(principalId: string): void
    {
        this.Restructure((a, target) => this.Side === AssignmentSide.Role ? a.RemovePrincipal(target, principalId) : a.RemoveProfilePrincipal(target, principalId))
    }

    // Grants the team picked in the picker.
    public AddTeam(): void
    {
        const picked = this.selectedTeamOption
        if (picked === undefined)
        {
            return
        }
        this.Restructure((a, target) => this.Side === AssignmentSide.Role ? a.AddTeam(target, picked.Value) : a.AddProfileTeam(target, picked.Value))
    }

    public RemoveTeam(teamId: string): void
    {
        this.Restructure((a, target) => this.Side === AssignmentSide.Role ? a.RemoveTeam(target, teamId) : a.RemoveProfileTeam(target, teamId))
    }

    private Restructure(change: (assignments: SecurityAssignments, target: string) => void): void
    {
        const target = this.targetId
        if (target === undefined || this.draft === undefined)
        {
            return
        }
        if (this.host.Apply(d => change(d.Assignments, target)))
        {
            this.host.Rebuild()
        }
    }

    private HoldersOf(assignments: SecurityAssignments, target: string): IAssignmentHolders
    {
        return this.Side === AssignmentSide.Role ? assignments.Holders(target) : assignments.ProfileHolders(target)
    }

    private AddPrincipalTo(assignments: SecurityAssignments, target: string, principal: string): void
    {
        if (this.Side === AssignmentSide.Role)
        {
            assignments.AddPrincipal(target, principal)
        }
        else
        {
            assignments.AddProfilePrincipal(target, principal)
        }
    }
}
