import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { EnvironmentRow } from '../../environment-row.js'
import type { EnvironmentDto, HiveHealthDto } from '../../tenant-types.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { BestEffort } from './best-effort.js'
import { CreateEnvironmentDialogViewModel } from './create-environment-dialog-view-model.js'
import { EnvironmentPillViewModel } from './environment-pill-view-model.js'
import type { EnvironmentsSectionService } from './environments-section-service.js'

// Who keeps the table's selection: rows read and write it by name, so it
// survives a reload and a filter change.
export interface IEnvironmentSelection
{
    IsSelected(name: string): boolean
    SetSelected(name: string, selected: boolean): void
}

// One environments-table row: the environment (opens its detail), its
// status, version, health and live address, and its selection checkbox.
export class EnvironmentTableRowViewModel extends Observable
{
    private static readonly IsSelectedProperty = 'IsSelected'
    private static readonly SubSeparator = ' \u00b7 '
    private static readonly StoppedText = 'Stopped'
    private static readonly NotServingText = 'Not serving'

    private readonly openCommand: RelayCommand
    private readonly statusPill: EnvironmentPillViewModel
    private readonly healthPill: EnvironmentPillViewModel

    public constructor(public readonly Row: EnvironmentRow, private readonly selection: IEnvironmentSelection, open: (name: string) => void)
    {
        super()
        this.openCommand = new RelayCommand(() => open(this.Row.Name))
        this.statusPill = EnvironmentPillViewModel.Status(Row)
        this.healthPill = EnvironmentPillViewModel.Health(Row)
    }

    public get Name(): string
    {
        return this.Row.Name
    }

    // The sub-line under the name: environment id and template.
    public get SubText(): string
    {
        return this.Row.EnvironmentId + EnvironmentTableRowViewModel.SubSeparator + this.Row.Template
    }

    public get StatusPill(): EnvironmentPillViewModel
    {
        return this.statusPill
    }

    public get HealthPill(): EnvironmentPillViewModel
    {
        return this.healthPill
    }

    public get Version(): string
    {
        return this.Row.Version
    }

    // The live URL while running; otherwise why there is none.
    public get UrlText(): string
    {
        const url = this.Row.Url
        if (url !== undefined)
        {
            return url
        }
        return this.Row.IsStopped ? EnvironmentTableRowViewModel.StoppedText : EnvironmentTableRowViewModel.NotServingText
    }

    public get IsServing(): boolean
    {
        return this.Row.Url !== undefined
    }

    public get IsNotServing(): boolean
    {
        return !this.IsServing
    }

    public get IsSelected(): boolean
    {
        return this.selection.IsSelected(this.Row.Name)
    }

    public set IsSelected(value: boolean)
    {
        const old = this.IsSelected
        if (old === value)
        {
            return
        }
        this.selection.SetSelected(this.Row.Name, value)
        this.RaisePropertyChanged(EnvironmentTableRowViewModel.IsSelectedProperty, old, value)
    }

    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }

    // Re-reads the selection after the owner changed it (select all, clear).
    public RaiseSelectionChanged(): void
    {
        this.RaisePropertyChanged(EnvironmentTableRowViewModel.IsSelectedProperty, !this.IsSelected, this.IsSelected)
    }
}

// The Environments list: a filterable table of the tenant's environments with
// per-row selection, bulk Start / Restart / Stop over the selection (each only
// where it applies), and Create environment. Bulk actions run one environment
// at a time; the first refusal is reported, then the selection clears and the
// list reloads. Health is best-effort: a failed health read leaves Unknown.
export class EnvironmentsPageViewModel extends TenantPageViewModel implements IEnvironmentSelection
{
    private static readonly RowsProperty = 'Rows'
    private static readonly FilterProperty = 'Filter'
    private static readonly AllSelectedProperty = 'AllSelected'
    private static readonly HasSelectionProperty = 'HasSelection'
    private static readonly SelectionTextProperty = 'SelectionText'
    private static readonly HasNoMatchesProperty = 'HasNoMatches'
    private static readonly SelectionTemplate = '{count} selected'
    private static readonly CountToken = '{count}'
    private static readonly NoText = ''
    private static readonly StopTitleTemplate = 'Stop {count} environment(s)?'
    private static readonly StopMessagePrefix = 'Stops: '
    private static readonly NameSeparator = ', '
    private static readonly StopLabel = 'Stop'
    private static readonly StopConsequences: readonly string[] = [
        'Their live URLs stop serving until they are started again.',
        'Their data is kept.',
    ]

    private all: EnvironmentRow[] = []
    private rows = new ObservableCollection<EnvironmentTableRowViewModel>()
    private filter = ''
    private selected = new Set<string>()
    private readonly createCommand: RelayCommand
    private readonly startCommand: RelayCommand
    private readonly restartCommand: RelayCommand
    private readonly stopCommand: RelayCommand

    public constructor(session: TenantSessionService, private readonly section: EnvironmentsSectionService)
    {
        super(session)
        const E = AdminCapability.Environments
        this.createCommand = this.MutatingCommand(E, () => this.Create())
        this.startCommand = this.MutatingCommand(E, () => this.RunBulk(r => r.IsStopped, n => this.Session.Client.StartEnvironment(n)),
            () => this.AnySelected(r => r.IsStopped))
        this.restartCommand = this.MutatingCommand(E, () => this.RunBulk(r => r.IsRunning, n => this.Session.Client.RestartEnvironment(n)),
            () => this.AnySelected(r => r.IsRunning))
        this.stopCommand = this.MutatingCommand(E, () => this.ConfirmBulkStop(),
            () => this.AnySelected(r => r.IsRunning))
    }

    // The filtered rows the table shows.
    public get Rows(): ObservableCollection<EnvironmentTableRowViewModel>
    {
        return this.rows
    }

    // Matches name, environment id or version, ignoring case.
    public get Filter(): string
    {
        return this.filter
    }

    public set Filter(value: string)
    {
        const old = this.filter
        if (old === value)
        {
            return
        }
        this.filter = value
        this.RaisePropertyChanged(EnvironmentsPageViewModel.FilterProperty, old, value)
        this.RebuildRows()
        this.DropHiddenSelections()
    }

    // Whether the filter hides every environment (there are some).
    public get HasNoMatches(): boolean
    {
        return this.all.length > 0 && this.rows.Count === 0
    }

    // The header checkbox: every shown row selected. Setting it selects (or
    // clears) exactly the shown rows.
    public get AllSelected(): boolean
    {
        const rows = this.rows.ToArray()
        return rows.length > 0 && rows.every(r => this.selected.has(r.Name))
    }

    public set AllSelected(value: boolean)
    {
        if (value === this.AllSelected)
        {
            return
        }
        const before = this.SelectionSnapshot()
        for (const row of this.rows.ToArray())
        {
            if (value)
            {
                this.selected.add(row.Name)
            }
            else
            {
                this.selected.delete(row.Name)
            }
            row.RaiseSelectionChanged()
        }
        this.RaiseSelectionChanged(before)
    }

    public get HasSelection(): boolean
    {
        return this.selected.size > 0
    }

    public get SelectionText(): string
    {
        return EnvironmentsPageViewModel.SelectionTemplate.replace(EnvironmentsPageViewModel.CountToken, String(this.selected.size))
    }

    // The names currently selected, in table order.
    public get SelectedNames(): readonly string[]
    {
        return this.all.filter(r => this.selected.has(r.Name)).map(r => r.Name)
    }

    public get CreateCommand(): RelayCommand
    {
        return this.createCommand
    }

    public get StartCommand(): RelayCommand
    {
        return this.startCommand
    }

    public get RestartCommand(): RelayCommand
    {
        return this.restartCommand
    }

    public get StopCommand(): RelayCommand
    {
        return this.stopCommand
    }

    public IsSelected(name: string): boolean
    {
        return this.selected.has(name)
    }

    public SetSelected(name: string, selected: boolean): void
    {
        if (this.selected.has(name) === selected)
        {
            return
        }
        const before = this.SelectionSnapshot()
        if (selected)
        {
            this.selected.add(name)
        }
        else
        {
            this.selected.delete(name)
        }
        this.RaiseSelectionChanged(before)
    }

    public ClearSelection(): void
    {
        const before = this.SelectionSnapshot()
        this.selected.clear()
        for (const row of this.rows.ToArray())
        {
            row.RaiseSelectionChanged()
        }
        this.RaiseSelectionChanged(before)
    }

    protected override get PageCapability(): AdminCapability
    {
        return AdminCapability.Environments
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const environments = await this.Session.Client.ListEnvironments()
        const health = await this.LoadHealth(environments)
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.all = environments.map(e => new EnvironmentRow(e, health.get(e.name)))
        const names = new Set(this.all.map(r => r.Name))
        const before = this.SelectionSnapshot()
        this.selected = new Set([...this.selected].filter(n => names.has(n)))
        this.RebuildRows()
        this.RaiseSelectionChanged(before)
        return this.all.length > 0
    }

    // Health per hive the environments are bound to; one hive failing
    // degrades only its own rows (a 401 still expires the session).
    private async LoadHealth(environments: readonly EnvironmentDto[]): Promise<Map<string, HiveHealthDto>>
    {
        const hives = new Set<string>()
        // An environment without its own hive is on the tenant's one hive
        // (as the detail page reads it).
        if (environments.some(e => e.hiveId === undefined || e.hiveId === EnvironmentsPageViewModel.NoText))
        {
            const fallback = await BestEffort.Or(this.Session.ResolveHiveId(), undefined)
            if (fallback !== undefined)
            {
                hives.add(fallback)
            }
        }
        for (const e of environments)
        {
            if (e.hiveId !== undefined && e.hiveId !== EnvironmentsPageViewModel.NoText)
            {
                hives.add(e.hiveId)
            }
        }
        const lists = await Promise.all([...hives].map(h => BestEffort.Or(this.Session.Client.GetHealth(h), [] as HiveHealthDto[])))
        const map = new Map<string, HiveHealthDto>()
        for (const list of lists)
        {
            for (const h of list)
            {
                map.set(h.environmentName, h)
            }
        }
        return map
    }

    private RebuildRows(): void
    {
        const needle = this.filter.trim().toLowerCase()
        const shown = needle.length === 0
            ? this.all
            : this.all.filter(r => r.Name.toLowerCase().includes(needle)
                || r.EnvironmentId.toLowerCase().includes(needle)
                || r.Version.toLowerCase().includes(needle))
        const before = [this.AllSelected, this.HasNoMatches] as const
        const old = this.rows
        // A fresh collection each time: the table re-binds to it in one step.
        this.rows = new ObservableCollection<EnvironmentTableRowViewModel>()
        for (const row of shown)
        {
            this.rows.Add(new EnvironmentTableRowViewModel(row, this, name => this.section.OpenEnvironment(name)))
        }
        const P = EnvironmentsPageViewModel
        this.RaisePropertyChanged(P.RowsProperty, old, this.rows)
        this.RaisePropertyChanged(P.AllSelectedProperty, before[0], this.AllSelected)
        this.RaisePropertyChanged(P.HasNoMatchesProperty, before[1], this.HasNoMatches)
    }

    // Bulk actions act on what the operator can see: a selected environment
    // the filter now hides is unselected.
    private DropHiddenSelections(): void
    {
        const shown = new Set(this.rows.ToArray().map(r => r.Name))
        if ([...this.selected].every(n => shown.has(n)))
        {
            return
        }
        const before = this.SelectionSnapshot()
        this.selected = new Set([...this.selected].filter(n => shown.has(n)))
        this.RaiseSelectionChanged(before)
    }

    private SelectionSnapshot(): readonly [boolean, boolean, string]
    {
        return [this.AllSelected, this.HasSelection, this.SelectionText]
    }

    private RaiseSelectionChanged(before: readonly [boolean, boolean, string]): void
    {
        const P = EnvironmentsPageViewModel
        this.RaisePropertyChanged(P.AllSelectedProperty, before[0], this.AllSelected)
        this.RaisePropertyChanged(P.HasSelectionProperty, before[1], this.HasSelection)
        this.RaisePropertyChanged(P.SelectionTextProperty, before[2], this.SelectionText)
        this.RaiseMutatingCommandsChanged()
    }

    private AnySelected(applies: (row: EnvironmentRow) => boolean): boolean
    {
        return this.all.some(r => this.selected.has(r.Name) && applies(r))
    }

    // Runs `act` on each selected environment it applies to, one at a time.
    // A 401 stops at once (the session expires); any other refusal is kept
    // and the rest still run. Then the selection clears and the list reloads,
    // and the first refusal (if any) is reported.
    private async RunBulk(applies: (row: EnvironmentRow) => boolean, act: (name: string) => Promise<unknown>): Promise<void>
    {
        const names = this.all.filter(r => this.selected.has(r.Name) && applies(r)).map(r => r.Name)
        let firstError: unknown
        for (const name of names)
        {
            try
            {
                await act(name)
            }
            catch (e)
            {
                BestEffort.RethrowUnauthorized(e)
                firstError ??= e
            }
        }
        this.ClearSelection()
        await this.Refresh()
        if (firstError !== undefined)
        {
            throw firstError
        }
    }

    // Stop takes environments out of service, so it asks first, naming them.
    private ConfirmBulkStop(): Promise<void>
    {
        const P = EnvironmentsPageViewModel
        const names = this.all.filter(r => this.selected.has(r.Name) && r.IsRunning).map(r => r.Name)
        return this.Confirm(this.section.Dialogs, {
            Capability: AdminCapability.Environments,
            Title: P.StopTitleTemplate.replace(P.CountToken, String(names.length)),
            Message: P.StopMessagePrefix + names.join(P.NameSeparator),
            Consequences: P.StopConsequences,
            ConfirmLabel: P.StopLabel,
            Action: async () => { },
            OnConfirmed: () => this.RunBulk(r => r.IsRunning, n => this.Session.Client.StopEnvironment(n)),
        })
    }

    // A created environment opens its detail; the list reloads under it.
    private Create(): Promise<void>
    {
        return this.OpenCreate(this.section.Dialogs,
            dialogs => new CreateEnvironmentDialogViewModel(this.Session, dialogs, this.all.map(r => r.Name)),
            CreateEnvironmentDialogViewModel.Title, async created =>
            {
                this.section.OpenEnvironment(created.name)
                await this.Refresh()
            })
    }
}
