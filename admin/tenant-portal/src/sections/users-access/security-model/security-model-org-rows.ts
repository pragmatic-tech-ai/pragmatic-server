import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TeamMemberOrigin, type BusinessUnitDto, type TeamDto, type UserPlacementDto } from '../../../tenant-types.js'
import type { SecurityModelDraft } from './security-model-draft.js'
import type { SecurityModelOrg } from './security-model-org.js'
import { SecurityModelText } from './security-model-text.js'
import { SecurityModelPart, TeamInputField, type ISecurityModelEditHost } from './security-model-edit-host.js'

// One business-unit choice in a ComboBox: a unit, or "(none)" (Id
// undefined). Kept per unit id across rebuilds, so a ComboBox holding it
// still finds it in a replaced choice list; its label follows renames.
export class UnitOptionViewModel extends Observable
{
    private static readonly LabelProperty = 'Label'

    public constructor(public readonly Id: string | undefined, private label: string)
    {
        super()
    }

    public get Label(): string
    {
        return this.label
    }

    public SetLabel(label: string): void
    {
        const old = this.label
        if (old === label)
        {
            return
        }
        this.label = label
        this.RaisePropertyChanged(UnitOptionViewModel.LabelProperty, old, label)
    }
}

// Whether a unit picker offers "(none)": only the root's parent picker does
// (the root has no parent); every other unit, user and team sits in a unit.
export enum NoneChoice
{
    Offered,
    Omitted,
}

// One set of unit choices ("(none)" first when offered, then units) and the
// lookup from a unit id to its choice.
export class UnitChoices
{
    public readonly Options: ObservableCollection<UnitOptionViewModel>

    public constructor(private readonly none: UnitOptionViewModel, private readonly units: ReadonlyMap<string, UnitOptionViewModel>, ids: readonly string[], noneChoice: NoneChoice)
    {
        this.Options = new ObservableCollection<UnitOptionViewModel>()
        if (noneChoice === NoneChoice.Offered)
        {
            this.Options.Add(none)
        }
        for (const id of ids)
        {
            const option = units.get(id)
            if (option !== undefined)
            {
                this.Options.Add(option)
            }
        }
    }

    // The choice for `id`; "(none)" for no unit or one no longer offered.
    public OptionFor(id: string | undefined): UnitOptionViewModel
    {
        return id === undefined ? this.none : this.units.get(id) ?? this.none
    }

    public get Ids(): readonly (string | undefined)[]
    {
        return this.Options.ToArray().map(o => o.Id)
    }
}

// Base for an editable org row: text edits go through the host and re-raise
// the draft's value, so a refused edit snaps the box back.
export abstract class OrgRowViewModel extends Observable
{
    private readonly removeCommand: RelayCommand

    protected constructor(protected readonly host: ISecurityModelEditHost)
    {
        super()
        this.removeCommand = new RelayCommand(() => this.Remove(), () => this.host.CanEdit && this.CanRemove)
    }

    // Whether the row may be removed at all (beyond the permission).
    protected get CanRemove(): boolean
    {
        return true
    }

    public get CanEdit(): boolean
    {
        return this.host.CanEdit
    }

    public get RemoveCommand(): RelayCommand
    {
        return this.removeCommand
    }

    // Removes the row from the draft; the editor rebuilds (cascades included).
    public Remove(): void
    {
        if (this.CanRemove && this.host.Apply(d => this.RemoveFrom(d)))
        {
            this.host.Rebuild()
        }
    }

    protected abstract RemoveFrom(draft: SecurityModelDraft): void

    // Applies a text edit; true when it was applied.
    protected EditText(next: unknown, read: () => string, apply: (draft: SecurityModelDraft) => void, property: string): boolean
    {
        const old = read()
        if (typeof next !== 'string' || next === old)
        {
            return false
        }
        const applied = this.host.Apply(apply)
        this.RaisePropertyChanged(property, old, read())
        return applied
    }

    // Applies a unit pick; the ComboBox then snaps to the draft's value.
    protected PickUnit(value: unknown, current: string | undefined, apply: (draft: SecurityModelDraft, id: string | undefined) => void, property: string, read: () => UnitOptionViewModel | undefined): boolean
    {
        if (!(value instanceof UnitOptionViewModel) || value.Id === current)
        {
            return false
        }
        const applied = this.host.Apply(d => apply(d, value.Id))
        this.RaisePropertyChanged(property, value, read())
        return applied
    }
}

// One business unit: rename, parent (any unit but itself and its
// descendants; a cycle is refused; the root keeps no parent), remove.
// Indented by its depth.
export class BusinessUnitRowViewModel extends OrgRowViewModel
{
    private static readonly NameProperty = 'Name'
    private static readonly IndentProperty = 'Indent'
    private static readonly ParentOptionsProperty = 'ParentOptions'
    private static readonly SelectedParentProperty = 'SelectedParent'
    private static readonly CanPickParentProperty = 'CanPickParent'
    private static readonly IndentUnit = '\u00a0\u00a0\u00a0\u00a0'
    private static readonly RemoveBlockedProperty = 'IsRemoveBlocked'
    private static readonly CannotRemoveUnitText = 'Move its units, people and teams first.'

    private depth = 0
    private choices: UnitChoices | undefined

    public constructor(host: ISecurityModelEditHost, private readonly unit: BusinessUnitDto, private readonly org: SecurityModelOrg)
    {
        super(host)
    }

    // Not the root, and no child units, teams or placed users reference it.
    protected override get CanRemove(): boolean
    {
        return this.org.CanRemoveBusinessUnit(this.unit.id)
    }

    public get Id(): string
    {
        return this.unit.id
    }

    // Shown on the row when removal is blocked (the root is never removable
    // and carries no hint).
    public get IsRemoveBlocked(): boolean
    {
        return this.unit.parent !== undefined && !this.CanRemove
    }

    public get CannotRemoveText(): string
    {
        return BusinessUnitRowViewModel.CannotRemoveUnitText
    }

    public get Parent(): string | undefined
    {
        return this.unit.parent
    }

    // The root unit: its picker offers only "(none)" and is disabled.
    public get IsRoot(): boolean
    {
        return this.org.IsRoot(this.unit.id)
    }

    // Whether the parent picker is enabled: the operator may edit and this is not the root.
    public get CanPickParent(): boolean
    {
        return this.CanEdit && !this.IsRoot
    }

    public get Name(): string
    {
        return this.unit.name
    }

    // A rename relabels this unit in every other unit choice.
    public set Name(next: string)
    {
        if (this.EditText(next, () => this.unit.name, d => d.Org.RenameBusinessUnit(this.unit.id, next), BusinessUnitRowViewModel.NameProperty))
        {
            this.host.Rebuild(SecurityModelPart.BusinessUnits)
        }
    }

    public get Depth(): number
    {
        return this.depth
    }

    public get Indent(): string
    {
        return BusinessUnitRowViewModel.IndentUnit.repeat(this.depth)
    }

    public get ParentOptions(): ObservableCollection<UnitOptionViewModel>
    {
        return this.choices?.Options ?? new ObservableCollection<UnitOptionViewModel>()
    }

    public get SelectedParent(): UnitOptionViewModel | undefined
    {
        return this.choices?.OptionFor(this.unit.parent)
    }

    public set SelectedParent(value: UnitOptionViewModel | undefined)
    {
        if (this.PickUnit(value, this.unit.parent, (d, id) => d.Org.SetBusinessUnitParent(this.unit.id, id), BusinessUnitRowViewModel.SelectedParentProperty, () => this.SelectedParent))
        {
            this.host.RefreshUnitTree()
        }
    }

    // Sets the row's depth and parent choices; the choice list is replaced
    // only when it offers different units (or `relabel`: names changed).
    public SetTree(depth: number, choices: UnitChoices, relabel: boolean): void
    {
        const oldIndent = this.Indent
        this.depth = depth
        const previous = this.choices
        const same = previous !== undefined && previous.Ids.join('\n') === choices.Ids.join('\n')
        if (!same || relabel)
        {
            this.choices = choices
            this.RaisePropertyChanged(BusinessUnitRowViewModel.ParentOptionsProperty, previous?.Options, choices.Options)
        }
        this.RaisePropertyChanged(BusinessUnitRowViewModel.IndentProperty, oldIndent, this.Indent)
        this.RaisePropertyChanged(BusinessUnitRowViewModel.SelectedParentProperty, undefined, this.SelectedParent)
        this.RaisePropertyChanged(BusinessUnitRowViewModel.CanPickParentProperty, undefined, this.CanPickParent)
        // A parent change can add or drop this unit's children.
        this.RemoveCommand.RaiseCanExecuteChanged()
        this.RaisePropertyChanged(BusinessUnitRowViewModel.RemoveBlockedProperty, undefined, this.IsRemoveBlocked)
    }

    protected RemoveFrom(draft: SecurityModelDraft): void
    {
        draft.Org.RemoveBusinessUnit(this.unit.id)
    }
}

// One placed user: the unit they sit in (always exactly one), unplace.
export class UserPlacementRowViewModel extends OrgRowViewModel
{
    private static readonly SelectedUnitProperty = 'SelectedUnit'

    public constructor(host: ISecurityModelEditHost, private readonly placement: UserPlacementDto, private readonly choices: UnitChoices)
    {
        super(host)
    }

    public get PrincipalId(): string
    {
        return this.placement.principalId
    }

    public get UnitOptions(): ObservableCollection<UnitOptionViewModel>
    {
        return this.choices.Options
    }

    public get SelectedUnit(): UnitOptionViewModel
    {
        return this.choices.OptionFor(this.placement.businessUnitId)
    }

    // The choices omit "(none)": a placed user always sits in a unit. A move
    // changes which units can be removed, so the unit rows follow.
    public set SelectedUnit(value: UnitOptionViewModel)
    {
        if (this.PickUnit(value, this.placement.businessUnitId, (d, id) => { if (id !== undefined) d.Org.PlaceUser(this.placement.principalId, id) },
            UserPlacementRowViewModel.SelectedUnitProperty, () => this.SelectedUnit))
        {
            this.host.Rebuild(SecurityModelPart.Users)
        }
    }

    protected RemoveFrom(draft: SecurityModelDraft): void
    {
        draft.Org.UnplaceUser(this.placement.principalId)
    }
}

// One IdP group linked to a team; removing the link leaves manual members alone.
export class IdpGroupRowViewModel extends OrgRowViewModel
{
    public constructor(host: ISecurityModelEditHost, private readonly teamId: string, public readonly Group: string)
    {
        super(host)
    }

    protected RemoveFrom(draft: SecurityModelDraft): void
    {
        draft.Org.RemoveIdpGroup(this.teamId, this.Group)
    }
}

// One row of a team's members list. A synced row (from the identity provider)
// is never removable or editable; a manual row removes only the manual
// addition, so a principal who is also synced keeps their synced row.
export class TeamMemberRowViewModel extends OrgRowViewModel
{
    public constructor(host: ISecurityModelEditHost, private readonly teamId: string, public readonly PrincipalId: string,
        private readonly origin: TeamMemberOrigin, private readonly unsaved: boolean)
    {
        super(host)
    }

    public get Origin(): TeamMemberOrigin
    {
        return this.origin
    }

    public get OriginText(): string
    {
        return SecurityModelText.MemberOrigin(this.origin, this.unsaved)
    }

    public override get CanRemove(): boolean
    {
        return this.origin === TeamMemberOrigin.Manual
    }

    protected RemoveFrom(draft: SecurityModelDraft): void
    {
        draft.Org.RemoveManualMember(this.teamId, this.PrincipalId)
    }
}

// One team: rename, business unit, IdP group links, members, remove.
export class TeamRowViewModel extends OrgRowViewModel
{
    private static readonly NameProperty = 'Name'
    private static readonly SelectedUnitProperty = 'SelectedUnit'
    private static readonly NewIdpGroupProperty = 'NewIdpGroup'
    private static readonly NewManualMemberProperty = 'NewManualMember'
    private static readonly NoText = ''

    private readonly idpGroups = new ObservableCollection<IdpGroupRowViewModel>()
    private readonly addIdpGroupCommand: RelayCommand
    private readonly addManualMemberCommand: RelayCommand
    private readonly loadMembersCommand: RelayCommand
    private readonly members: ObservableCollection<TeamMemberRowViewModel>

    public constructor(host: ISecurityModelEditHost, private readonly team: TeamDto, private readonly choices: UnitChoices)
    {
        super(host)
        for (const group of team.idpGroups)
        {
            this.idpGroups.Add(new IdpGroupRowViewModel(host, team.id, group))
        }
        this.addIdpGroupCommand = new RelayCommand(() => this.AddIdpGroup(), () => this.host.CanEdit)
        this.addManualMemberCommand = new RelayCommand(() => this.AddManualMember(), () => this.host.CanEdit)
        // A team added in this draft has no server rows to read.
        this.loadMembersCommand = new RelayCommand(() => { void this.LoadMembers() }, () => this.host.IsSavedTeam(this.team.id))
        this.members = this.BuildMembers()
    }

    public get Id(): string
    {
        return this.team.id
    }

    public get Name(): string
    {
        return this.team.name
    }

    // A rename relabels the team in the grant pickers.
    public set Name(next: string)
    {
        if (this.EditText(next, () => this.team.name, d => d.Org.RenameTeam(this.team.id, next), TeamRowViewModel.NameProperty))
        {
            this.host.Rebuild(SecurityModelPart.Teams)
        }
    }

    public get UnitOptions(): ObservableCollection<UnitOptionViewModel>
    {
        return this.choices.Options
    }

    public get SelectedUnit(): UnitOptionViewModel
    {
        return this.choices.OptionFor(this.team.businessUnitId)
    }

    // The choices omit "(none)": a team always sits in a unit. A move
    // changes which units can be removed, so the unit rows follow.
    public set SelectedUnit(value: UnitOptionViewModel)
    {
        if (this.PickUnit(value, this.team.businessUnitId, (d, id) => { if (id !== undefined) d.Org.SetTeamBusinessUnit(this.team.id, id) },
            TeamRowViewModel.SelectedUnitProperty, () => this.SelectedUnit))
        {
            this.host.Rebuild(SecurityModelPart.Teams)
        }
    }

    public get IdpGroups(): ObservableCollection<IdpGroupRowViewModel>
    {
        return this.idpGroups
    }

    public get NewIdpGroup(): string
    {
        return this.host.TeamInput(this.team.id, TeamInputField.IdpGroup)
    }

    public set NewIdpGroup(value: string)
    {
        this.SetInput(TeamInputField.IdpGroup, value, TeamRowViewModel.NewIdpGroupProperty)
    }

    public get AddIdpGroupCommand(): RelayCommand
    {
        return this.addIdpGroupCommand
    }

    // The server's synced rows (once loaded) plus the draft's manual members,
    // each marked unsaved when it is not in the saved setting.
    public get Members(): ObservableCollection<TeamMemberRowViewModel>
    {
        return this.members
    }

    public get LoadMembersCommand(): RelayCommand
    {
        return this.loadMembersCommand
    }

    // Whether the server's rows (synced members) have been read for this team.
    public get AreMembersLoaded(): boolean
    {
        return this.host.ServerTeamMembers(this.team.id) !== undefined
    }

    // Shown while a saved team's synced members have not been read yet.
    public get ShowMembersHint(): boolean
    {
        return this.host.IsSavedTeam(this.team.id) && !this.AreMembersLoaded
    }

    public get MembersErrorText(): string
    {
        return this.host.TeamMembersError(this.team.id)
    }

    public get HasMembersError(): boolean
    {
        return this.MembersErrorText.length > 0
    }

    public get NewManualMember(): string
    {
        return this.host.TeamInput(this.team.id, TeamInputField.Member)
    }

    public set NewManualMember(value: string)
    {
        this.SetInput(TeamInputField.Member, value, TeamRowViewModel.NewManualMemberProperty)
    }

    public get AddManualMemberCommand(): RelayCommand
    {
        return this.addManualMemberCommand
    }

    // Reads the server's member rows. The editor owns the result and the
    // failure text and rebuilds the team rows; the draft is never touched.
    public async LoadMembers(): Promise<void>
    {
        if (this.host.IsSavedTeam(this.team.id))
        {
            await this.host.LoadTeamMembers(this.team.id)
        }
    }

    protected RemoveFrom(draft: SecurityModelDraft): void
    {
        draft.Org.RemoveTeam(this.team.id)
    }

    private AddIdpGroup(): void
    {
        const group = this.NewIdpGroup.trim()
        if (group.length > 0 && this.host.Apply(d => d.Org.AddIdpGroup(this.team.id, group)))
        {
            this.NewIdpGroup = TeamRowViewModel.NoText
            this.host.Rebuild()
        }
    }

    private AddManualMember(): void
    {
        const id = this.NewManualMember.trim()
        if (id.length > 0 && this.host.Apply(d => d.Org.AddManualMember(this.team.id, id)))
        {
            this.NewManualMember = TeamRowViewModel.NoText
            this.host.Rebuild()
        }
    }

    private SetInput(field: TeamInputField, value: unknown, property: string): void
    {
        const old = this.host.TeamInput(this.team.id, field)
        this.host.SetTeamInput(this.team.id, field, typeof value === 'string' ? value : TeamRowViewModel.NoText)
        this.RaisePropertyChanged(property, old, this.host.TeamInput(this.team.id, field))
    }

    // Synced rows come from the server (once read); manual rows are the
    // draft's list, marked unsaved when the saved setting lacks them.
    private BuildMembers(): ObservableCollection<TeamMemberRowViewModel>
    {
        const rows = new ObservableCollection<TeamMemberRowViewModel>()
        const saved = this.host.SavedManualMembers(this.team.id)
        for (const row of this.host.ServerTeamMembers(this.team.id) ?? [])
        {
            if (row.origin === TeamMemberOrigin.Synced)
            {
                rows.Add(new TeamMemberRowViewModel(this.host, this.team.id, row.principalId, TeamMemberOrigin.Synced, false))
            }
        }
        for (const id of this.team.manualMembers)
        {
            rows.Add(new TeamMemberRowViewModel(this.host, this.team.id, id, TeamMemberOrigin.Manual, !saved.includes(id)))
        }
        return rows
    }
}
