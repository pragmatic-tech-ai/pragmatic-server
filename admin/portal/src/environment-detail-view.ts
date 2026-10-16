import { StackPanel, TextBlock, Orientation } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import type { ControlPlaneClient } from './api-client.js'
import type { EnvironmentDto, IPortalNavigator, IPortalView } from './portal-types.js'

// One environment: connect info, logs pane, Start / Stop / Delete.
export class EnvironmentDetailView extends StackPanel implements IPortalView
{
    public static readonly StartLabel = 'Start'
    public static readonly StopLabel = 'Stop'
    public static readonly DeleteLabel = 'Delete'
    public static readonly ConfirmDeleteLabel = 'Confirm delete'
    public static readonly BackLabel = 'Back'
    private static readonly LogsHeading = 'Logs'
    private static readonly HttpPrefix = 'HTTP: '
    private static readonly WsPrefix = 'WebSocket: '
    private static readonly StatusPrefix = 'Status: '
    private static readonly ErrorPrefix = 'error: '
    private static readonly NoMessage = ''

    private readonly title = new TextBlock()
    private readonly status = new TextBlock()
    private readonly http = new TextBlock()
    private readonly ws = new TextBlock()
    private readonly logs = new TextBlock()
    private readonly message = new TextBlock()
    private readonly actions = new StackPanel()
    private confirming = false

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly name: string)
    {
        super()
        this.title.Text = name
        this.AddChild(this.title)
        this.AddChild(this.status)
        this.AddChild(this.http)
        this.AddChild(this.ws)
        this.actions.Orientation = Orientation.Horizontal
        this.AddChild(this.actions)
        this.AddChild(this.message)
        const logsHeading = new TextBlock()
        logsHeading.Text = EnvironmentDetailView.LogsHeading
        this.AddChild(logsHeading)
        this.AddChild(this.logs)
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
            this.logs.Text = await this.client.Logs(this.name)
            this.message.Text = EnvironmentDetailView.NoMessage
        }
        catch (e)
        {
            this.message.Text = EnvironmentDetailView.ErrorPrefix + (e as Error).message
        }
    }

    private ShowEnvironment(env: EnvironmentDto): void
    {
        this.status.Text = EnvironmentDetailView.StatusPrefix + env.status
        this.http.Text = EnvironmentDetailView.HttpPrefix + env.httpUrl
        this.ws.Text = EnvironmentDetailView.WsPrefix + env.wsUrl
    }

    private RenderActions(): void
    {
        for (const child of [...this.actions.Children])
        {
            this.actions.RemoveChild(child)
        }
        this.actions.AddChild(this.MakeButton(EnvironmentDetailView.StartLabel, () => { void this.Run(() => this.client.StartEnvironment(this.name)) }))
        this.actions.AddChild(this.MakeButton(EnvironmentDetailView.StopLabel, () => { void this.Run(() => this.client.StopEnvironment(this.name)) }))
        if (this.confirming)
        {
            this.actions.AddChild(this.MakeButton(EnvironmentDetailView.ConfirmDeleteLabel, () => { void this.ConfirmDelete() }))
        }
        else
        {
            this.actions.AddChild(this.MakeButton(EnvironmentDetailView.DeleteLabel, () =>
            {
                this.confirming = true
                this.RenderActions()
            }))
        }
        this.actions.AddChild(this.MakeButton(EnvironmentDetailView.BackLabel, () => { this.nav.ShowList() }))
    }

    private async ConfirmDelete(): Promise<void>
    {
        try
        {
            await this.client.DeleteEnvironment(this.name)
        }
        catch (e)
        {
            this.message.Text = EnvironmentDetailView.ErrorPrefix + (e as Error).message
            return
        }
        this.nav.ShowList()
    }

    private async Run(action: () => Promise<unknown>): Promise<void>
    {
        try
        {
            await action()
        }
        catch (e)
        {
            this.message.Text = EnvironmentDetailView.ErrorPrefix + (e as Error).message
            return
        }
        await this.Refresh()
    }

    private MakeButton(label: string, onClick: () => void): Button
    {
        const text = new TextBlock()
        text.Text = label
        const button = new Button()
        button.Content = text
        button.AddClickHandler(onClick)
        return button
    }
}
