import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { ScrollViewer } from '@pragmatic-tech-ai/mural/framework'
import { EnvironmentDetailViewModel } from './environment-detail-view-model.js'
import type { IEnvDetailSource } from './environment-detail-view-model.js'
import { TenantViewBase } from './tenant-view-base.js'
import type { EnvironmentDto } from './tenant-types.js'

// Environment detail: header + lifecycle buttons (inline confirm on Stop), live health strip,
// and a live-tailing, pausable logs panel. Dispose() closes the log stream.
export class EnvironmentDetailView extends TenantViewBase
{
    public static readonly StartLabel = 'Start'
    public static readonly StopLabel = 'Stop'
    public static readonly RestartLabel = 'Restart'
    public static readonly ConfirmStopLabel = 'Confirm stop'
    public static readonly CancelLabel = 'Cancel'
    public static readonly PauseLabel = 'Pause'
    public static readonly ResumeLabel = 'Resume'
    public static readonly LogsHeading = 'Logs'
    public static readonly StatusDot = '● '
    public static readonly VersionPrefix = 'Version: '
    public static readonly TypePrefix = 'Type: '
    public static readonly NoVersionText = 'none'
    public static readonly HealthPrefix = 'Health: '
    public static readonly ReadyText = 'ready'
    public static readonly NotReadyText = 'not ready'
    public static readonly NoHealthText = 'Health: unavailable'
    public static readonly DetailSeparator = ' - '
    public static readonly NoLogsText = 'No logs yet (stream is live while the environment runs).'

    private static readonly Empty = ''

    private readonly vm: EnvironmentDetailViewModel
    private readonly logs = new TextBlock()
    private readonly logScroller = new ScrollViewer()
    private confirming = false

    public constructor(source: IEnvDetailSource, private readonly env: EnvironmentDto, hiveId: string | undefined)
    {
        super()
        this.logScroller.Content = this.logs
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
        const vm = this.vm
        this.AddChild(this.Text(this.env.name))
        this.AddChild(this.Text(EnvironmentDetailView.StatusDot + vm.Status))
        this.AddChild(this.Text(EnvironmentDetailView.VersionPrefix + (vm.RunningVersion === EnvironmentDetailView.Empty ? EnvironmentDetailView.NoVersionText : vm.RunningVersion)))
        this.AddChild(this.Text(EnvironmentDetailView.TypePrefix + vm.Type))
        this.AddChild(this.MakeActions())
        this.AddChild(this.message)
        this.AddChild(this.Text(this.DescribeHealth()))
        this.AddChild(this.Text(EnvironmentDetailView.LogsHeading))
        this.AddChild(this.MakeButton(vm.Paused ? EnvironmentDetailView.ResumeLabel : EnvironmentDetailView.PauseLabel, () => vm.TogglePause()))
        this.AddChild(this.logScroller)
        this.UpdateLogs()
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
        return actions
    }

    private Text(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }
}
