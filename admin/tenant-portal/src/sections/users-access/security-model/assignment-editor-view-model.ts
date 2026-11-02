import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { OptionViewModel } from '../../../shell/option-view-model.js'
import type { ProfileAssignmentSection, RoleAssignmentSection } from './security-model-assignment.js'
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

// One claim rule granting the role / profile, addressed by its index in the
// claim rule list. Claim and value edit in place.
export class AssignmentClaimRowViewModel extends Observable
{
    private static readonly ClaimProperty = 'Claim'
    private static readonly ValueProperty = 'Value'

    private readonly removeCommand: RelayCommand

    public constructor(
        private readonly editor: AssignmentEditorViewModel,
        public readonly Index: number,
        private claim: string,
        private value: string)
    {
        super()
        this.removeCommand = new RelayCommand(() => this.editor.RemoveClaim(this.Index), () => this.editor.CanEdit)
    }

    public get CanEdit(): boolean
    {
        return this.editor.CanEdit
    }

    public get Claim(): string
    {
        return this.claim
    }

    public set Claim(next: string)
    {
        if (typeof next !== 'string' || next === this.claim)
        {
            return
        }
        const old = this.claim
        if (this.editor.SetClaim(this.Index, next))
        {
            this.claim = next
        }
        this.RaisePropertyChanged(AssignmentClaimRowViewModel.ClaimProperty, old, this.claim)
    }

    public get Value(): string
    {
        return this.value
    }

    public set Value(next: string)
    {
        if (typeof next !== 'string' || next === this.value)
        {
            return
        }
        const old = this.value
        if (this.editor.SetValue(this.Index, next))
        {
            this.value = next
        }
        this.RaisePropertyChanged(AssignmentClaimRowViewModel.ValueProperty, old, this.value)
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
// by person (principal ids), by claim (claim / value rules) and by team (a
// picker over the teams not yet granted). One instance per side lives as
// long as the editor; Rebuild points it at the current draft and target.
export class AssignmentEditorViewModel extends Observable
{
    private static readonly PrincipalRowsProperty = 'PrincipalRows'
    private static readonly ClaimRowsProperty = 'ClaimRows'
    private static readonly TeamRowsProperty = 'TeamRows'
    private static readonly TeamOptionsProperty = 'TeamOptions'
    private static readonly SelectedTeamOptionProperty = 'SelectedTeamOption'
    private static readonly NewPrincipalProperty = 'NewPrincipal'
    private static readonly HasNoAssignmentsProperty = 'HasNoAssignments'
    private static readonly HasTeamOptionsProperty = 'HasTeamOptions'
    private static readonly NoRoleHoldersText = 'No one is assigned this role yet. Add people, claim rules or teams below.'
    private static readonly NoProfileHoldersText = 'No one has this profile yet. Add people, claim rules or teams below.'
    private static readonly Empty = ''

    private draft: SecurityModelDraft | undefined
    private targetId: string | undefined
    private principalRows = new ObservableCollection<AssignmentPrincipalRowViewModel>()
    private claimRows = new ObservableCollection<AssignmentClaimRowViewModel>()
    private teamRows = new ObservableCollection<AssignmentTeamRowViewModel>()
    private teamOptions = new ObservableCollection<OptionViewModel<string>>()
    private selectedTeamOption: OptionViewModel<string> | undefined
    private newPrincipal = AssignmentEditorViewModel.Empty
    private readonly addPersonCommand: RelayCommand
    private readonly addClaimCommand: RelayCommand
    private readonly addTeamCommand: RelayCommand

    public constructor(private readonly host: ISecurityModelEditHost, public readonly Side: AssignmentSide)
    {
        super()
        this.addPersonCommand = new RelayCommand(() => this.AddPerson(), () => this.CanEdit)
        this.addClaimCommand = new RelayCommand(() => this.AddClaim(), () => this.CanEdit)
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

    public get ClaimRows(): ObservableCollection<AssignmentClaimRowViewModel>
    {
        return this.claimRows
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
        return this.principalRows.Count + this.claimRows.Count + this.teamRows.Count === 0
    }

    public get NoAssignmentsText(): string
    {
        return this.Side === AssignmentSide.Role ? AssignmentEditorViewModel.NoRoleHoldersText : AssignmentEditorViewModel.NoProfileHoldersText
    }

    public get AddPersonCommand(): RelayCommand
    {
        return this.addPersonCommand
    }

    public get AddClaimCommand(): RelayCommand
    {
        return this.addClaimCommand
    }

    public get AddTeamCommand(): RelayCommand
    {
        return this.addTeamCommand
    }

    // Points the editor at `targetId` (a role or profile id) in `draft` and
    // rebuilds its rows; no target (or no draft) leaves it empty.
    public Rebuild(draft: SecurityModelDraft | undefined, targetId: string | undefined): void
    {
        const before = [this.principalRows, this.claimRows, this.teamRows, this.teamOptions, this.selectedTeamOption, this.HasNoAssignments, this.HasTeamOptions] as const
        this.draft = draft
        this.targetId = targetId
        this.principalRows = new ObservableCollection<AssignmentPrincipalRowViewModel>()
        this.claimRows = new ObservableCollection<AssignmentClaimRowViewModel>()
        this.teamRows = new ObservableCollection<AssignmentTeamRowViewModel>()
        this.teamOptions = new ObservableCollection<OptionViewModel<string>>()
        this.selectedTeamOption = undefined
        if (draft !== undefined && targetId !== undefined)
        {
            const section = AssignmentEditorViewModel.SectionOf(draft, this.Side)
            for (const principal of section.PrincipalGrants(targetId))
            {
                this.principalRows.Add(new AssignmentPrincipalRowViewModel(this, principal))
            }
            for (const claim of section.ClaimGrants(targetId))
            {
                this.claimRows.Add(new AssignmentClaimRowViewModel(this, claim.Index, claim.Claim, claim.Value))
            }
            const teams = draft.Org.Teams
            const granted = new Set<string>(section.TeamGrants(targetId))
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
        this.RaisePropertyChanged(P.ClaimRowsProperty, before[1], this.claimRows)
        this.RaisePropertyChanged(P.TeamRowsProperty, before[2], this.teamRows)
        this.RaisePropertyChanged(P.TeamOptionsProperty, before[3], this.teamOptions)
        this.RaisePropertyChanged(P.SelectedTeamOptionProperty, before[4], this.selectedTeamOption)
        this.RaisePropertyChanged(P.HasNoAssignmentsProperty, before[5], this.HasNoAssignments)
        this.RaisePropertyChanged(P.HasTeamOptionsProperty, before[6], this.HasTeamOptions)
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
        if (this.host.Apply(d => { AssignmentEditorViewModel.SectionOf(d, this.Side).AddPrincipalGrant(target, principal) }))
        {
            this.NewPrincipal = AssignmentEditorViewModel.Empty
            this.host.Rebuild()
        }
    }

    public RemovePrincipal(principalId: string): void
    {
        this.Restructure((section, target) => section.RemovePrincipalGrant(target, principalId))
    }

    // Adds an empty claim rule for the target, to fill in in place.
    public AddClaim(): void
    {
        this.Restructure((section, target) => section.AddClaimGrant(target))
    }

    public RemoveClaim(index: number): void
    {
        this.Restructure((section, target) => section.RemoveClaimGrant(target, index))
    }

    public SetClaim(index: number, claim: string): boolean
    {
        return this.host.Apply(d => { AssignmentEditorViewModel.SectionOf(d, this.Side).SetClaim(index, claim) })
    }

    public SetValue(index: number, value: string): boolean
    {
        return this.host.Apply(d => { AssignmentEditorViewModel.SectionOf(d, this.Side).SetValue(index, value) })
    }

    // Grants the team picked in the picker.
    public AddTeam(): void
    {
        const picked = this.selectedTeamOption
        if (picked === undefined)
        {
            return
        }
        this.Restructure((section, target) => section.AddTeamGrant(target, picked.Value))
    }

    public RemoveTeam(teamId: string): void
    {
        this.Restructure((section, target) => section.RemoveTeamGrant(target, teamId))
    }

    private Restructure(change: (section: RoleAssignmentSection | ProfileAssignmentSection, target: string) => void): void
    {
        const target = this.targetId
        if (target === undefined || this.draft === undefined)
        {
            return
        }
        if (this.host.Apply(d => { change(AssignmentEditorViewModel.SectionOf(d, this.Side), target) }))
        {
            this.host.Rebuild()
        }
    }

    private static SectionOf(draft: SecurityModelDraft, side: AssignmentSide): RoleAssignmentSection | ProfileAssignmentSection
    {
        return side === AssignmentSide.Role ? draft.RoleAssignment : draft.ProfileAssignment
    }
}
