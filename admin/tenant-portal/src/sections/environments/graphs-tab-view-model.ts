import { ObservableCollection, type RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { GraphDto } from '../../tenant-types.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { UtcText } from '../../shell/utc-text.js'
import { EnvironmentScopedPageViewModel } from '../users-access/environment-scoped-page-view-model.js'
import { CreateGraphDialogViewModel } from './create-graph-dialog-view-model.js'
import type { EnvironmentsSectionService } from './environments-section-service.js'

// One graphs-table line, with its Delete.
export class GraphRowViewModel extends Observable
{
    private static readonly OnePackageText = '1 package'
    private static readonly PackagesSuffix = ' packages'

    public constructor(private readonly dto: GraphDto, private readonly deleteCommand: RelayCommand)
    {
        super()
    }

    public get Name(): string
    {
        return this.dto.name
    }

    public get Description(): string
    {
        return this.dto.description
    }

    // How many packages Plexus has contributed to the graph.
    public get PackagesText(): string
    {
        const count = this.dto.packageCount
        return count === 1 ? GraphRowViewModel.OnePackageText : String(count) + GraphRowViewModel.PackagesSuffix
    }

    public get CreatedText(): string
    {
        return UtcText.DateTime(this.dto.createdAt)
    }

    public get DeleteCommand(): RelayCommand
    {
        return this.deleteCommand
    }
}

// The Graphs tab of a Development environment's detail: the graphs Plexus
// contributes to, New graph, and Delete (confirmed) per graph. A refusal from
// the route (no reach from this console, say) shows as Error with the route's
// sentence.
export class GraphsTabViewModel extends EnvironmentScopedPageViewModel
{
    private static readonly RowsProperty = 'Rows'
    private static readonly GraphToken = '{graph}'
    private static readonly EnvironmentToken = '{environment}'
    private static readonly DeleteTitleTemplate = 'Delete graph {graph}?'
    private static readonly DeleteMessageTemplate = 'Deleting {graph} removes it from {environment}, with every package contributed to it.'
    private static readonly DeleteLabel = 'Delete graph'
    private static readonly DeleteConsequences: readonly string[] = [
        'Plexus can no longer contribute to it.',
        'This cannot be undone.',
    ]

    private rows = new ObservableCollection<GraphRowViewModel>()
    private readonly newGraphCommand: RelayCommand

    public constructor(session: TenantSessionService, private readonly section: EnvironmentsSectionService)
    {
        super(session)
        this.newGraphCommand = this.MutatingCommand(AdminCapability.Environments, () => this.NewGraph(),
            () => this.Environment !== undefined)
    }

    public get Rows(): ObservableCollection<GraphRowViewModel>
    {
        return this.rows
    }

    public get NewGraphCommand(): RelayCommand
    {
        return this.newGraphCommand
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Environments
    }

    // The previous environment's rows go at once: their commands are bound to
    // that environment and must not stay clickable while the new one loads.
    protected override OnEnvironmentChanged(): void
    {
        super.OnEnvironmentChanged()
        this.ClearRowCommands()
        this.ReplaceRows(new ObservableCollection<GraphRowViewModel>())
        this.RaiseMutatingCommandsChanged()
    }

    protected override async LoadFor(environment: string): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const graphs = await this.Session.Client.ListGraphs(environment)
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.ClearRowCommands()
        const rows = new ObservableCollection<GraphRowViewModel>()
        for (const graph of graphs)
        {
            const remove = this.RowMutatingCommand(AdminCapability.Environments, () => this.Delete(environment, graph.name))
            rows.Add(new GraphRowViewModel(graph, remove))
        }
        this.ReplaceRows(rows)
        return rows.Count > 0
    }

    private ReplaceRows(rows: ObservableCollection<GraphRowViewModel>): void
    {
        const old = this.rows
        this.rows = rows
        this.RaisePropertyChanged(GraphsTabViewModel.RowsProperty, old, rows)
    }

    private async NewGraph(): Promise<void>
    {
        const environment = this.Environment
        if (environment === undefined)
        {
            return
        }
        const existing = this.rows.ToArray().map(r => r.Name)
        await this.OpenCreate(this.section.Dialogs, d => new CreateGraphDialogViewModel(this.Session, d, environment, existing),
            CreateGraphDialogViewModel.Title, () => this.Refresh())
    }

    private async Delete(environment: string, graph: string): Promise<void>
    {
        const G = GraphsTabViewModel
        await this.Confirm(this.section.Dialogs, {
            Capability: AdminCapability.Environments,
            Title: G.DeleteTitleTemplate.replace(G.GraphToken, graph),
            Message: G.DeleteMessageTemplate.replace(G.GraphToken, graph).replace(G.EnvironmentToken, environment),
            Consequences: G.DeleteConsequences,
            ConfirmLabel: G.DeleteLabel,
            Action: () => this.Session.Client.DeleteGraph(environment, graph),
            OnConfirmed: () => this.Refresh(),
        })
    }
}
