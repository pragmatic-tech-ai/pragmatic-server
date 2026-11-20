import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { AdminCapability } from '../../shell/admin-capability.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { ConfigurationApplyOutcome } from '../../tenant-types.js'
import type { ConfigurationApplyDto, ConfigurationComponentDetailDto, ConfigurationDiffDto, ConfigurationTargetDto } from '../../tenant-types.js'
import { ConfigurationEditorViewModel } from './configuration-editor-view-model.js'
import type { IConfigurationNavigator } from './configuration-page-view-model.js'
import { ConfigurationApplyRowViewModel, ConfigurationChangeRowViewModel, ConfigurationSettingRowViewModel, ConfigurationTargetRowViewModel, ConfigurationText, ConfigurationVersionRowViewModel } from './configuration-rows.js'

// One component's configuration: the settings its descriptor declares, its versions (view one, compare two), its
// targets and applies; and, for a session holding the settings permission (the tenant admin role), a new version
// edited as JSON from the head, and applying a version to one of its target environments. The server stays the
// gate: it validates every saved document (secret settings take secret references, never values) and refuses a save
// based on a head that has moved.
export class ComponentConfigurationPageViewModel extends TenantPageViewModel
{
    private static readonly SettingRowsProperty = 'SettingRows'
    private static readonly VersionRowsProperty = 'VersionRows'
    private static readonly TargetRowsProperty = 'TargetRows'
    private static readonly ApplyRowsProperty = 'ApplyRows'
    private static readonly HasSettingsProperty = 'HasSettings'
    private static readonly HasVersionsProperty = 'HasVersions'
    private static readonly HasTargetsProperty = 'HasTargets'
    private static readonly HasAppliesProperty = 'HasApplies'
    private static readonly HasNoSettingsProperty = 'HasNoSettings'
    private static readonly HasNoVersionsProperty = 'HasNoVersions'
    private static readonly HasNoTargetsProperty = 'HasNoTargets'
    private static readonly ComponentVersionTextProperty = 'ComponentVersionText'
    private static readonly HeadTextProperty = 'HeadText'
    private static readonly ViewedTitleProperty = 'ViewedTitle'
    private static readonly ViewedDocumentTextProperty = 'ViewedDocumentText'
    private static readonly HasViewedProperty = 'HasViewed'
    private static readonly FromOptionsProperty = 'FromOptions'
    private static readonly ToOptionsProperty = 'ToOptions'
    private static readonly SelectedFromProperty = 'SelectedFrom'
    private static readonly SelectedToProperty = 'SelectedTo'
    private static readonly ChangeRowsProperty = 'ChangeRows'
    private static readonly HasChangesProperty = 'HasChanges'
    private static readonly DiffSummaryTextProperty = 'DiffSummaryText'
    private static readonly ApplyVersionOptionsProperty = 'ApplyVersionOptions'
    private static readonly TargetOptionsProperty = 'TargetOptions'
    private static readonly SelectedApplyVersionProperty = 'SelectedApplyVersion'
    private static readonly SelectedTargetProperty = 'SelectedTarget'
    private static readonly NoticeTextProperty = 'NoticeText'
    private static readonly EditorTextProperty = 'Text'
    private static readonly ComponentVersionPrefix = 'Component version '
    private static readonly NoHead = 'No versions yet'
    private static readonly HeadPrefix = 'Head: '
    private static readonly SavedPrefix = 'Saved version '
    private static readonly AppliedPrefix = 'Applied version '
    private static readonly ApplyFailedPrefix = 'Applying version '
    private static readonly ToWord = ' to '
    private static readonly FailedWord = ' failed'
    private static readonly DetailSeparator = ': '
    private static readonly SentenceEnd = '.'
    private static readonly DiffNone = 'No differences '
    private static readonly OneChange = '1 change '
    private static readonly ChangesSuffix = ' changes '
    private static readonly FromEmpty = 'from the empty document'
    private static readonly FromVersion = 'from version '
    private static readonly ToVersion = ' to version '
    private static readonly EmptyDocumentVersion = 0
    private static readonly EmptyDocument = {}
    private static readonly NoText = ''

    private readonly editor = new ConfigurationEditorViewModel()
    private readonly compareCommand: RelayCommand
    private readonly saveCommand: RelayCommand
    private readonly reloadEditorCommand: RelayCommand
    private readonly applyCommand: RelayCommand
    private detail: ConfigurationComponentDetailDto | undefined
    private head: number | null = null
    private settingRows = new ObservableCollection<ConfigurationSettingRowViewModel>()
    private versionRows = new ObservableCollection<ConfigurationVersionRowViewModel>()
    private targetRows = new ObservableCollection<ConfigurationTargetRowViewModel>()
    private applyRows = new ObservableCollection<ConfigurationApplyRowViewModel>()
    private viewedVersion: number | undefined
    private viewedDocumentText = ComponentConfigurationPageViewModel.NoText
    private fromOptions = new ObservableCollection<OptionViewModel<number>>()
    private toOptions = new ObservableCollection<OptionViewModel<number>>()
    private selectedFrom: OptionViewModel<number> | undefined
    private selectedTo: OptionViewModel<number> | undefined
    private changeRows = new ObservableCollection<ConfigurationChangeRowViewModel>()
    private diffSummaryText = ComponentConfigurationPageViewModel.NoText
    private applyVersionOptions = new ObservableCollection<OptionViewModel<number>>()
    private targetOptions = new ObservableCollection<OptionViewModel<string>>()
    private selectedApplyVersion: OptionViewModel<number> | undefined
    private selectedTarget: OptionViewModel<string> | undefined
    private noticeText = ComponentConfigurationPageViewModel.NoText
    private resetEditor = true

    public constructor(session: TenantSessionService, private readonly navigator: IConfigurationNavigator, private readonly component: string)
    {
        super(session)
        this.compareCommand = new RelayCommand(() => { void this.Guard(() => this.Compare()) }, () => this.CanCompare)
        this.saveCommand = this.MutatingCommand(AdminCapability.Settings, () => this.Save(), () => this.editor.CanSave)
        this.reloadEditorCommand = new RelayCommand(() => { void this.ReloadEditor() })
        this.applyCommand = this.MutatingCommand(AdminCapability.Settings, () => this.Apply(),
            () => this.selectedApplyVersion !== undefined && this.selectedTarget !== undefined)
        this.editor.PropertyChanged(ComponentConfigurationPageViewModel.EditorTextProperty).subscribe(() => this.RaiseMutatingCommandsChanged())
    }

    public get Title(): string
    {
        return this.component
    }

    public get BackCommand(): RelayCommand
    {
        return this.navigator.BackCommand
    }

    public get ComponentVersionText(): string
    {
        return this.detail === undefined ? ComponentConfigurationPageViewModel.NoText : ComponentConfigurationPageViewModel.ComponentVersionPrefix + this.detail.componentVersion
    }

    public get HeadText(): string
    {
        return this.head === null ? ComponentConfigurationPageViewModel.NoHead : ComponentConfigurationPageViewModel.HeadPrefix + ConfigurationText.Version(this.head)
    }

    public get SettingRows(): ObservableCollection<ConfigurationSettingRowViewModel>
    {
        return this.settingRows
    }

    public get HasSettings(): boolean
    {
        return this.settingRows.Count > 0
    }

    public get HasNoSettings(): boolean
    {
        return !this.HasSettings
    }

    // The saved versions, newest first.
    public get VersionRows(): ObservableCollection<ConfigurationVersionRowViewModel>
    {
        return this.versionRows
    }

    public get HasVersions(): boolean
    {
        return this.versionRows.Count > 0
    }

    public get HasNoVersions(): boolean
    {
        return !this.HasVersions
    }

    public get TargetRows(): ObservableCollection<ConfigurationTargetRowViewModel>
    {
        return this.targetRows
    }

    public get HasTargets(): boolean
    {
        return this.targetRows.Count > 0
    }

    public get HasNoTargets(): boolean
    {
        return !this.HasTargets
    }

    // The applies, newest first.
    public get ApplyRows(): ObservableCollection<ConfigurationApplyRowViewModel>
    {
        return this.applyRows
    }

    public get HasApplies(): boolean
    {
        return this.applyRows.Count > 0
    }

    // The version whose document is shown; '' while none is.
    public get ViewedTitle(): string
    {
        return this.viewedVersion === undefined ? ComponentConfigurationPageViewModel.NoText : ConfigurationText.Version(this.viewedVersion)
    }

    public get ViewedDocumentText(): string
    {
        return this.viewedDocumentText
    }

    public get HasViewed(): boolean
    {
        return this.viewedVersion !== undefined
    }

    // Compare from: the empty document or any version; to: any version.
    public get FromOptions(): ObservableCollection<OptionViewModel<number>>
    {
        return this.fromOptions
    }

    public get ToOptions(): ObservableCollection<OptionViewModel<number>>
    {
        return this.toOptions
    }

    public get SelectedFrom(): OptionViewModel<number> | undefined
    {
        return this.selectedFrom
    }

    public set SelectedFrom(next: OptionViewModel<number> | undefined)
    {
        const old = this.selectedFrom
        if (old === next)
        {
            return
        }
        this.selectedFrom = next
        this.RaisePropertyChanged(ComponentConfigurationPageViewModel.SelectedFromProperty, old, next)
        this.compareCommand.RaiseCanExecuteChanged()
    }

    public get SelectedTo(): OptionViewModel<number> | undefined
    {
        return this.selectedTo
    }

    public set SelectedTo(next: OptionViewModel<number> | undefined)
    {
        const old = this.selectedTo
        if (old === next)
        {
            return
        }
        this.selectedTo = next
        this.RaisePropertyChanged(ComponentConfigurationPageViewModel.SelectedToProperty, old, next)
        this.compareCommand.RaiseCanExecuteChanged()
    }

    public get CompareCommand(): RelayCommand
    {
        return this.compareCommand
    }

    public get ChangeRows(): ObservableCollection<ConfigurationChangeRowViewModel>
    {
        return this.changeRows
    }

    public get HasChanges(): boolean
    {
        return this.changeRows.Count > 0
    }

    // What the last comparison found ("2 changes from the empty document to version 2."); '' before one ran.
    public get DiffSummaryText(): string
    {
        return this.diffSummaryText
    }

    // The new version being edited (shown with Save to those holding the settings permission).
    public get Editor(): ConfigurationEditorViewModel
    {
        return this.editor
    }

    public get SaveCommand(): RelayCommand
    {
        return this.saveCommand
    }

    // Starts the editor again from the current head, dropping the edit.
    public get ReloadEditorCommand(): RelayCommand
    {
        return this.reloadEditorCommand
    }

    public get ApplyVersionOptions(): ObservableCollection<OptionViewModel<number>>
    {
        return this.applyVersionOptions
    }

    // The component's target environments.
    public get TargetOptions(): ObservableCollection<OptionViewModel<string>>
    {
        return this.targetOptions
    }

    public get SelectedApplyVersion(): OptionViewModel<number> | undefined
    {
        return this.selectedApplyVersion
    }

    public set SelectedApplyVersion(next: OptionViewModel<number> | undefined)
    {
        const old = this.selectedApplyVersion
        if (old === next)
        {
            return
        }
        this.selectedApplyVersion = next
        this.RaisePropertyChanged(ComponentConfigurationPageViewModel.SelectedApplyVersionProperty, old, next)
        this.RaiseMutatingCommandsChanged()
    }

    public get SelectedTarget(): OptionViewModel<string> | undefined
    {
        return this.selectedTarget
    }

    public set SelectedTarget(next: OptionViewModel<string> | undefined)
    {
        const old = this.selectedTarget
        if (old === next)
        {
            return
        }
        this.selectedTarget = next
        this.RaisePropertyChanged(ComponentConfigurationPageViewModel.SelectedTargetProperty, old, next)
        this.RaiseMutatingCommandsChanged()
    }

    public get ApplyCommand(): RelayCommand
    {
        return this.applyCommand
    }

    // What the last save or apply did; '' when none.
    public get NoticeText(): string
    {
        return this.noticeText
    }

    // Edits need the settings permission (the tenant admin role); reads are open.
    protected override get PageCapability(): AdminCapability
    {
        return AdminCapability.Settings
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const client = this.Session.Client
        const [detail, components] = await Promise.all([client.GetConfigurationComponent(this.component), client.ListConfigurationComponents()])
        const listed = components.find(c => c.component === this.component)
        const head = listed?.head ?? ComponentConfigurationPageViewModel.HeadOf(detail)
        const reset = this.resetEditor || !this.editor.IsDirty
        const headDocument = reset && head !== null ? (await client.GetConfigurationVersion(this.component, head)).document : ComponentConfigurationPageViewModel.EmptyDocument
        if (generation !== this.LoadGeneration)
        {
            return true
        }
        this.Show(detail, head, listed?.targets ?? [])
        if (reset)
        {
            this.resetEditor = false
            this.editor.Reset(head ?? ComponentConfigurationPageViewModel.EmptyDocumentVersion, headDocument)
        }
        return true
    }

    private Show(detail: ConfigurationComponentDetailDto, head: number | null, targets: readonly ConfigurationTargetDto[]): void
    {
        const P = ComponentConfigurationPageViewModel
        const before = [this.ComponentVersionText, this.HeadText, this.HasSettings, this.HasVersions, this.HasTargets, this.HasApplies] as const
        this.detail = detail
        this.head = head
        const versions = [...detail.versions].sort((a, b) => b.version - a.version)
        this.SetRows(P.SettingRowsProperty, () => this.settingRows, r => { this.settingRows = r },
            detail.options.flatMap(o => o.settings.map(s => new ConfigurationSettingRowViewModel(o, s))))
        this.SetRows(P.VersionRowsProperty, () => this.versionRows, r => { this.versionRows = r },
            versions.map(v => new ConfigurationVersionRowViewModel(v, v.version === head,
                new RelayCommand(() => { void this.Guard(() => this.View(v.version)) }))))
        this.SetRows(P.TargetRowsProperty, () => this.targetRows, r => { this.targetRows = r }, targets.map(t => new ConfigurationTargetRowViewModel(t)))
        this.SetRows(P.ApplyRowsProperty, () => this.applyRows, r => { this.applyRows = r }, detail.applies.map(a => new ConfigurationApplyRowViewModel(a)))
        const versionNumbers = versions.map(v => v.version)
        this.ShowCompareOptions(versionNumbers, head)
        this.ShowApplyOptions(versionNumbers, head, targets)
        this.RaiseIfChanged(P.ComponentVersionTextProperty, before[0], this.ComponentVersionText)
        this.RaiseIfChanged(P.HeadTextProperty, before[1], this.HeadText)
        this.RaiseIfChanged(P.HasSettingsProperty, before[2], this.HasSettings)
        this.RaiseIfChanged(P.HasVersionsProperty, before[3], this.HasVersions)
        this.RaiseIfChanged(P.HasTargetsProperty, before[4], this.HasTargets)
        this.RaiseIfChanged(P.HasAppliesProperty, before[5], this.HasApplies)
        this.RaiseIfChanged(P.HasNoSettingsProperty, !before[2], this.HasNoSettings)
        this.RaiseIfChanged(P.HasNoVersionsProperty, !before[3], this.HasNoVersions)
        this.RaiseIfChanged(P.HasNoTargetsProperty, !before[4], this.HasNoTargets)
    }

    // The compare choices, keeping what was chosen when it still exists (from: the empty document, to: the head, by default).
    private ShowCompareOptions(versions: readonly number[], head: number | null): void
    {
        const P = ComponentConfigurationPageViewModel
        const from = this.selectedFrom?.Value ?? P.EmptyDocumentVersion
        const to = this.selectedTo?.Value ?? head ?? undefined
        const fromOptions = [new OptionViewModel(P.EmptyDocumentVersion, ConfigurationText.EmptyDocumentLabel), ...P.VersionOptions(versions)]
        const old = [this.fromOptions, this.toOptions] as const
        this.fromOptions = new ObservableCollection<OptionViewModel<number>>()
        this.toOptions = new ObservableCollection<OptionViewModel<number>>()
        fromOptions.forEach(o => this.fromOptions.Add(o))
        P.VersionOptions(versions).forEach(o => this.toOptions.Add(o))
        this.RaisePropertyChanged(P.FromOptionsProperty, old[0], this.fromOptions)
        this.RaisePropertyChanged(P.ToOptionsProperty, old[1], this.toOptions)
        this.SelectedFrom = this.fromOptions.ToArray().find(o => o.Value === from)
        this.SelectedTo = this.toOptions.ToArray().find(o => o.Value === to)
    }

    // The apply choices, keeping what was chosen when it still exists (the version: the head, by default).
    private ShowApplyOptions(versions: readonly number[], head: number | null, targets: readonly ConfigurationTargetDto[]): void
    {
        const P = ComponentConfigurationPageViewModel
        const version = this.selectedApplyVersion?.Value ?? head ?? undefined
        const environment = this.selectedTarget?.Value
        const old = [this.applyVersionOptions, this.targetOptions] as const
        this.applyVersionOptions = new ObservableCollection<OptionViewModel<number>>()
        this.targetOptions = new ObservableCollection<OptionViewModel<string>>()
        P.VersionOptions(versions).forEach(o => this.applyVersionOptions.Add(o))
        targets.forEach(t => this.targetOptions.Add(new OptionViewModel(t.environment, t.environment)))
        this.RaisePropertyChanged(P.ApplyVersionOptionsProperty, old[0], this.applyVersionOptions)
        this.RaisePropertyChanged(P.TargetOptionsProperty, old[1], this.targetOptions)
        this.SelectedApplyVersion = this.applyVersionOptions.ToArray().find(o => o.Value === version)
        this.SelectedTarget = this.targetOptions.ToArray().find(o => o.Value === environment)
    }

    private async View(version: number): Promise<void>
    {
        const P = ComponentConfigurationPageViewModel
        const shown = await this.Session.Client.GetConfigurationVersion(this.component, version)
        const before = [this.ViewedTitle, this.viewedDocumentText, this.HasViewed] as const
        this.viewedVersion = version
        this.viewedDocumentText = ConfigurationText.Document(shown.document)
        this.RaiseIfChanged(P.ViewedTitleProperty, before[0], this.ViewedTitle)
        this.RaiseIfChanged(P.ViewedDocumentTextProperty, before[1], this.viewedDocumentText)
        this.RaiseIfChanged(P.HasViewedProperty, before[2], this.HasViewed)
    }

    private get CanCompare(): boolean
    {
        return this.selectedFrom !== undefined && this.selectedTo !== undefined && this.selectedFrom.Value !== this.selectedTo.Value
    }

    private async Compare(): Promise<void>
    {
        const from = this.selectedFrom
        const to = this.selectedTo
        if (from === undefined || to === undefined || !this.CanCompare)
        {
            return
        }
        const diff = await this.Session.Client.DiffConfigurationVersions(this.component, from.Value, to.Value)
        const P = ComponentConfigurationPageViewModel
        const hadChanges = this.HasChanges
        this.SetRows(P.ChangeRowsProperty, () => this.changeRows, r => { this.changeRows = r }, diff.changes.map(c => new ConfigurationChangeRowViewModel(c)))
        this.RaiseIfChanged(P.HasChangesProperty, hadChanges, this.HasChanges)
        const old = this.diffSummaryText
        this.diffSummaryText = P.DiffSummary(diff)
        this.RaiseIfChanged(P.DiffSummaryTextProperty, old, this.diffSummaryText)
    }

    private async Save(): Promise<void>
    {
        const document = this.editor.Document
        if (document === undefined)
        {
            return
        }
        this.SetNotice(ComponentConfigurationPageViewModel.NoText)
        let saved: number
        try
        {
            saved = (await this.Session.Client.SaveConfigurationVersion(this.component, this.editor.BasedOn, document, this.editor.Comment.trim())).version
        }
        catch (e)
        {
            if (this.editor.ShowRefusal(e))
            {
                return
            }
            throw e
        }
        this.SetNotice(ComponentConfigurationPageViewModel.SavedPrefix + String(saved) + ComponentConfigurationPageViewModel.SentenceEnd)
        this.resetEditor = true
        await this.Refresh()
    }

    private async ReloadEditor(): Promise<void>
    {
        this.resetEditor = true
        await this.Refresh()
    }

    private async Apply(): Promise<void>
    {
        const version = this.selectedApplyVersion?.Value
        const environment = this.selectedTarget?.Value
        if (version === undefined || environment === undefined)
        {
            return
        }
        this.SetNotice(ComponentConfigurationPageViewModel.NoText)
        const record = await this.Session.Client.ApplyConfigurationVersion(this.component, version, environment)
        this.SetNotice(ComponentConfigurationPageViewModel.ApplyNotice(record))
        await this.Refresh()
    }

    private SetNotice(next: string): void
    {
        const old = this.noticeText
        this.noticeText = next
        this.RaiseIfChanged(ComponentConfigurationPageViewModel.NoticeTextProperty, old, next)
    }

    // Replaces one row collection and raises it.
    private SetRows<T>(name: string, read: () => ObservableCollection<T>, assign: (rows: ObservableCollection<T>) => void, rows: readonly T[]): void
    {
        const old = read()
        const next = new ObservableCollection<T>()
        rows.forEach(r => next.Add(r))
        assign(next)
        this.RaisePropertyChanged(name, old, next)
    }

    private RaiseIfChanged<T>(name: string, old: T, next: T): void
    {
        if (old !== next)
        {
            this.RaisePropertyChanged(name, old, next)
        }
    }

    private static HeadOf(detail: ConfigurationComponentDetailDto): number | null
    {
        return detail.versions.length === 0 ? null : Math.max(...detail.versions.map(v => v.version))
    }

    private static VersionOptions(versions: readonly number[]): OptionViewModel<number>[]
    {
        return versions.map(v => new OptionViewModel(v, ConfigurationText.Version(v)))
    }

    private static ApplyNotice(record: ConfigurationApplyDto): string
    {
        const P = ComponentConfigurationPageViewModel
        const what = String(record.version) + P.ToWord + record.environment
        if (record.outcome === ConfigurationApplyOutcome.Applied)
        {
            return P.AppliedPrefix + what + P.SentenceEnd
        }
        return P.ApplyFailedPrefix + what + P.FailedWord + (record.detail === null ? P.SentenceEnd : P.DetailSeparator + record.detail)
    }

    private static DiffSummary(diff: ConfigurationDiffDto): string
    {
        const P = ComponentConfigurationPageViewModel
        const count = diff.changes.length
        const lead = count === 0 ? P.DiffNone : count === 1 ? P.OneChange : String(count) + P.ChangesSuffix
        const from = diff.from === P.EmptyDocumentVersion ? P.FromEmpty : P.FromVersion + String(diff.from)
        return lead + from + P.ToVersion + String(diff.to) + P.SentenceEnd
    }
}
