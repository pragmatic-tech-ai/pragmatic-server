import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { PortalDates } from '../../portal-dates.js'
import type { TenantDto } from '../../portal-types.js'
import { NameConfirmDialogViewModel } from '../../shell/name-confirm-dialog-view-model.js'
import { ObservedEnvironmentsViewModel } from '../../shell/observed-environments-view-model.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { TenantDetailViewModel, type TenantBinding } from '../../tenant-detail-view-model.js'
import { FleetHiveRowViewModel } from '../fleet/fleet-page-view-model.js'
import type { TenantsSectionService } from './tenants-section-service.js'

// A tenant's detail: its client, the hive bound to it (one tenant, one hive)
// and the environments that hive observes, read-only. Delete is irreversible,
// so it asks for the tenant id to be typed.
export class TenantDetailPageViewModel extends PortalPageViewModel
{
    private static readonly NotFoundTemplate = 'Tenant {id} was not found.'
    private static readonly IdToken = '{id}'
    private static readonly DeleteTitle = 'Delete this tenant?'
    private static readonly DeleteMessage = 'The tenant record is removed. A tenant that still has a hive cannot be deleted; delete its hive first.'
    private static readonly ChangedProperties = ['DisplayName', 'ClientName', 'CreatedLabel', 'HasHive', 'HasNoHive', 'HiveName', 'ConnectionLabel', 'LastSeenLabel', 'ClusterLabel', 'Observed']

    private tenant: TenantDto | undefined
    private detail: TenantDetailViewModel | undefined
    private hiveId: string | undefined
    private observed = new ObservedEnvironmentsViewModel([])
    private readonly deleteCommand: RelayCommand
    private readonly openHiveCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: TenantsSectionService, public readonly Id: string)
    {
        super(session)
        this.deleteCommand = this.MutatingCommand(() => this.Delete())
        this.openHiveCommand = new RelayCommand(() => this.OpenHive(), () => this.hiveId !== undefined)
    }

    public get DisplayName(): string
    {
        return this.tenant?.displayName ?? this.Id
    }

    public get ClientName(): string
    {
        return this.detail?.ClientName ?? ''
    }

    public get CreatedLabel(): string
    {
        return PortalDates.Label(this.tenant?.createdAt)
    }

    public get HasHive(): boolean
    {
        return this.Binding?.hasHive ?? false
    }

    public get HasNoHive(): boolean
    {
        return !this.HasHive
    }

    public get HiveName(): string
    {
        return this.Binding?.hiveName ?? ''
    }

    public get ConnectionLabel(): string
    {
        const binding = this.Binding
        return binding === undefined || !binding.hasHive ? '' : FleetHiveRowViewModel.ConnectionText(binding.connection)
    }

    public get LastSeenLabel(): string
    {
        return this.Binding?.lastSeenLabel ?? ''
    }

    public get ClusterLabel(): string
    {
        return this.Binding?.cluster ?? ''
    }

    // The observed environments panel: read-only, no commands.
    public get Observed(): ObservedEnvironmentsViewModel
    {
        return this.observed
    }

    public get BackCommand(): RelayCommand
    {
        return this.section.BackCommand
    }

    public get DeleteCommand(): RelayCommand
    {
        return this.deleteCommand
    }

    // Opens the bound hive's detail in the Hives section.
    public get OpenHiveCommand(): RelayCommand
    {
        return this.openHiveCommand
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
        const tenant = tenants.find(t => t.id === this.Id)
        if (tenant === undefined)
        {
            throw new Error(TenantDetailPageViewModel.NotFoundTemplate.replace(TenantDetailPageViewModel.IdToken, this.Id))
        }
        const hive = fleet.find(h => h.tenant?.id === tenant.id)
        const before = TenantDetailPageViewModel.ChangedProperties.map(p => this.ValueOf(p))
        this.tenant = tenant
        this.detail = new TenantDetailViewModel(tenant, clients, fleet)
        this.hiveId = hive?.id
        this.observed = new ObservedEnvironmentsViewModel(hive?.environments ?? [])
        TenantDetailPageViewModel.ChangedProperties.forEach((p, i) => this.RaisePropertyChanged(p, before[i], this.ValueOf(p)))
        this.openHiveCommand.RaiseCanExecuteChanged()
        return true
    }

    private get Binding(): TenantBinding | undefined
    {
        return this.detail?.Binding
    }

    private ValueOf(property: string): unknown
    {
        return (this as unknown as Record<string, unknown>)[property]
    }

    private OpenHive(): void
    {
        if (this.hiveId !== undefined)
        {
            this.section.OpenHive(this.hiveId)
        }
    }

    private async Delete(): Promise<void>
    {
        const dialogs = this.section.Dialogs
        if (dialogs === undefined)
        {
            return
        }
        const api = this.Session.Client
        const confirm = new NameConfirmDialogViewModel(this.Session, dialogs, this.Id, TenantDetailPageViewModel.DeleteMessage,
            () => api.DeleteTenant(this.Id))
        if (await confirm.Open(TenantDetailPageViewModel.DeleteTitle) === NameConfirmDialogViewModel.Confirmed)
        {
            await this.section.BackAndRefresh()
        }
    }
}
