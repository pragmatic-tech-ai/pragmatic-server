import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto, FleetHiveDto, TenantDto } from './portal-types.js'
import { PortalDates } from './portal-dates.js'
import { FleetConnection, FleetViewModel } from './fleet-view-model.js'
import type { FleetRow } from './fleet-view-model.js'
import type { KeyValueItem } from './kit/index.js'

export interface ClientTenantRow
{
    tenantId: string
    tenantName: string
    hiveName: string
    connection: FleetConnection
    lastSeenLabel: string
    observedEnvCount: number
}

// Client detail: profile key/values plus one row per tenant with its hive's connection state.
export class ClientDetailViewModel extends Observable
{
    private static readonly ClientIdKey = 'Client id'
    private static readonly DisplayNameKey = 'Display name'
    private static readonly SubscriptionRefKey = 'Subscription ref'
    private static readonly ClientSinceKey = 'Client since'
    private static readonly NoneLabel = '(none)'
    private static readonly NoHiveLabel = 'No hive yet'
    private static readonly AwaitingLabel = 'Awaiting first dial-in'

    private readonly profile: readonly KeyValueItem[]
    private readonly rows: readonly ClientTenantRow[]

    public constructor(
        private readonly client: ClientDto,
        tenants: TenantDto[],
        fleet: FleetHiveDto[],
        now: () => Date = () => new Date(),
        quietThresholdMs?: number,
    )
    {
        super()
        this.profile = ClientDetailViewModel.DeriveProfile(client)
        const fleetRows = new Map<string, FleetRow>()
        for (const r of new FleetViewModel(fleet, now, quietThresholdMs).Rows)
        {
            fleetRows.set(r.id, r)
        }
        this.rows = tenants.map(t => ClientDetailViewModel.DeriveRow(t, fleet, fleetRows))
    }

    public get Client(): ClientDto
    {
        return this.client
    }

    public get Profile(): readonly KeyValueItem[]
    {
        return this.profile
    }

    public get Rows(): readonly ClientTenantRow[]
    {
        return this.rows
    }

    public static ClientSinceLabel(iso: string): string
    {
        return PortalDates.Label(iso)
    }

    private static DeriveProfile(client: ClientDto): KeyValueItem[]
    {
        return [
            { key: ClientDetailViewModel.ClientIdKey, value: client.id },
            { key: ClientDetailViewModel.DisplayNameKey, value: client.displayName },
            { key: ClientDetailViewModel.SubscriptionRefKey, value: client.subscriptionRef ?? ClientDetailViewModel.NoneLabel },
            { key: ClientDetailViewModel.ClientSinceKey, value: ClientDetailViewModel.ClientSinceLabel(client.createdAt) },
        ]
    }

    private static DeriveRow(tenant: TenantDto, fleet: FleetHiveDto[], fleetRows: Map<string, FleetRow>): ClientTenantRow
    {
        const hive = fleet.find(h => h.tenant?.id === tenant.id)
        const row = hive ? fleetRows.get(hive.id) : undefined
        return {
            tenantId: tenant.id,
            tenantName: tenant.displayName,
            hiveName: hive ? hive.displayName : ClientDetailViewModel.NoHiveLabel,
            connection: row ? row.connection : FleetConnection.Awaiting,
            lastSeenLabel: row ? row.lastSeenLabel : ClientDetailViewModel.AwaitingLabel,
            observedEnvCount: hive ? hive.environments.length : 0,
        }
    }
}
