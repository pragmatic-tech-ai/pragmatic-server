import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto, FleetHiveDto, TenantDto } from './portal-types.js'
import { FleetConnection, FleetViewModel } from './fleet-view-model.js'
import type { FleetRow } from './fleet-view-model.js'

export interface TenantEnvRow
{
    name: string
    ready: boolean
    image: string
    detail: string
}

export interface TenantBinding
{
    hasHive: boolean
    hiveName: string
    connection: FleetConnection
    lastSeenLabel: string
    cluster: string
}

// Tenant detail: owning client name, the hive binding (with connection state) and observed environments.
export class TenantDetailViewModel extends Observable
{
    private static readonly UnknownClientLabel = '(unknown client)'
    private static readonly NoHiveLabel = 'No hive yet'
    private static readonly AwaitingLabel = 'Awaiting first dial-in'
    private static readonly DashLabel = '-'
    private static readonly ClusterSeparator = ' / '

    private readonly clientName: string
    private readonly binding: TenantBinding
    private readonly envRows: readonly TenantEnvRow[]

    public constructor(
        private readonly tenant: TenantDto,
        clients: ClientDto[],
        fleet: FleetHiveDto[],
        now: () => Date = () => new Date(),
        quietThresholdMs?: number,
    )
    {
        super()
        const names = new Map<string, string>()
        for (const c of clients)
        {
            names.set(c.id, c.displayName)
        }
        this.clientName = names.get(tenant.clientId) ?? TenantDetailViewModel.UnknownClientLabel
        const fleetRows = new Map<string, FleetRow>()
        for (const r of new FleetViewModel(fleet, now, quietThresholdMs).Rows)
        {
            fleetRows.set(r.id, r)
        }
        const hive = fleet.find(h => h.tenant?.id === tenant.id)
        this.binding = TenantDetailViewModel.DeriveBinding(hive, hive ? fleetRows.get(hive.id) : undefined)
        this.envRows = (hive?.environments ?? []).map(e => ({
            name: e.name,
            ready: e.ready,
            image: e.image ?? TenantDetailViewModel.DashLabel,
            detail: e.detail,
        }))
    }

    public get Tenant(): TenantDto
    {
        return this.tenant
    }

    public get ClientName(): string
    {
        return this.clientName
    }

    public get Binding(): TenantBinding
    {
        return this.binding
    }

    public get EnvRows(): readonly TenantEnvRow[]
    {
        return this.envRows
    }

    private static DeriveBinding(hive: FleetHiveDto | undefined, row: FleetRow | undefined): TenantBinding
    {
        if (!hive)
        {
            return {
                hasHive: false,
                hiveName: TenantDetailViewModel.NoHiveLabel,
                connection: FleetConnection.Awaiting,
                lastSeenLabel: TenantDetailViewModel.AwaitingLabel,
                cluster: TenantDetailViewModel.DashLabel,
            }
        }
        return {
            hasHive: true,
            hiveName: hive.displayName,
            connection: row ? row.connection : FleetConnection.Awaiting,
            lastSeenLabel: row ? row.lastSeenLabel : TenantDetailViewModel.AwaitingLabel,
            cluster: hive.clusterBackend + TenantDetailViewModel.ClusterSeparator + hive.clusterMode,
        }
    }
}
