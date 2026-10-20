import { StackPanel, TextBlock, Orientation } from '@pragmatic-tech-ai/mural/basic'
import { ScrollViewer } from '@pragmatic-tech-ai/mural/framework'
import type { ControlPlaneClient } from './api-client.js'
import type { EnvironmentDto, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// One environment: connect info, scrollable logs pane, Start / Stop / Delete.
export class EnvironmentDetailView extends PortalViewBase
{
    private static readonly ManageLabel = 'Manage'
    public static readonly RolesLabel = 'Roles'
    public static readonly GraphsLabel = 'Graphs'
    public static readonly MakerTokenLabel = 'Mint maker token'
    private static readonly DevelopmentType = 'development'
    private static readonly LogsHeading = 'Logs'
    private static readonly HttpPrefix = 'HTTP: '
    private static readonly WsPrefix = 'WebSocket: '
    private static readonly TypePrefix = 'Type: '
    private static readonly StatusPrefix = 'Status: '
    private static readonly NoLogsMessage = 'No logs available (environment not running).'

    private readonly title = new TextBlock()
    private readonly type = new TextBlock()
    private readonly status = new TextBlock()
    private readonly http = new TextBlock()
    private readonly ws = new TextBlock()
    private readonly logs = new TextBlock()
    private readonly actions = new StackPanel()
    private confirming = false
    private envType: string | undefined

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly name: string)
    {
        super()
        this.title.Text = name
        this.AddChild(this.title)
        this.AddChild(this.type)
        this.AddChild(this.status)
        this.AddChild(this.http)
        this.AddChild(this.ws)
        this.actions.Orientation = Orientation.Horizontal
        this.AddChild(this.actions)
        this.AddChild(this.message)
        const logsHeading = new TextBlock()
        logsHeading.Text = EnvironmentDetailView.LogsHeading
        this.AddChild(logsHeading)
        const scroller = new ScrollViewer()
        scroller.Content = this.logs
        this.AddChild(scroller)
        this.RenderActions()
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            const all = await this.client.ListEnvironments()
            const env = all.find(e => e.name === this.name)
            if (env === undefined)
            {
                this.nav.ShowList()
                return
            }
            this.ShowEnvironment(env)
            this.logs.Text = await this.FetchLogs()
            this.message.Text = PortalViewBase.NoMessage
        }
        catch (e)
        {
            this.ShowError(e)
        }
    }

    private async FetchLogs(): Promise<string>
    {
        try
        {
            return await this.client.Logs(this.name)
        }
        catch
        {
            return EnvironmentDetailView.NoLogsMessage
        }
    }

    private ShowEnvironment(env: EnvironmentDto): void
    {
        this.envType = env.type
        this.type.Text = EnvironmentDetailView.TypePrefix + env.type
        this.status.Text = EnvironmentDetailView.StatusPrefix + env.status
        this.http.Text = EnvironmentDetailView.HttpPrefix + env.httpUrl
        this.ws.Text = EnvironmentDetailView.WsPrefix + env.wsUrl
        this.RenderActions()
    }

    private RenderActions(): void
    {
        for (const child of [...this.actions.Children])
        {
            this.actions.RemoveChild(child)
        }
        this.actions.AddChild(this.MakeButton(PortalViewBase.StartLabel, () => { void this.Run(() => this.client.StartEnvironment(this.name)) }))
        this.actions.AddChild(this.MakeButton(PortalViewBase.StopLabel, () => { void this.Run(() => this.client.StopEnvironment(this.name)) }))
        if (this.confirming)
        {
            this.actions.AddChild(this.MakeButton(PortalViewBase.ConfirmDeleteLabel, () => { void this.ConfirmDelete() }))
            this.actions.AddChild(this.MakeButton(PortalViewBase.CancelLabel, () => { this.SetConfirming(false) }))
        }
        else
        {
            this.actions.AddChild(this.MakeButton(PortalViewBase.DeleteLabel, () => { this.SetConfirming(true) }))
        }
        this.actions.AddChild(this.MakeButton(EnvironmentDetailView.ManageLabel, () => { this.nav.ShowManage(this.name) }))
        this.actions.AddChild(this.MakeButton(EnvironmentDetailView.RolesLabel, () => { this.nav.ShowRoles(this.name) }))
        if (this.envType === EnvironmentDetailView.DevelopmentType)
        {
            this.actions.AddChild(this.MakeButton(EnvironmentDetailView.GraphsLabel, () => { this.nav.ShowGraphs(this.name) }))
            this.actions.AddChild(this.MakeButton(EnvironmentDetailView.MakerTokenLabel, () => { this.nav.ShowMakerToken(this.name) }))
        }
        this.actions.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowList() }))
    }

    private SetConfirming(value: boolean): void
    {
        this.confirming = value
        this.RenderActions()
    }

    private async ConfirmDelete(): Promise<void>
    {
        try
        {
            await this.client.DeleteEnvironment(this.name)
        }
        catch (e)
        {
            this.ShowError(e)
            this.SetConfirming(false)
            return
        }
        this.SetConfirming(false)
        this.nav.ShowList()
    }
}
