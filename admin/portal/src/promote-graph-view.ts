import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import type { EnvironmentDto, GraphDto, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'
import { PromoteGraphViewModel } from './promote-graph-view-model.js'

// Thin render binding over PromoteGraphViewModel: pick a graph and a runtime target, then Promote.
export class PromoteGraphView extends PortalViewBase
{
    public static readonly HeadingText = 'Promote graph'
    public static readonly GraphsHeading = 'Graph'
    public static readonly TargetsHeading = 'Target runtime environment'
    public static readonly PromoteLabel = 'Promote'
    public static readonly NoGraphsText = 'No graphs to promote'
    public static readonly NoTargetsText = 'No runtime environments'
    private static readonly SelectedPrefix = '> '
    private static readonly UnselectedPrefix = '  '

    private readonly viewModel: PromoteGraphViewModel
    private readonly graphRows = new StackPanel()
    private readonly targetRows = new StackPanel()

    public constructor(client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly devEnvName: string)
    {
        super()
        this.viewModel = new PromoteGraphViewModel(client, devEnvName)
        this.AddChild(this.MakeText(PromoteGraphView.HeadingText))
        this.AddChild(this.MakeText(PromoteGraphView.GraphsHeading))
        this.AddChild(this.graphRows)
        this.AddChild(this.MakeText(PromoteGraphView.TargetsHeading))
        this.AddChild(this.targetRows)
        const actions = new StackPanel()
        actions.Orientation = Orientation.Horizontal
        actions.AddChild(this.MakeButton(PromoteGraphView.PromoteLabel, () => { void this.PromoteAndLeave() }))
        actions.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowDetail(this.devEnvName) }))
        this.AddChild(actions)
        this.AddChild(this.message)
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            await this.viewModel.Load()
            this.message.Text = PortalViewBase.NoMessage
        }
        catch (e)
        {
            this.ShowError(e)
        }
        this.RenderRows()
    }

    // Promotes, then returns to the dev detail; errors stay inline on this screen.
    private async PromoteAndLeave(): Promise<void>
    {
        try
        {
            await this.viewModel.Promote()
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.nav.ShowDetail(this.devEnvName)
    }

    private RenderRows(): void
    {
        this.Clear(this.graphRows)
        this.Clear(this.targetRows)
        if (this.viewModel.Graphs.length === 0)
        {
            this.graphRows.AddChild(this.MakeText(PromoteGraphView.NoGraphsText))
        }
        for (const g of this.viewModel.Graphs)
        {
            this.graphRows.AddChild(this.GraphRow(g))
        }
        if (this.viewModel.Targets.length === 0)
        {
            this.targetRows.AddChild(this.MakeText(PromoteGraphView.NoTargetsText))
        }
        for (const t of this.viewModel.Targets)
        {
            this.targetRows.AddChild(this.TargetRow(t))
        }
    }

    private GraphRow(g: GraphDto): StackPanel
    {
        const selected = this.viewModel.SelectedGraph === g.name
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        row.AddChild(this.MakeButton(this.Marker(selected) + [g.name, String(g.packageCount)].join(PortalViewBase.FieldSeparator), () =>
        {
            this.viewModel.SelectedGraph = g.name
            this.RenderRows()
        }))
        return row
    }

    private TargetRow(t: EnvironmentDto): StackPanel
    {
        const selected = this.viewModel.SelectedTargetEnv === t.name
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        row.AddChild(this.MakeButton(this.Marker(selected) + t.name, () =>
        {
            this.viewModel.SelectedTargetEnv = t.name
            this.RenderRows()
        }))
        return row
    }

    private Marker(selected: boolean): string
    {
        return selected ? PromoteGraphView.SelectedPrefix : PromoteGraphView.UnselectedPrefix
    }

    private MakeText(text: string): TextBlock
    {
        const block = new TextBlock()
        block.Text = text
        return block
    }

    private Clear(panel: StackPanel): void
    {
        for (const child of [...panel.Children])
        {
            panel.RemoveChild(child)
        }
    }
}
