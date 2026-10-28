import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto, FleetHiveDto, TenantDto } from './portal-types.js'
import { FleetConnection, FleetViewModel } from './fleet-view-model.js'
import type { FleetRow } from './fleet-view-model.js'

export interface TenantListRow
{
    id: string
    displayName: string
    clientId: string
    clientName: string
    hiveName: string
    connection: FleetConnection
    lastSeenLabel: string
    observedEnvCount: number
    createdAt: string | undefined
}

// Global tenant-list roll-up: owning client, serving hive, connection and env count.
export class TenantsViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'

    private static readonly UnknownClientLabel = '(unknown client)'
    private static readonly NoHiveLabel = 'No hive yet'
    private static readonly NoHiveConnectionLabel = 'No hive bound yet'

    private rows: readonly TenantListRow[] = []

    public constructor(
        tenants: TenantDto[],
        clients: ClientDto[],
        fleet: FleetHiveDto[],
        private readonly now: () => Date = () => new Date(),
        private readonly quietThresholdMs?: number,
    )
    {
        super()
        this.rows = this.Derive(tenants, clients, fleet)
    }

    public get Rows(): readonly TenantListRow[]
    {
        return this.rows
    }

    public Update(tenants: TenantDto[], clients: ClientDto[], fleet: FleetHiveDto[]): void
    {
        const old = this.rows
        this.rows = this.Derive(tenants, clients, fleet)
        this.RaisePropertyChanged(TenantsViewModel.RowsProperty, old, this.rows)
    }

    private Derive(tenants: TenantDto[], clients: ClientDto[], fleet: FleetHiveDto[]): TenantListRow[]
    {
        const clientNames = new Map<string, string>()
        for (const c of clients)
        {
            clientNames.set(c.id, c.displayName)
        }
        const fleetRows = new Map<string, FleetRow>()
        for (const r of new FleetViewModel(fleet, this.now, this.quietThresholdMs).Rows)
        {
            fleetRows.set(r.id, r)
        }
        return tenants.map(t => this.DeriveRow(t, clientNames, fleet, fleetRows))
    }

    private DeriveRow(
        t: TenantDto,
        clientNames: Map<string, string>,
        fleet: FleetHiveDto[],
        fleetRows: Map<string, FleetRow>,
    ): TenantListRow
    {
        const hive = fleet.find(h => h.tenant?.id === t.id)
        const fleetRow = hive === undefined ? undefined : fleetRows.get(hive.id)
        return {
            id: t.id,
            displayName: t.displayName,
            clientId: t.clientId,
            clientName: clientNames.get(t.clientId) ?? TenantsViewModel.UnknownClientLabel,
            hiveName: hive === undefined ? TenantsViewModel.NoHiveLabel : hive.displayName,
            connection: fleetRow === undefined ? FleetConnection.Awaiting : fleetRow.connection,
            lastSeenLabel: fleetRow === undefined ? TenantsViewModel.NoHiveConnectionLabel : fleetRow.lastSeenLabel,
            observedEnvCount: hive === undefined ? 0 : hive.environments.length,
            createdAt: t.createdAt,
        }
    }
}
