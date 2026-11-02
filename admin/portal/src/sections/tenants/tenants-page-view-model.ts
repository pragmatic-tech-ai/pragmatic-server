import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PortalDates } from '../../portal-dates.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { TenantsViewModel, type TenantListRow } from '../../tenants-view-model.js'
import { FleetHiveRowViewModel } from '../fleet/fleet-page-view-model.js'
import { NewTenantDialogViewModel } from './new-tenant-dialog-view-model.js'
import type { TenantsSectionService } from './tenants-section-service.js'

// One tenants-table row: the tenant, its client and the hive serving it.
export class TenantRowViewModel extends Observable
{
    private readonly openCommand: RelayCommand

    public constructor(private readonly row: TenantListRow, open: RelayCommand)
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

    public get ClientName(): string
    {
        return this.row.clientName
    }

    public get HiveName(): string
    {
        return this.row.hiveName
    }

    public get ConnectionLabel(): string
    {
        return FleetHiveRowViewModel.ConnectionText(this.row.connection)
    }

    public get LastSeenLabel(): string
    {
        return this.row.lastSeenLabel
    }

    public get EnvCountText(): string
    {
        return String(this.row.observedEnvCount)
    }

    public get CreatedLabel(): string
    {
        return PortalDates.Label(this.row.createdAt)
    }

    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }
}

// The Tenants list. Its one primary action creates a tenant through a dialog;
// success reveals the new Owner's one-time password on its own page.
export class TenantsPageViewModel extends PortalPageViewModel
{
    private static readonly NewTenantTitle = 'Create tenant'

    private readonly rows = new ObservableCollection<TenantRowViewModel>()
    private readonly openCommand: RelayCommand
    private readonly newCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: TenantsSectionService)
    {
        super(session)
        this.openCommand = new RelayCommand(row => this.Open(row))
        this.newCommand = this.MutatingCommand(() => this.CreateTenant())
    }

    public get Rows(): ObservableCollection<TenantRowViewModel>
    {
        return this.rows
    }

    // Opens a row's tenant detail; the parameter is the TenantRowViewModel.
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
        const api = this.Session.Client
        const [tenants, clients, fleet] = await Promise.all([api.ListTenants(), api.ListClients(), api.ListFleet()])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.rows.Clear()
        for (const row of new TenantsViewModel(tenants, clients, fleet).Rows)
        {
            this.rows.Add(new TenantRowViewModel(row, this.openCommand))
        }
        return tenants.length > 0
    }

    private Open(row: unknown): void
    {
        if (row instanceof TenantRowViewModel)
        {
            this.section.OpenTenant(row.Id)
        }
    }

    private async CreateTenant(): Promise<void>
    {
        const dialogs = this.section.Dialogs
        if (dialogs === undefined)
        {
            return
        }
        const dialog = new NewTenantDialogViewModel(this.Session, dialogs)
        await dialog.Load()
        const created = await dialog.Open(TenantsPageViewModel.NewTenantTitle)
        if (created === undefined)
        {
            return
        }
        this.section.RevealOwnerPassword(created)
        await this.Refresh()
    }
}
