import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { BusinessUnitDto, TeamDto } from '../../../tenant-types.js'
import type { SecurityModelDraft } from './security-model-draft.js'
import { SecurityModelPart, type ISecurityModelEditHost } from './security-model-edit-host.js'

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

// One set of unit choices ("(none)" first, then units) and the lookup from a
// unit id to its choice.
export class UnitChoices
{
    public readonly Options: ObservableCollection<UnitOptionViewModel>

    public constructor(private readonly none: UnitOptionViewModel, private readonly units: ReadonlyMap<string, UnitOptionViewModel>, ids: readonly string[])
    {
        this.Options = new ObservableCollection<UnitOptionViewModel>()
        this.Options.Add(none)
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
        this.removeCommand = new RelayCommand(() => this.Remove(), () => this.host.CanEdit)
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
        if (this.host.Apply(d => this.RemoveFrom(d)))
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
// descendants; a cycle is refused), remove. Indented by its depth.
export class BusinessUnitRowViewModel extends OrgRowViewModel
{
    private static readonly NameProperty = 'Name'
    private static readonly IndentProperty = 'Indent'
    private static readonly ParentOptionsProperty = 'ParentOptions'
    private static readonly SelectedParentProperty = 'SelectedParent'
    private static readonly IndentUnit = '\u00a0\u00a0\u00a0\u00a0'

    private depth = 0
    private choices: UnitChoices | undefined

    public constructor(host: ISecurityModelEditHost, private readonly unit: BusinessUnitDto)
    {
        super(host)
    }

    public get Id(): string
    {
        return this.unit.id
    }

    public get Parent(): string | undefined
    {
        return this.unit.parent
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
    }

    protected RemoveFrom(draft: SecurityModelDraft): void
    {
        draft.Org.RemoveBusinessUnit(this.unit.id)
    }
}

// One team: rename, business unit, remove.
export class TeamRowViewModel extends OrgRowViewModel
{
    private static readonly NameProperty = 'Name'
    private static readonly SelectedUnitProperty = 'SelectedUnit'

    public constructor(host: ISecurityModelEditHost, private readonly team: TeamDto, private readonly choices: UnitChoices)
    {
        super(host)
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

    // A team always sits in a unit: picking "(none)" is refused and snaps back.
    public set SelectedUnit(value: UnitOptionViewModel)
    {
        this.PickUnit(value, this.team.businessUnitId, (d, id) => { if (id !== undefined) d.Org.SetTeamBusinessUnit(this.team.id, id) },
            TeamRowViewModel.SelectedUnitProperty, () => this.SelectedUnit)
    }

    protected RemoveFrom(draft: SecurityModelDraft): void
    {
        draft.Org.RemoveTeam(this.team.id)
    }
}
