import { StackPanel, TextBlock, Orientation } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import type { ControlPlaneClient } from './api-client.js'
import type { EnvironmentDto, IPortalNavigator, IPortalView } from './portal-types.js'

// Lists environments with per-row Start / Stop / Open / Delete (inline confirm).
export class EnvironmentListView extends StackPanel implements IPortalView
{
    public static readonly NewLabel = 'New environment'
    public static readonly StartLabel = 'Start'
    public static readonly StopLabel = 'Stop'
    public static readonly OpenLabel = 'Open'
    public static readonly DeleteLabel = 'Delete'
    public static readonly ConfirmDeleteLabel = 'Confirm delete'
    public static readonly CancelLabel = 'Cancel'
    private static readonly HeadingText = 'Environments'
    private static readonly EmptyText = 'No environments yet'
    private static readonly RunningStatus = 'running'
    private static readonly FieldSeparator = '  |  '
    private static readonly PortPrefix = 'port '
    private static readonly ErrorPrefix = 'error: '
    private static readonly NoMessage = ''

    private readonly rows: StackPanel
    private readonly message: TextBlock
    private pendingDelete: string | undefined
    private environments: EnvironmentDto[] = []

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator)
    {
        super()
        const heading = new TextBlock()
        heading.Text = EnvironmentListView.HeadingText
        this.AddChild(heading)
        this.AddChild(this.MakeButton(EnvironmentListView.NewLabel, () => { this.nav.ShowCreate() }))
        this.message = new TextBlock()
        this.AddChild(this.message)
        this.rows = new StackPanel()
        this.AddChild(this.rows)
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            this.environments = await this.client.ListEnvironments()
            this.message.Text = EnvironmentListView.NoMessage
        }
        catch (e)
        {
            this.message.Text = EnvironmentListView.ErrorPrefix + (e as Error).message
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
        info.Text = [env.name, env.template, env.status, EnvironmentListView.PortPrefix + String(env.hostPort)].join(EnvironmentListView.FieldSeparator)
        row.AddChild(info)
        const running = env.status === EnvironmentListView.RunningStatus
        row.AddChild(running
            ? this.MakeButton(EnvironmentListView.StopLabel, () => { void this.Run(() => this.client.StopEnvironment(env.name)) })
            : this.MakeButton(EnvironmentListView.StartLabel, () => { void this.Run(() => this.client.StartEnvironment(env.name)) }))
        row.AddChild(this.MakeButton(EnvironmentListView.OpenLabel, () => { this.nav.ShowDetail(env.name) }))
        if (this.pendingDelete === env.name)
        {
            row.AddChild(this.MakeButton(EnvironmentListView.ConfirmDeleteLabel, () =>
            {
                this.pendingDelete = undefined
                void this.Run(() => this.client.DeleteEnvironment(env.name))
            }))
            row.AddChild(this.MakeButton(EnvironmentListView.CancelLabel, () =>
            {
                this.pendingDelete = undefined
                this.RenderRows()
            }))
        }
        else
        {
            row.AddChild(this.MakeButton(EnvironmentListView.DeleteLabel, () =>
            {
                this.pendingDelete = env.name
                this.RenderRows()
            }))
        }
        return row
    }

    private async Run(action: () => Promise<unknown>): Promise<void>
    {
        try
        {
            await action()
        }
        catch (e)
        {
            this.message.Text = EnvironmentListView.ErrorPrefix + (e as Error).message
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
