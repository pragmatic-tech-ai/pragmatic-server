import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ClientsViewModel, type ClientListRow } from '../../clients-view-model.js'
import { PortalDates } from '../../portal-dates.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import type { ClientsSectionService } from './clients-section-service.js'
import { NewClientDialogViewModel } from './new-client-dialog-view-model.js'

// One clients-table row.
export class ClientRowViewModel extends Observable
{
    private static readonly NoneLabel = '-'

    private readonly openCommand: RelayCommand

    public constructor(private readonly row: ClientListRow, open: RelayCommand)
    {
        super()
        this.openCommand = new RelayCommand(() => open.Execute(this))
    }

    public get Id(): string
    {
        return this.row.id
    }

    public get DisplayName(): string
    {
        return this.row.displayName
    }

    public get SubscriptionLabel(): string
    {
        return this.row.subscriptionRef ?? ClientRowViewModel.NoneLabel
    }

    public get TenantCountText(): string
    {
        return String(this.row.tenantCount)
    }

    public get HiveCountText(): string
    {
        return String(this.row.hiveCount)
    }

    public get ConnectionSummary(): string
    {
        return this.row.connectionSummary
    }

    public get ClientSinceLabel(): string
    {
        return PortalDates.Label(this.row.createdAt)
    }

    // Opens this client's detail (the page's OpenCommand with this row).
    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }
}

// The Clients list: every client with its tenant and hive counts. Its one
// primary action creates a client through a dialog.
export class ClientsPageViewModel extends PortalPageViewModel
{
    private static readonly NewClientTitle = 'Create client'

    private readonly rows = new ObservableCollection<ClientRowViewModel>()
    private readonly openCommand: RelayCommand
    private readonly newCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: ClientsSectionService)
    {
        super(session)
        this.openCommand = new RelayCommand(row => this.Open(row))
        this.newCommand = this.MutatingCommand(() => this.CreateClient())
    }

    public get Rows(): ObservableCollection<ClientRowViewModel>
    {
        return this.rows
    }

    // Opens a row's client detail; the parameter is the ClientRowViewModel.
    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }

    public get NewCommand(): RelayCommand
    {
        return this.newCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const client = this.Session.Client
        const [clients, tenants, fleet] = await Promise.all([client.ListClients(), client.ListTenants(), client.ListFleet()])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.rows.Clear()
        for (const row of new ClientsViewModel(clients, tenants, fleet).Rows)
        {
            this.rows.Add(new ClientRowViewModel(row, this.openCommand))
        }
        return clients.length > 0
    }

    private Open(row: unknown): void
    {
        if (row instanceof ClientRowViewModel)
        {
            this.section.OpenClient(row.Id)
        }
    }

    private async CreateClient(): Promise<void>
    {
        const dialogs = this.section.Dialogs
        if (dialogs === undefined)
        {
            return
        }
        const created = await new NewClientDialogViewModel(this.Session, dialogs).Open(ClientsPageViewModel.NewClientTitle)
        if (created !== undefined)
        {
            await this.Refresh()
        }
    }
}
