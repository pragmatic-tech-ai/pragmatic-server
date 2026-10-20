import { StackPanel, TextBlock, Orientation } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import type { GraphDto, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// Lists an environment's graphs with per-row inline-confirmed Delete.
export class GraphListView extends PortalViewBase
{
    public static readonly NewLabel = 'New graph'
    public static readonly HeadingText = 'Graphs'
    public static readonly EmptyText = 'No graphs yet'
    private static readonly FieldSeparator = '  |  '

    private readonly rows: StackPanel
    private pendingDelete: string | undefined
    private graphs: GraphDto[] = []

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly envName: string)
    {
        super()
        const heading = new TextBlock()
        heading.Text = GraphListView.HeadingText
        this.AddChild(heading)
        this.AddChild(this.MakeButton(GraphListView.NewLabel, () => { this.nav.ShowCreateGraph(this.envName) }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowDetail(this.envName) }))
        this.AddChild(this.message)
        this.rows = new StackPanel()
        this.AddChild(this.rows)
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            this.graphs = await this.client.ListGraphs(this.envName)
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
        if (this.graphs.length === 0)
        {
            const empty = new TextBlock()
            empty.Text = GraphListView.EmptyText
            this.rows.AddChild(empty)
            return
        }
        for (const g of this.graphs)
        {
            this.rows.AddChild(this.BuildRow(g))
        }
    }

    private BuildRow(g: GraphDto): StackPanel
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        const info = new TextBlock()
        info.Text = [g.name, g.description, String(g.packageCount)].join(GraphListView.FieldSeparator)
        row.AddChild(info)
        if (this.pendingDelete === g.name)
        {
            row.AddChild(this.MakeButton(PortalViewBase.ConfirmDeleteLabel, () =>
            {
                this.pendingDelete = undefined
                void this.Run(() => this.client.DeleteGraph(this.envName, g.name))
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
                this.pendingDelete = g.name
                this.RenderRows()
            }))
        }
        return row
    }
}
