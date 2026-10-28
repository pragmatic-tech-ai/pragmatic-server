import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { ScrollViewer } from '@pragmatic-tech-ai/mural/framework'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { EnvironmentDetailViewModel } from './environment-detail-view-model.js'
import type { IEnvDetailSource } from './environment-detail-view-model.js'
import { EnvironmentRow } from './environment-row.js'
import { ActivityList, Banner, BannerTone, ConfirmDialog, ConfirmTone, KeyValueGrid, Section, StatusPill, Tabs } from './kit/index.js'
import { TenantViewBase } from './tenant-view-base.js'
import { EnvStatus } from './tenant-types.js'
import type { EnvironmentDto } from './tenant-types.js'

// Environment detail: header (name, status/health pills, identity, live URL, lifecycle + Delete),
// a state banner, and three tabs. Delete is confirmed by a kit ConfirmDialog hosted inline.
// Dispose() closes the log stream.
export class EnvironmentDetailView extends TenantViewBase
{
    public static readonly StartLabel = 'Start'
    public static readonly StopLabel = 'Stop'
    public static readonly RestartLabel = 'Restart'
    public static readonly DeleteLabel = 'Delete'
    public static readonly ConfirmStopLabel = 'Confirm stop'
    public static readonly CancelLabel = 'Cancel'
    public static readonly PauseLabel = 'Pause'
    public static readonly ResumeLabel = 'Resume'
    public static readonly ViewLogsLabel = 'View logs'
    public static readonly HideLogsLabel = 'Hide logs'
    public static readonly LogsHeading = 'Logs'
    public static readonly ActivityTitle = 'Recent activity'
    public static readonly ActivityEmptyText = 'No activity observed for this environment yet this session.'
    public static readonly AppTabLabel = 'Application & version'
    public static readonly HealthTabLabel = 'Health & activity'
    public static readonly AccessTabLabel = 'Access'
    public static readonly VersionKey = 'Version'
    public static readonly TypeKey = 'Type'
    public static readonly TemplateKey = 'Template'
    public static readonly EnvironmentIdKey = 'Environment id'
    public static readonly CreatedKey = 'Created'
    public static readonly AddressKey = 'Address'
    public static readonly IdentitySeparator = ' - '
    public static readonly UrlPrefix = 'URL: '
    public static readonly NotServingText = 'Not serving'
    public static readonly HealthPrefix = 'Health: '
    public static readonly ReadyText = 'ready'
    public static readonly NotReadyText = 'not ready'
    public static readonly NoHealthText = 'Health: unavailable'
    public static readonly DetailSeparator = ' - '
    public static readonly NoLogsText = 'No logs yet (stream is live while the environment runs).'
    public static readonly FailedBannerText = 'This environment failed to start'
    public static readonly UnknownBannerText = 'The state of this environment is unknown.'
    public static readonly DeleteTitle = 'Delete environment'
    public static readonly DeleteActionLabel = 'Delete environment'
    public static readonly DeleteConsequences: readonly string[] = [
        'The live URL stops serving immediately.',
        "The environment's database and files are deleted.",
        'This cannot be undone.',
    ]

    private static readonly Empty = ''
    private static readonly AppTab = 0
    private static readonly HealthTab = 1

    private readonly vm: EnvironmentDetailViewModel
    private logs = new TextBlock()
    private logScroller = new ScrollViewer()
    private confirming = false
    private logsOpen = false
    private tabIndex = EnvironmentDetailView.AppTab
    private dialog: ConfirmDialog | undefined

    public constructor(source: IEnvDetailSource, private readonly env: EnvironmentDto, hiveId: string | undefined)
    {
        super()
        this.vm = new EnvironmentDetailViewModel(source, env, hiveId)
        this.vm.PropertyChanged(EnvironmentDetailViewModel.StatusProperty).subscribe(() => this.Render())
        this.vm.PropertyChanged(EnvironmentDetailViewModel.HealthProperty).subscribe(() => this.Render())
        this.vm.PropertyChanged(EnvironmentDetailViewModel.PausedProperty).subscribe(() => this.Render())
        this.vm.PropertyChanged(EnvironmentDetailViewModel.LogBufferProperty).subscribe(() => this.UpdateLogs())
        this.Render()
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            await this.vm.LoadHealth()
        }
        catch (e)
        {
            this.ShowError(e)
        }
        this.vm.StartLogs()
        this.Render()
    }

    // Teardown invoked when the detail pane swaps this view out: closes the log socket.
    public Dispose(): void
    {
        this.vm.StopLogs()
    }

    public Render(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        this.logs = new TextBlock()
        this.logScroller = new ScrollViewer()
        this.logScroller.Content = this.logs
        this.AddChild(this.MakeHeader())
        this.AddChild(this.message)
        const banner = this.MakeBanner()
        if (banner !== undefined)
        {
            this.AddChild(banner)
        }
        this.AddChild(this.MakeTabs())
        if (this.dialog !== undefined)
        {
            this.AddChild(this.dialog)
        }
        this.UpdateLogs()
    }

    private MakeHeader(): StackPanel
    {
        const vm = this.vm
        const row = new EnvironmentRow({ ...this.env, status: vm.Status as EnvStatus }, vm.Health)
        const pills = new StackPanel()
        pills.Orientation = Orientation.Horizontal
        pills.AddChild(new StatusPill(row.StatusPill))
        pills.AddChild(new StatusPill(row.HealthPill))
        const header = new StackPanel()
        header.Orientation = Orientation.Vertical
        header.AddChild(this.Text(vm.Name))
        header.AddChild(pills)
        header.AddChild(this.Text(vm.Template + EnvironmentDetailView.IdentitySeparator + vm.Type + EnvironmentDetailView.IdentitySeparator + vm.EnvironmentId))
        header.AddChild(this.Text(EnvironmentDetailView.UrlPrefix + this.LiveUrlText()))
        header.AddChild(this.MakeActions())
        return header
    }

    private LiveUrlText(): string
    {
        return this.vm.LiveUrl === EnvironmentDetailView.Empty ? EnvironmentDetailView.NotServingText : this.vm.LiveUrl
    }

    private MakeBanner(): Visual | undefined
    {
        if (this.vm.Status === EnvStatus.Failed)
        {
            return new Banner({ tone: BannerTone.Danger, text: EnvironmentDetailView.FailedBannerText })
        }
        if (this.vm.Status === EnvStatus.Unknown)
        {
            return new Banner({ tone: BannerTone.Info, text: EnvironmentDetailView.UnknownBannerText })
        }
        return undefined
    }

    private MakeTabs(): Tabs
    {
        const tabs = new Tabs({
            entries: [
                { label: EnvironmentDetailView.AppTabLabel, content: this.MakeApplicationTab() },
                { label: EnvironmentDetailView.HealthTabLabel, content: this.MakeHealthTab() },
                { label: EnvironmentDetailView.AccessTabLabel, content: this.MakeAccessTab() },
            ],
            onSelect: index => { this.tabIndex = index },
        })
        tabs.Select(this.tabIndex)
        return tabs
    }

    private MakeApplicationTab(): KeyValueGrid
    {
        const vm = this.vm
        return new KeyValueGrid({
            items: [
                { key: EnvironmentDetailView.VersionKey, value: vm.Version },
                { key: EnvironmentDetailView.TypeKey, value: vm.Type },
                { key: EnvironmentDetailView.TemplateKey, value: vm.Template },
                { key: EnvironmentDetailView.EnvironmentIdKey, value: vm.EnvironmentId },
                { key: EnvironmentDetailView.CreatedKey, value: vm.CreatedAt },
            ],
        })
    }

    private MakeHealthTab(): StackPanel
    {
        const panel = new StackPanel()
        panel.Orientation = Orientation.Vertical
        panel.AddChild(this.Text(this.DescribeHealth()))
        panel.AddChild(this.MakeActivitySection())
        panel.AddChild(this.MakeButton(
            this.logsOpen ? EnvironmentDetailView.HideLogsLabel : EnvironmentDetailView.ViewLogsLabel,
            () => { this.logsOpen = !this.logsOpen; this.tabIndex = EnvironmentDetailView.HealthTab; this.Render() }))
        if (this.logsOpen)
        {
            panel.AddChild(this.Text(EnvironmentDetailView.LogsHeading))
            panel.AddChild(this.MakeButton(this.vm.Paused ? EnvironmentDetailView.ResumeLabel : EnvironmentDetailView.PauseLabel, () => this.vm.TogglePause()))
            panel.AddChild(this.logScroller)
        }
        return panel
    }

    private MakeActivitySection(): Section
    {
        const entries = this.Navigator?.Activity?.EntriesFor(this.env.name) ?? []
        return new Section({
            title: EnvironmentDetailView.ActivityTitle,
            body: new ActivityList({ entries, emptyText: EnvironmentDetailView.ActivityEmptyText }),
        })
    }

    private MakeAccessTab(): KeyValueGrid
    {
        return new KeyValueGrid({ items: [{ key: EnvironmentDetailView.AddressKey, value: this.LiveUrlText() }] })
    }

    private DescribeHealth(): string
    {
        const h = this.vm.Health
        if (h === undefined)
        {
            return EnvironmentDetailView.NoHealthText
        }
        const state = h.ready ? EnvironmentDetailView.ReadyText : EnvironmentDetailView.NotReadyText
        return EnvironmentDetailView.HealthPrefix + state + (h.detail === EnvironmentDetailView.Empty ? EnvironmentDetailView.Empty : EnvironmentDetailView.DetailSeparator + h.detail)
    }

    private UpdateLogs(): void
    {
        this.logs.Text = this.vm.LogBuffer === EnvironmentDetailView.Empty ? EnvironmentDetailView.NoLogsText : this.vm.LogBuffer
    }

    private MakeActions(): StackPanel
    {
        const actions = new StackPanel()
        actions.Orientation = Orientation.Horizontal
        actions.AddChild(this.MakeButton(EnvironmentDetailView.StartLabel, () => { void this.Run(() => this.vm.Start()) }))
        if (this.confirming)
        {
            actions.AddChild(this.MakeButton(EnvironmentDetailView.ConfirmStopLabel, () => { this.confirming = false; void this.Run(() => this.vm.Stop()) }))
            actions.AddChild(this.MakeButton(EnvironmentDetailView.CancelLabel, () => { this.confirming = false; this.Render() }))
        }
        else
        {
            actions.AddChild(this.MakeButton(EnvironmentDetailView.StopLabel, () => { this.confirming = true; this.Render() }))
        }
        actions.AddChild(this.MakeButton(EnvironmentDetailView.RestartLabel, () => { void this.Run(() => this.vm.Restart()) }))
        actions.AddChild(this.MakeButton(EnvironmentDetailView.DeleteLabel, () => this.OpenDeleteDialog()))
        return actions
    }

    private OpenDeleteDialog(): void
    {
        if (this.dialog !== undefined)
        {
            return
        }
        const dialog: ConfirmDialog = new ConfirmDialog({
            title: EnvironmentDetailView.DeleteTitle,
            consequences: [...EnvironmentDetailView.DeleteConsequences],
            confirmName: this.vm.Name,
            actionLabel: EnvironmentDetailView.DeleteActionLabel,
            tone: ConfirmTone.Danger,
            onConfirm: () => { void this.DeleteNow() },
            onClose: () => this.CloseDialog(dialog),
        })
        this.dialog = dialog
        this.AddChild(dialog)
    }

    private CloseDialog(dialog: ConfirmDialog): void
    {
        if (this.dialog === dialog)
        {
            this.dialog = undefined
            this.RemoveChild(dialog)
        }
    }

    // No Run(): refreshing a just-deleted environment would error. The shell navigates away on the
    // server's EnvironmentDeleted event.
    private async DeleteNow(): Promise<void>
    {
        try
        {
            await this.vm.Delete()
        }
        catch (e)
        {
            this.ShowError(e)
        }
    }

    private Text(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }
}
