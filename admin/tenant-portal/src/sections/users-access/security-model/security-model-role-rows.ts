import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { SecurityModelDraft } from './security-model-draft.js'
import type { ISecurityModelEditHost } from './security-model-edit-host.js'
import { AccessLevel, Actions, FieldPermission, PrivilegeAction } from './security-model-enums.js'
import { SecurityModelText } from './security-model-text.js'

// One catalog role in the role list: its name and how many people hold it
// directly. Kept per role name across rebuilds, so the list's selection
// survives them.
export class RoleItemViewModel extends Observable
{
    private static readonly LabelProperty = 'Label'
    private static readonly DirectTemplate = '{name} \u00b7 {count} direct'
    private static readonly NameToken = '{name}'
    private static readonly CountToken = '{count}'

    private name = ''
    private direct = 0

    public constructor(public readonly Id: string)
    {
        super()
    }

    public get Name(): string
    {
        return this.name
    }

    public get Label(): string
    {
        return RoleItemViewModel.DirectTemplate
            .replace(RoleItemViewModel.NameToken, this.name)
            .replace(RoleItemViewModel.CountToken, String(this.direct))
    }

    public Update(name: string, direct: number): void
    {
        const old = this.Label
        this.name = name
        this.direct = direct
        this.RaisePropertyChanged(RoleItemViewModel.LabelProperty, old, this.Label)
    }
}

// One catalog field profile in the profile list. Kept per profile name across rebuilds.
export class ProfileItemViewModel extends Observable
{
    private static readonly LabelProperty = 'Label'

    private name = ''

    public constructor(public readonly Id: string)
    {
        super()
    }

    public get Label(): string
    {
        return this.name
    }

    public Update(name: string): void
    {
        const old = this.name
        this.name = name
        this.RaisePropertyChanged(ProfileItemViewModel.LabelProperty, old, name)
    }
}

// One cell of the privilege matrix: the selected role's effective level (its
// override, else the catalog default) for one concept and action. Its command
// cycles through the levels the concept allows; landing on the default clears
// the override.
export class PrivilegeCellViewModel extends Observable
{
    private static readonly GlyphProperty = 'Glyph'
    private static readonly LevelNameProperty = 'LevelName'

    private readonly cycleCommand: RelayCommand

    public constructor(
        private readonly host: ISecurityModelEditHost,
        private readonly draft: SecurityModelDraft,
        private readonly row: PrivilegeRowViewModel,
        public readonly Action: PrivilegeAction)
    {
        super()
        this.cycleCommand = new RelayCommand(() => this.Cycle(), () => this.host.CanEdit)
    }

    public get Level(): AccessLevel
    {
        return this.draft.Overrides.EffectiveLevel(this.row.Role, this.row.Concept, this.Action)
    }

    public get Glyph(): string
    {
        return SecurityModelText.Glyph(this.Level)
    }

    public get LevelName(): string
    {
        return SecurityModelText.LevelName(this.Level)
    }

    public get CycleCommand(): RelayCommand
    {
        return this.cycleCommand
    }

    // Moves to the next level; refused while editing is not allowed.
    public Cycle(): void
    {
        const before = [this.Glyph, this.LevelName] as const
        const levels = this.draft.Overrides.AllowedLevels(this.row.Concept)
        const next = levels[(levels.indexOf(this.Level) + 1) % levels.length]
        if (!this.host.Apply(d => { d.Overrides.SetLevel(this.row.Role, this.row.Concept, this.Action, next) }))
        {
            return
        }
        this.RaisePropertyChanged(PrivilegeCellViewModel.GlyphProperty, before[0], this.Glyph)
        this.RaisePropertyChanged(PrivilegeCellViewModel.LevelNameProperty, before[1], this.LevelName)
        this.row.LevelsChanged()
    }
}

// One concept row of the privilege matrix for the selected role: a cell per
// action (one property each, so the row template's Grid columns line up with
// the header's) and the plain-words sentence.
export class PrivilegeRowViewModel extends Observable
{
    private static readonly SentenceProperty = 'Sentence'

    private readonly cells = new Map<PrivilegeAction, PrivilegeCellViewModel>()

    public constructor(host: ISecurityModelEditHost, private readonly draft: SecurityModelDraft, public readonly Role: string, public readonly Concept: string)
    {
        super()
        for (const action of Actions)
        {
            this.cells.set(action, new PrivilegeCellViewModel(host, draft, this, action))
        }
    }

    public get Sentence(): string
    {
        return SecurityModelText.Sentence(action => this.draft.Overrides.EffectiveLevel(this.Role, this.Concept, action))
    }

    public Cell(action: PrivilegeAction): PrivilegeCellViewModel
    {
        return this.cells.get(action) as PrivilegeCellViewModel
    }

    public get Create(): PrivilegeCellViewModel
    {
        return this.Cell(PrivilegeAction.Create)
    }

    public get Read(): PrivilegeCellViewModel
    {
        return this.Cell(PrivilegeAction.Read)
    }

    public get Update(): PrivilegeCellViewModel
    {
        return this.Cell(PrivilegeAction.Update)
    }

    public get Delete(): PrivilegeCellViewModel
    {
        return this.Cell(PrivilegeAction.Delete)
    }

    public get Append(): PrivilegeCellViewModel
    {
        return this.Cell(PrivilegeAction.Append)
    }

    public get AppendTo(): PrivilegeCellViewModel
    {
        return this.Cell(PrivilegeAction.AppendTo)
    }

    public get Assign(): PrivilegeCellViewModel
    {
        return this.Cell(PrivilegeAction.Assign)
    }

    public get Share(): PrivilegeCellViewModel
    {
        return this.Cell(PrivilegeAction.Share)
    }

    public get Invoke(): PrivilegeCellViewModel
    {
        return this.Cell(PrivilegeAction.Invoke)
    }

    // A cell of this row changed level: the sentence follows.
    public LevelsChanged(): void
    {
        this.RaisePropertyChanged(PrivilegeRowViewModel.SentenceProperty, undefined, this.Sentence)
    }
}

// One line of the access-level legend.
export class LegendEntryViewModel extends Observable
{
    public constructor(private readonly level: AccessLevel)
    {
        super()
    }

    public get Line(): string
    {
        return SecurityModelText.LegendLine(this.level)
    }
}

// One catalog secured field of the selected field profile: a checkbox per
// permission (Read / Update / Create) over the effective access (the
// profile's override, else its catalog default).
export class FieldGrantRowViewModel extends Observable
{
    private static readonly LabelSeparator = '.'
    private static readonly CanReadProperty = 'CanRead'
    private static readonly CanUpdateProperty = 'CanUpdate'
    private static readonly CanCreateProperty = 'CanCreate'

    public constructor(
        private readonly host: ISecurityModelEditHost,
        private readonly draft: SecurityModelDraft,
        public readonly Profile: string,
        public readonly Concept: string,
        public readonly Field: string)
    {
        super()
    }

    public get Label(): string
    {
        return this.Concept + FieldGrantRowViewModel.LabelSeparator + this.Field
    }

    public get CanEdit(): boolean
    {
        return this.host.CanEdit
    }

    public get CanRead(): boolean
    {
        return this.Granted(FieldPermission.Read)
    }

    public set CanRead(value: boolean)
    {
        this.SetGrant(FieldPermission.Read, value, FieldGrantRowViewModel.CanReadProperty)
    }

    public get CanUpdate(): boolean
    {
        return this.Granted(FieldPermission.Update)
    }

    public set CanUpdate(value: boolean)
    {
        this.SetGrant(FieldPermission.Update, value, FieldGrantRowViewModel.CanUpdateProperty)
    }

    public get CanCreate(): boolean
    {
        return this.Granted(FieldPermission.Create)
    }

    public set CanCreate(value: boolean)
    {
        this.SetGrant(FieldPermission.Create, value, FieldGrantRowViewModel.CanCreateProperty)
    }

    private Granted(permission: FieldPermission): boolean
    {
        return this.draft.Overrides.EffectiveField(this.Profile, this.Concept, this.Field).Has(permission)
    }

    // A refused edit re-raises the draft's value, so the checkbox snaps back.
    private SetGrant(permission: FieldPermission, value: boolean, property: string): void
    {
        if (typeof value !== 'boolean' || value === this.Granted(permission))
        {
            return
        }
        this.host.Apply(d => { d.Overrides.SetField(this.Profile, this.Concept, this.Field, permission, value) })
        this.RaisePropertyChanged(property, value, this.Granted(permission))
    }
}
