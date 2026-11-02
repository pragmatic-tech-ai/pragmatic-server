import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { RecordSharingRowData } from './record-sharing.js'
import type { SecurityModelDraft } from './security-model-draft.js'
import { SecurityModelPart, type ISecurityModelEditHost } from './security-model-edit-host.js'
import { AccessLevel, Actions, FieldPermission, PrivilegeAction } from './security-model-enums.js'
import { SecurityModelText } from './security-model-text.js'

// One role in the role list: its name and how many people hold it directly.
// Kept per role id across rebuilds, so the list's selection survives them.
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

// One field profile in the profile list. Kept per profile id across rebuilds.
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

// One cell of the privilege matrix: the selected role's level for one
// concept and action. Its command cycles the level None -> User -> Business
// unit -> Business unit and children -> Organization -> None.
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
        return this.draft.LevelFor(this.row.Concept, this.Action)
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
        if (!this.host.Apply(d => { d.CycleLevel(this.row.Concept, this.Action) }))
        {
            return
        }
        this.RaisePropertyChanged(PrivilegeCellViewModel.GlyphProperty, before[0], this.Glyph)
        this.RaisePropertyChanged(PrivilegeCellViewModel.LevelNameProperty, before[1], this.LevelName)
        this.row.LevelsChanged()
        this.host.RebuildPart(SecurityModelPart.RecordSharing)
    }
}

// One concept row of the privilege matrix for the selected role: a cell per
// action (one property each, so the row template's Grid columns line up with
// the header's) and the plain-words sentence.
export class PrivilegeRowViewModel extends Observable
{
    private static readonly SentenceProperty = 'Sentence'

    private readonly cells = new Map<PrivilegeAction, PrivilegeCellViewModel>()

    public constructor(host: ISecurityModelEditHost, private readonly draft: SecurityModelDraft, public readonly Concept: string)
    {
        super()
        for (const action of Actions)
        {
            this.cells.set(action, new PrivilegeCellViewModel(host, draft, this, action))
        }
    }

    public get Sentence(): string
    {
        return SecurityModelText.Sentence(action => this.draft.LevelFor(this.Concept, action))
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

// One secured field of the selected field profile: a checkbox per permission
// (Read / Update / Create) and Remove (drops the field from every profile).
export class FieldGrantRowViewModel extends Observable
{
    private static readonly LabelSeparator = '.'
    private static readonly CanReadProperty = 'CanRead'
    private static readonly CanUpdateProperty = 'CanUpdate'
    private static readonly CanCreateProperty = 'CanCreate'

    private readonly removeCommand: RelayCommand

    public constructor(
        private readonly host: ISecurityModelEditHost,
        private readonly draft: SecurityModelDraft,
        public readonly Concept: string,
        public readonly Field: string)
    {
        super()
        this.removeCommand = new RelayCommand(() => this.Remove(), () => this.host.CanEdit)
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
        return this.draft.FieldGrant(this.Concept, this.Field, FieldPermission.Read)
    }

    public set CanRead(value: boolean)
    {
        this.SetGrant(FieldPermission.Read, value, FieldGrantRowViewModel.CanReadProperty)
    }

    public get CanUpdate(): boolean
    {
        return this.draft.FieldGrant(this.Concept, this.Field, FieldPermission.Update)
    }

    public set CanUpdate(value: boolean)
    {
        this.SetGrant(FieldPermission.Update, value, FieldGrantRowViewModel.CanUpdateProperty)
    }

    public get CanCreate(): boolean
    {
        return this.draft.FieldGrant(this.Concept, this.Field, FieldPermission.Create)
    }

    public set CanCreate(value: boolean)
    {
        this.SetGrant(FieldPermission.Create, value, FieldGrantRowViewModel.CanCreateProperty)
    }

    public get RemoveCommand(): RelayCommand
    {
        return this.removeCommand
    }

    public Remove(): void
    {
        if (this.host.Apply(d => { d.RemoveSecuredField(this.Concept, this.Field) }))
        {
            this.host.Rebuild()
        }
    }

    // A refused edit re-raises the draft's value, so the checkbox snaps back.
    private SetGrant(permission: FieldPermission, value: boolean, property: string): void
    {
        const current = this.draft.FieldGrant(this.Concept, this.Field, permission)
        if (typeof value !== 'boolean' || value === current)
        {
            return
        }
        this.host.Apply(d => { d.SetFieldGrant(this.Concept, this.Field, permission, value) })
        this.RaisePropertyChanged(property, value, this.draft.FieldGrant(this.Concept, this.Field, permission))
    }
}

// One read-only record-sharing line: the concept, how far the role reaches
// in plain words, and whether it may share / assign those records.
export class RecordSharingRowViewModel extends Observable
{
    public constructor(private readonly data: RecordSharingRowData)
    {
        super()
    }

    public get Concept(): string
    {
        return this.data.concept
    }

    public get ScopeText(): string
    {
        return this.data.scopeText
    }

    public get CanShare(): boolean
    {
        return this.data.canShare
    }

    public get CanAssign(): boolean
    {
        return this.data.canAssign
    }
}
