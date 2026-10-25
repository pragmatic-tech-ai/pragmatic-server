import { StackPanel, TextBlock, Orientation } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import { EnvironmentType } from './portal-types.js'
import type { EnvironmentDto, GraphLoadedDto, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// One environment: connect info and navigation to its identity admin and graphs; lifecycle lives on the tenant plane.
export class EnvironmentDetailView extends PortalViewBase
{
    private static readonly ManageLabel = 'Manage'
    public static readonly RolesLabel = 'Roles'
    public static readonly GraphsLabel = 'Graphs'
    public static readonly MakerTokenLabel = 'Mint maker token'
    public static readonly PromoteLabel = 'Promote graph\u2026'
    private static readonly LoadedGraphPrefix = 'Loaded graph: '
    private static readonly PackagesPrefix = 'Packages: '
    private static readonly PromotedAtPrefix = 'Promoted at: '
    private static readonly NoGraphMessage = 'No graph loaded'
    private static readonly LoadedSeparator = '  |  '
    private static readonly HttpPrefix = 'HTTP: '
    private static readonly WsPrefix = 'WebSocket: '
    private static readonly TypePrefix = 'Type: '
    private static readonly StatusPrefix = 'Status: '

    private readonly title = new TextBlock()
    private readonly type = new TextBlock()
    private readonly status = new TextBlock()
    private readonly http = new TextBlock()
    private readonly ws = new TextBlock()
    private readonly loadedGraph = new TextBlock()
    private readonly actions = new StackPanel()
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
        this.AddChild(this.loadedGraph)
        this.actions.Orientation = Orientation.Horizontal
        this.AddChild(this.actions)
        this.AddChild(this.message)
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
            await this.ShowLoadedGraph()
            this.message.Text = PortalViewBase.NoMessage
        }
        catch (e)
        {
            this.ShowError(e)
        }
    }

    // Runtime environments show their loaded graph; other types show nothing.
    private async ShowLoadedGraph(): Promise<void>
    {
        if (this.envType !== EnvironmentType.Runtime)
        {
            this.loadedGraph.Text = PortalViewBase.NoMessage
            return
        }
        this.loadedGraph.Text = EnvironmentDetailView.DescribeLoaded(await this.client.GetLoadedGraph(this.name))
    }

    public static DescribeLoaded(loaded: GraphLoadedDto | null): string
    {
        if (loaded === null)
        {
            return EnvironmentDetailView.NoGraphMessage
        }
        return [EnvironmentDetailView.LoadedGraphPrefix + loaded.name,
            EnvironmentDetailView.PackagesPrefix + String(loaded.packages.length),
            EnvironmentDetailView.PromotedAtPrefix + loaded.promotedAt].join(EnvironmentDetailView.LoadedSeparator)
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
        this.actions.AddChild(this.MakeButton(EnvironmentDetailView.ManageLabel, () => { this.nav.ShowManage(this.name) }))
        this.actions.AddChild(this.MakeButton(EnvironmentDetailView.RolesLabel, () => { this.nav.ShowRoles(this.name) }))
        if (this.envType === EnvironmentType.Development)
        {
            this.actions.AddChild(this.MakeButton(EnvironmentDetailView.GraphsLabel, () => { this.nav.ShowGraphs(this.name) }))
            this.actions.AddChild(this.MakeButton(EnvironmentDetailView.PromoteLabel, () => { this.nav.ShowPromoteGraph(this.name) }))
            this.actions.AddChild(this.MakeButton(EnvironmentDetailView.MakerTokenLabel, () => { this.nav.ShowMakerToken(this.name) }))
        }
        this.actions.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowList() }))
    }
}
