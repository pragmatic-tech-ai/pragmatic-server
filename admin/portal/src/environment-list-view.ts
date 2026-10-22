import { StackPanel, TextBlock, Orientation } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import type { EnvironmentDto, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// Lists environments with per-row Start / Stop / Open / Delete (inline confirm).
export class EnvironmentListView extends PortalViewBase
{
    public static readonly NewLabel = 'New environment'
    public static readonly ClientsLabel = 'Clients'
    public static readonly OpenLabel = 'Open'
    private static readonly HeadingText = 'Environments'
    private static readonly EmptyText = 'No environments yet'
    private static readonly RunningStatus = 'running'
    private static readonly FieldSeparator = '  |  '
    private static readonly PortPrefix = 'port '

    private readonly rows: StackPanel
    private pendingDelete: string | undefined
    private environments: EnvironmentDto[] = []

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator)
    {
        super()
        const heading = new TextBlock()
        heading.Text = EnvironmentListView.HeadingText
        this.AddChild(heading)
        this.AddChild(this.MakeButton(EnvironmentListView.NewLabel, () => { this.nav.ShowCreate() }))
        this.AddChild(this.MakeButton(EnvironmentListView.ClientsLabel, () => { this.nav.ShowClients() }))
        this.AddChild(this.message)
        this.rows = new StackPanel()
        this.AddChild(this.rows)
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            this.environments = await this.client.ListEnvironments()
            this.message.Text = PortalViewBase.NoMessage
        }
        catch (e)
        {
            this.ShowError(e)
        }
        this.RenderRows()
    }

    private RenderRows(): void
    {
        for (const child of [...this.rows.Children])
        {
            this.rows.RemoveChild(child)
        }
        if (this.environments.length === 0)
        {
            const empty = new TextBlock()
            empty.Text = EnvironmentListView.EmptyText
            this.rows.AddChild(empty)
            return
        }
        for (const env of this.environments)
        {
            this.rows.AddChild(this.BuildRow(env))
        }
    }

    private BuildRow(env: EnvironmentDto): StackPanel
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        const info = new TextBlock()
        info.Text = [env.name, env.template, env.type, env.status, EnvironmentListView.PortPrefix + String(env.hostPort)].join(EnvironmentListView.FieldSeparator)
        row.AddChild(info)
        const running = env.status === EnvironmentListView.RunningStatus
        row.AddChild(running
            ? this.MakeButton(PortalViewBase.StopLabel, () => { void this.Run(() => this.client.StopEnvironment(env.name)) })
            : this.MakeButton(PortalViewBase.StartLabel, () => { void this.Run(() => this.client.StartEnvironment(env.name)) }))
        row.AddChild(this.MakeButton(EnvironmentListView.OpenLabel, () => { this.nav.ShowDetail(env.name) }))
        if (this.pendingDelete === env.name)
        {
            row.AddChild(this.MakeButton(PortalViewBase.ConfirmDeleteLabel, () =>
            {
                this.pendingDelete = undefined
                void this.Run(() => this.client.DeleteEnvironment(env.name))
            }))
            row.AddChild(this.MakeButton(PortalViewBase.CancelLabel, () =>
            {
                this.pendingDelete = undefined
                this.RenderRows()
            }))
        }
        else
        {
            row.AddChild(this.MakeButton(PortalViewBase.DeleteLabel, () =>
            {
                this.pendingDelete = env.name
                this.RenderRows()
            }))
        }
        return row
    }
}
