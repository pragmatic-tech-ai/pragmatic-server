import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto, FleetHiveDto, TenantDto } from './portal-types.js'
import { FleetConnection, FleetViewModel } from './fleet-view-model.js'

export interface ClientListRow
{
    id: string
    displayName: string
    subscriptionRef: string | undefined
    createdAt: string
    tenantCount: number
    hiveCount: number
    connectionSummary: string
}

// Client-list roll-up: per-client tenant/hive counts and a connection summary.
export class ClientsViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'

    private static readonly NoHivesLabel = 'No hives'
    private static readonly SummarySeparator = ', '
    private static readonly CountToken = '{n}'
    private static readonly ConnectedTemplate = '{n} connected'
    private static readonly QuietTemplate = '{n} quiet'
    private static readonly AwaitingTemplate = '{n} awaiting'

    private rows: readonly ClientListRow[] = []

    public constructor(
        clients: ClientDto[],
        tenants: TenantDto[],
        fleet: FleetHiveDto[],
        private readonly now: () => Date = () => new Date(),
        private readonly quietThresholdMs?: number,
    )
    {
        super()
        this.rows = this.Derive(clients, tenants, fleet)
    }

    public get Rows(): readonly ClientListRow[]
    {
        return this.rows
    }

    public Update(clients: ClientDto[], tenants: TenantDto[], fleet: FleetHiveDto[]): void
    {
        const old = this.rows
        this.rows = this.Derive(clients, tenants, fleet)
        this.RaisePropertyChanged(ClientsViewModel.RowsProperty, old, this.rows)
    }

    private Derive(clients: ClientDto[], tenants: TenantDto[], fleet: FleetHiveDto[]): ClientListRow[]
    {
        const connections = new Map<string, FleetConnection>()
        for (const r of new FleetViewModel(fleet, this.now, this.quietThresholdMs).Rows)
        {
            connections.set(r.id, r.connection)
        }
        return clients.map(c => this.DeriveRow(c, tenants, fleet, connections))
    }

    private DeriveRow(
        c: ClientDto,
        tenants: TenantDto[],
        fleet: FleetHiveDto[],
        connections: Map<string, FleetConnection>,
    ): ClientListRow
    {
        const hives = fleet.filter(h => h.client?.id === c.id)
        return {
            id: c.id,
            displayName: c.displayName,
            subscriptionRef: c.subscriptionRef,
            createdAt: c.createdAt,
            tenantCount: tenants.filter(t => t.clientId === c.id).length,
            hiveCount: hives.length,
            connectionSummary: ClientsViewModel.Summarize(hives.map(h => connections.get(h.id))),
        }
    }

    private static Summarize(states: (FleetConnection | undefined)[]): string
    {
        if (states.length === 0)
        {
            return ClientsViewModel.NoHivesLabel
        }
        const parts: string[] = []
        const add = (kind: FleetConnection, template: string): void =>
        {
            const n = states.filter(s => s === kind).length
            if (n > 0)
            {
                parts.push(template.replace(ClientsViewModel.CountToken, String(n)))
            }
        }
        add(FleetConnection.Connected, ClientsViewModel.ConnectedTemplate)
        add(FleetConnection.Quiet, ClientsViewModel.QuietTemplate)
        add(FleetConnection.Awaiting, ClientsViewModel.AwaitingTemplate)
        return parts.join(ClientsViewModel.SummarySeparator)
    }
}
