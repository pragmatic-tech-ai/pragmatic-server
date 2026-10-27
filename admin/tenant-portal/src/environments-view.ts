import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { DataTemplate } from '@pragmatic-tech-ai/mural/basic/templates/data-template.js'
import { GridLength, GridUnitType } from '@pragmatic-tech-ai/mural/basic/panels/grid.js'
import { ButtonVariant } from '@pragmatic-tech-ai/mural/framework'
import { Checkbox } from '@pragmatic-tech-ai/mural/framework/toggles/checkbox.js'
import { DataGrid } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import { DataGridTemplateColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Act, ActVariant, KitGlyph, PillTone, ScreenHost, Section, SkeletonKind, StatusPill, Tones } from './kit/index.js'
import type { ScreenHostInputs } from './kit/index.js'
import type { EnvironmentRow } from './environment-row.js'
import { EnvironmentsViewModel } from './environments-view-model.js'
import type { ITenantNavigator, TenantEvent } from './tenant-types.js'
import { TenantApiError } from './tenant-api-client.js'
import { TenantViewBase } from './tenant-view-base.js'

// Tenant admin "Environments": searchable, multi-selectable grid of the hive's environments
// with per-row open, gated bulk start/restart/stop, and a gated Create action.
export class EnvironmentsView extends TenantViewBase
{
    public static readonly Title = 'Environments'
    public static readonly Sub = 'Running workspaces in your hive. Each serves Capability Maps at its own address.'
    public static readonly CreateLabel = 'Create environment'
    public static readonly StartLabel = 'Start'
    public static readonly RestartLabel = 'Restart'
    public static readonly StopLabel = 'Stop'
    public static readonly NeedManage = 'the Manage environments permission'
    public static readonly SearchPlaceholder = 'Filter environments'
    public static readonly BulkNote = 'Deleting is one environment at a time.'
    public static readonly EmptyTitle = 'No environments yet'
    public static readonly EmptyBody = 'Create your first environment to get a running workspace you can serve Capability Maps from.'
    public static readonly SelectHeader = 'Select'
    public static readonly EnvironmentHeader = 'Environment'
    public static readonly StatusHeader = 'Status'
    public static readonly ApplicationHeader = 'Application'
    public static readonly HealthHeader = 'Health'
    public static readonly UrlHeader = 'Live URL'
    public static readonly SubSeparator = ' \u00b7 '
    public static readonly ErrorSeparator = ' '
    public static readonly NoText = ''
    public static readonly StoppedText = 'Stopped'
    public static readonly NotServingText = 'Not serving'

    private readonly grid = new DataGrid()
    private readonly searchBox = new TextBox()
    private readonly headerBox = new Checkbox()
    private readonly body = new StackPanel()
    private readonly bulkSlot = new StackPanel()
    private readonly errorSlot = new StackPanel()
    private readonly errorLine = new TextBlock()
    private readonly subscriptions: IDisposable[] = []
    private suppressSearch = false
    private bulkShown = false
    private errorShown = false
    private localError: string | undefined
    private readonly headerListener = (): void => this.OnHeaderClicked()
    private host: ScreenHost | undefined
    private bulkActs: Act[] = []
    private createAct!: Act
    private createHandler: () => void = () => { }

    public constructor(private readonly vm: EnvironmentsViewModel)
    {
        super()
        this.Orientation = Orientation.Vertical
        this.searchBox.Placeholder = EnvironmentsView.SearchPlaceholder
        this.subscriptions.push(this.searchBox.PropertyChanged(TextBox.TextKey).subscribe(() => this.OnSearchChanged()))
        this.headerBox.AddClickHandler(this.headerListener)
        this.body.Orientation = Orientation.Vertical
        this.bulkSlot.Orientation = Orientation.Vertical
        this.errorSlot.Orientation = Orientation.Vertical
        this.errorLine.Foreground = Tones.Brush(PillTone.Danger)
        this.body.AddChild(this.searchBox)
        this.body.AddChild(this.errorSlot)
        this.body.AddChild(this.bulkSlot)
        this.body.AddChild(this.grid)
        this.BuildGrid()
        this.BuildChrome()
        const rebuild = (): void => this.Rebuild()
        const refreshState = (): void => this.RefreshState()
        for (const key of [EnvironmentsViewModel.RowsProperty, EnvironmentsViewModel.SelectionProperty, EnvironmentsViewModel.FilterProperty])
        {
            this.subscriptions.push(this.vm.PropertyChanged(key).subscribe(rebuild))
        }
        for (const key of [EnvironmentsViewModel.BusyProperty, EnvironmentsViewModel.ErrorProperty, EnvironmentsViewModel.ActionErrorProperty])
        {
            this.subscriptions.push(this.vm.PropertyChanged(key).subscribe(refreshState))
        }
        this.Rebuild()
    }

    // Names of the environments currently loaded (for the create dialog's uniqueness check).
    public ExistingNames(): readonly string[]
    {
        return this.vm.AllRows.map(r => r.Name)
    }

    // Test seam: the environments grid.
    public get Grid(): DataGrid
    {
        return this.grid
    }

    // Test seam: the state host (skeleton / error / empty / populated).
    public get Host(): ScreenHost
    {
        return this.host as ScreenHost
    }

    // Test seam: the header Create action.
    public get CreateAction(): Act
    {
        return this.createAct
    }

    // Test seam: the bulk Start/Restart/Stop actions; empty unless a selection exists.
    public get BulkActions(): readonly Act[]
    {
        return this.bulkShown ? this.bulkActs : []
    }

    // Test seam: the inline error text shown above the grid, or undefined when hidden.
    public get InlineError(): string | undefined
    {
        return this.errorShown ? this.errorLine.Text : undefined
    }

    // Test seam: the search box.
    public get SearchBox(): TextBox
    {
        return this.searchBox
    }

    // Test seam: the header select-all checkbox.
    public get HeaderCheckbox(): Checkbox
    {
        return this.headerBox
    }

    // The shell sets this to open the create dialog.
    public get CreateHandler(): () => void
    {
        return this.createHandler
    }

    public set CreateHandler(value: () => void)
    {
        this.createHandler = value
    }

    public override AttachNavigator(nav: ITenantNavigator): void
    {
        super.AttachNavigator(nav)
        // Capabilities are only known once the navigator is attached; undefined is permissive.
        this.BuildChrome()
        this.Rebuild()
    }

    public async Refresh(): Promise<void>
    {
        this.SetLocalError(undefined)
        try
        {
            await this.vm.Load()
        }
        catch (e)
        {
            this.ReportError(e)
        }
    }

    public async ApplyEvent(ev: TenantEvent): Promise<void>
    {
        await this.vm.ApplyEvent(ev)
        this.Rebuild()
    }

    public Dispose(): void
    {
        for (const s of this.subscriptions)
        {
            s.dispose()
        }
        this.subscriptions.length = 0
        this.headerBox.RemoveClickHandler(this.headerListener)
        this.grid.dispose()
    }

    private get CanManage(): boolean
    {
        return this.Navigator?.Capabilities?.envs !== false
    }

    private MakeCreateAct(): Act
    {
        return new Act({
            can: this.CanManage,
            need: EnvironmentsView.NeedManage,
            onClick: () => this.createHandler(),
            label: EnvironmentsView.CreateLabel,
            variant: ActVariant.Primary,
        })
    }

    // A bulk run reloads inside the VM; a 401 surfaces through ShowError.
    private MakeBulkAct(label: string, run: () => Promise<void>): Act
    {
        return new Act({
            can: this.CanManage,
            need: EnvironmentsView.NeedManage,
            onClick: () => { void this.RunBulk(run) },
            label,
        })
    }

    private async RunBulk(run: () => Promise<void>): Promise<void>
    {
        this.SetLocalError(undefined)
        try
        {
            await run()
        }
        catch (e)
        {
            this.ReportError(e)
        }
    }

    // A 401 drops to login; every other failure shows through the ScreenHost error state
    // (the base message line is not part of this view's layout).
    private ReportError(e: unknown): void
    {
        if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus && this.Navigator !== undefined)
        {
            this.ShowError(e)
            return
        }
        this.SetLocalError(e instanceof Error ? e.message : String(e))
    }

    private SetLocalError(value: string | undefined): void
    {
        this.localError = value
        this.RefreshState()
    }

    private BuildChrome(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        if (this.host !== undefined)
        {
            // Release the shared body from the previous host so it has a single parent.
            this.host.Update({ loading: false, allowed: true, isEmpty: false, error: false })
        }
        this.createAct = this.MakeCreateAct()
        this.bulkActs = [
            this.MakeBulkAct(EnvironmentsView.StartLabel, () => this.vm.StartSelected()),
            this.MakeBulkAct(EnvironmentsView.RestartLabel, () => this.vm.RestartSelected()),
            this.MakeBulkAct(EnvironmentsView.StopLabel, () => this.vm.StopSelected()),
        ]
        for (const child of [...this.bulkSlot.Children])
        {
            this.bulkSlot.RemoveChild(child)
        }
        this.bulkShown = false
        this.host = new ScreenHost(this.Inputs())
        this.AddChild(new Section({
            title: EnvironmentsView.Title,
            sub: EnvironmentsView.Sub,
            actions: this.createAct,
            body: this.host,
        }))
    }

    private Inputs(): ScreenHostInputs
    {
        const vm = this.vm
        const none = vm.AllRows.length === 0
        const message = vm.Error ?? this.localError
        return {
            loading: vm.Busy && none,
            allowed: true,
            isEmpty: !vm.Busy && none,
            error: message !== undefined && none,
            skeleton: SkeletonKind.Table,
            empty: {
                glyph: KitGlyph.Layers,
                title: EnvironmentsView.EmptyTitle,
                body: EnvironmentsView.EmptyBody,
                action: this.MakeCreateAct(),
            },
            errorConfig: message === undefined || !none ? undefined : { title: message },
            content: this.body,
        }
    }

    private Rebuild(): void
    {
        this.grid.ItemsSource = [...this.vm.Rows]
        this.SyncSearchBox()
        this.SyncBulk()
        this.SyncHeaderBox()
        this.RefreshState()
    }

    // Busy/Error-only changes: re-resolve the host and toolbar without rebuilding grid cells.
    private RefreshState(): void
    {
        this.SyncBulk()
        this.SyncInlineError()
        this.host?.Update(this.Inputs())
    }

    private SyncSearchBox(): void
    {
        if (this.searchBox.Text === this.vm.Filter)
        {
            return
        }
        this.suppressSearch = true
        try
        {
            this.searchBox.Text = this.vm.Filter
        }
        finally
        {
            this.suppressSearch = false
        }
    }

    // Action failures always show inline; a load failure shows inline only while rows exist
    // (with no rows the ScreenHost shows it full-pane).
    private SyncInlineError(): void
    {
        const parts: string[] = []
        if (this.vm.ActionError !== undefined)
        {
            parts.push(this.vm.ActionError)
        }
        const loadError = this.vm.Error ?? this.localError
        if (loadError !== undefined && this.vm.AllRows.length > 0)
        {
            parts.push(loadError)
        }
        const text = parts.join(EnvironmentsView.ErrorSeparator)
        const want = text !== EnvironmentsView.NoText
        this.errorLine.Text = text
        if (want === this.errorShown)
        {
            return
        }
        this.errorShown = want
        if (want)
        {
            this.errorSlot.AddChild(this.errorLine)
        }
        else
        {
            this.errorSlot.RemoveChild(this.errorLine)
        }
    }

    private SyncBulk(): void
    {
        const want = this.vm.Selected.size > 0
        const has = this.bulkShown
        if (want === has)
        {
            return
        }
        for (const child of [...this.bulkSlot.Children])
        {
            this.bulkSlot.RemoveChild(child)
        }
        this.bulkShown = want
        if (want)
        {
            this.bulkSlot.AddChild(this.MakeBulkStrip())
        }
    }

    private MakeBulkStrip(): StackPanel
    {
        const strip = new StackPanel()
        strip.Orientation = Orientation.Horizontal
        for (const act of this.bulkActs)
        {
            strip.AddChild(act)
        }
        strip.AddChild(EnvironmentsView.Muted(EnvironmentsView.BulkNote))
        return strip
    }

    private get AllFilteredSelected(): boolean
    {
        const rows = this.vm.Rows
        return rows.length > 0 && rows.every(r => this.vm.Selected.has(r.Name))
    }

    private SyncHeaderBox(): void
    {
        this.headerBox.IsChecked = this.AllFilteredSelected
    }

    private OnHeaderClicked(): void
    {
        if (this.AllFilteredSelected)
        {
            this.vm.ClearSelection()
        }
        else
        {
            this.vm.SelectAllFiltered()
        }
        this.SyncHeaderBox()
    }

    private OnSearchChanged(): void
    {
        if (!this.suppressSearch)
        {
            this.vm.Filter = this.searchBox.Text
        }
    }

    private BuildGrid(): void
    {
        const star = new GridLength(1, GridUnitType.Star)
        const select = this.TemplateColumn(EnvironmentsView.SelectHeader, GridLength.Auto, r => this.MakeSelectCell(r))
        select.HeaderTemplate = new DataTemplate(() => this.headerBox)
        this.grid.Columns.Add(select)
        this.grid.Columns.Add(this.TemplateColumn(EnvironmentsView.EnvironmentHeader, star, r => this.MakeNameCell(r)))
        this.grid.Columns.Add(this.TemplateColumn(EnvironmentsView.StatusHeader, GridLength.Auto, r => new StatusPill(r.StatusPill)))
        this.grid.Columns.Add(this.TemplateColumn(EnvironmentsView.ApplicationHeader, GridLength.Auto, r => EnvironmentsView.Plain(r.Version)))
        this.grid.Columns.Add(this.TemplateColumn(EnvironmentsView.HealthHeader, GridLength.Auto, r => new StatusPill(r.HealthPill)))
        this.grid.Columns.Add(this.TemplateColumn(EnvironmentsView.UrlHeader, star, r => EnvironmentsView.MakeUrlCell(r)))
    }

    private TemplateColumn(header: string, width: GridLength, cell: (row: EnvironmentRow) => Visual): DataGridTemplateColumn
    {
        const col = new DataGridTemplateColumn()
        col.Header = header
        col.Width = width
        col.CellTemplate = new DataTemplate(data => cell(data as EnvironmentRow))
        return col
    }

    // Toggling goes through the VM; the resulting Selection change rebuilds the cells with the true state.
    private MakeSelectCell(row: EnvironmentRow): Checkbox
    {
        const box = new Checkbox()
        box.IsChecked = this.vm.Selected.has(row.Name)
        box.AddClickHandler(() => this.vm.Toggle(row.Name))
        return box
    }

    // The environment name is the open affordance (a button), so clicking the checkbox or URL never opens.
    private MakeNameCell(row: EnvironmentRow): StackPanel
    {
        const cell = new StackPanel()
        cell.Orientation = Orientation.Vertical
        const open = TenantViewBase.MakeButton(row.Name, () => this.Navigator?.ShowEnvironmentDetail(row.Dto))
        open.Variant = ButtonVariant.Text
        cell.AddChild(open)
        cell.AddChild(EnvironmentsView.Muted(row.EnvironmentId + EnvironmentsView.SubSeparator + row.Template))
        return cell
    }

    private static MakeUrlCell(row: EnvironmentRow): TextBlock
    {
        if (row.Url !== undefined)
        {
            return EnvironmentsView.Plain(row.Url)
        }
        return EnvironmentsView.Muted(row.IsStopped ? EnvironmentsView.StoppedText : EnvironmentsView.NotServingText)
    }

    private static Plain(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }

    private static Muted(text: string): TextBlock
    {
        const t = EnvironmentsView.Plain(text)
        t.Foreground = Tones.Brush(PillTone.Neutral)
        return t
    }
}
