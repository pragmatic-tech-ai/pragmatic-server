import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { PortalDates } from '../../portal-dates.js'
import type { OwnerPasswordResetDto, TenantDto } from '../../portal-types.js'
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
    private static readonly ResetTitle = "Reset the Owner's password?"
    private static readonly ResetMessage = "A new one-time password is generated for the tenant's Owner and shown once. The old password stops working immediately; the Owner signs in to the Tenant Admin console with the new one."
    private static readonly ResetLabel = 'Reset'
    private static readonly DisplayNameProperty = 'DisplayName'
    private static readonly ClientNameProperty = 'ClientName'
    private static readonly CreatedLabelProperty = 'CreatedLabel'
    private static readonly HasHiveProperty = 'HasHive'
    private static readonly HasNoHiveProperty = 'HasNoHive'
    private static readonly HiveNameProperty = 'HiveName'
    private static readonly ConnectionLabelProperty = 'ConnectionLabel'
    private static readonly LastSeenLabelProperty = 'LastSeenLabel'
    private static readonly ClusterLabelProperty = 'ClusterLabel'
    private static readonly ObservedProperty = 'Observed'

    private tenant: TenantDto | undefined
    private detail: TenantDetailViewModel | undefined
    private hiveId: string | undefined
    private observed = new ObservedEnvironmentsViewModel([])
    private readonly deleteCommand: RelayCommand
    private readonly resetOwnerPasswordCommand: RelayCommand
    private readonly openHiveCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: TenantsSectionService, public readonly Id: string)
    {
        super(session)
        this.deleteCommand = this.MutatingCommand(() => this.Delete())
        this.resetOwnerPasswordCommand = this.MutatingCommand(() => this.ResetOwnerPassword())
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
        const before = this.Snapshot()
        this.tenant = tenant
        this.detail = new TenantDetailViewModel(tenant, clients, fleet)
        this.hiveId = hive?.id
        this.observed = new ObservedEnvironmentsViewModel(hive?.environments ?? [])
        this.RaiseChangedSince(before)
        this.openHiveCommand.RaiseCanExecuteChanged()
        return true
    }

    private get Binding(): TenantBinding | undefined
    {
        return this.detail?.Binding
    }

    // The bound values a load can change, captured before it applies.
    private Snapshot(): TenantDetailSnapshot
    {
        return {
            DisplayName: this.DisplayName,
            ClientName: this.ClientName,
            CreatedLabel: this.CreatedLabel,
            HasHive: this.HasHive,
            HiveName: this.HiveName,
            ConnectionLabel: this.ConnectionLabel,
            LastSeenLabel: this.LastSeenLabel,
            ClusterLabel: this.ClusterLabel,
            Observed: this.Observed,
        }
    }

    private RaiseChangedSince(b: TenantDetailSnapshot): void
    {
        const P = TenantDetailPageViewModel
        this.RaisePropertyChanged(P.DisplayNameProperty, b.DisplayName, this.DisplayName)
        this.RaisePropertyChanged(P.ClientNameProperty, b.ClientName, this.ClientName)
        this.RaisePropertyChanged(P.CreatedLabelProperty, b.CreatedLabel, this.CreatedLabel)
        this.RaisePropertyChanged(P.HasHiveProperty, b.HasHive, this.HasHive)
        this.RaisePropertyChanged(P.HasNoHiveProperty, !b.HasHive, this.HasNoHive)
        this.RaisePropertyChanged(P.HiveNameProperty, b.HiveName, this.HiveName)
        this.RaisePropertyChanged(P.ConnectionLabelProperty, b.ConnectionLabel, this.ConnectionLabel)
        this.RaisePropertyChanged(P.LastSeenLabelProperty, b.LastSeenLabel, this.LastSeenLabel)
        this.RaisePropertyChanged(P.ClusterLabelProperty, b.ClusterLabel, this.ClusterLabel)
        this.RaisePropertyChanged(P.ObservedProperty, b.Observed, this.Observed)
    }

    private OpenHive(): void
    {
        if (this.hiveId !== undefined)
        {
            this.section.OpenHive(this.hiveId)
        }
    }

    // Resets the tenant Owner's password (confirmed by the tenant id) and reveals the new one once.
    public get ResetOwnerPasswordCommand(): RelayCommand
    {
        return this.resetOwnerPasswordCommand
    }

    private ResetOwnerPassword(): Promise<void>
    {
        let reset: OwnerPasswordResetDto | undefined
        return this.ConfirmByName(this.section.Dialogs, {
            Expected: this.Id,
            Title: TenantDetailPageViewModel.ResetTitle,
            Message: TenantDetailPageViewModel.ResetMessage,
            ConfirmLabel: TenantDetailPageViewModel.ResetLabel,
            Action: async () => { reset = await this.Session.Client.ResetOwnerPassword(this.Id) },
            OnConfirmed: async () =>
            {
                if (reset !== undefined)
                {
                    this.section.RevealResetOwnerPassword(this.Id, reset.ownerEmail, reset.ownerPassword)
                    reset = undefined
                }
            },
        })
    }

    private Delete(): Promise<void>
    {
        return this.ConfirmByName(this.section.Dialogs, {
            Expected: this.Id,
            Title: TenantDetailPageViewModel.DeleteTitle,
            Message: TenantDetailPageViewModel.DeleteMessage,
            Action: () => this.Session.Client.DeleteTenant(this.Id),
            OnConfirmed: () => this.section.BackAndRefresh(),
        })
    }
}

// The tenant detail's bound values before a load, for its change notifications.
interface TenantDetailSnapshot
{
    readonly DisplayName: string
    readonly ClientName: string
    readonly CreatedLabel: string
    readonly HasHive: boolean
    readonly HiveName: string
    readonly ConnectionLabel: string
    readonly LastSeenLabel: string
    readonly ClusterLabel: string
    readonly Observed: ObservedEnvironmentsViewModel
}
