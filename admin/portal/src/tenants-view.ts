import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { FleetPresentation } from './fleet-presentation.js'
import { FleetConnection } from './fleet-view-model.js'
import { PillKinds } from './kit/index.js'
import type { PillEntry, TableColumn } from './kit/index.js'
import { PortalDates } from './portal-dates.js'
import type { TenantDto } from './portal-types.js'
import { SectionContainerView, SectionState } from './section-container-view.js'
import type { SectionLabels } from './section-container-view.js'
import { TenantDetailView } from './tenant-detail-view.js'
import { TenantDetailViewModel } from './tenant-detail-view-model.js'
import { TenantsViewModel } from './tenants-view-model.js'
import type { TenantListRow } from './tenants-view-model.js'

export enum TenantsMode
{
    List,
    Detail,
}

// Tenants section: a self-routing container (list / detail). Creation is deferred to the PA-8 wizard.
export class TenantsView extends SectionContainerView<TenantListRow>
{
    private static readonly ListBreadcrumb: readonly string[] = ['Provisioning', 'Tenants']
    private static readonly ListTitle = 'Tenants'
    private static readonly EmptyTitle = 'No tenants yet.'
    private static readonly ErrorTitle = 'Could not load the tenants.'
    private static readonly TableEmptyText = 'No tenants match.'
    private static readonly SearchSeparator = ' '
    private static readonly ConnectionSeparator = ' - '
    private static readonly TenantKey = 'tenant'
    private static readonly ClientKey = 'client'
    private static readonly HiveKey = 'hive'
    private static readonly ConnectionKey = 'connection'
    private static readonly EnvsKey = 'envs'
    private static readonly CreatedKey = 'created'
    private static readonly TenantHeader = 'Tenant'
    private static readonly ClientHeader = 'Client'
    private static readonly HiveHeader = 'Hive'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly EnvsHeader = 'Envs'
    private static readonly CreatedHeader = 'Created'

    private model: TenantsViewModel | undefined = undefined

    public constructor(private readonly client: ControlPlaneClient)
    {
        super()
    }

    public get Mode(): TenantsMode
    {
        return this.State === SectionState.Detail ? TenantsMode.Detail : TenantsMode.List
    }

    protected Labels(): SectionLabels
    {
        return {
            listBreadcrumb: TenantsView.ListBreadcrumb,
            listTitle: TenantsView.ListTitle,
            emptyTitle: TenantsView.EmptyTitle,
            errorTitle: TenantsView.ErrorTitle,
            tableEmptyText: TenantsView.TableEmptyText,
        }
    }

    protected SearchText(row: TenantListRow): string
    {
        return row.displayName + TenantsView.SearchSeparator + row.id + TenantsView.SearchSeparator + row.clientName
    }

    protected async LoadRows(): Promise<readonly TenantListRow[]>
    {
        const [tenants, clients, fleet] = await Promise.all([
            this.client.ListTenants(), this.client.ListClients(), this.client.ListFleet(),
        ])
        if (this.model === undefined)
        {
            this.model = new TenantsViewModel(tenants, clients, fleet)
        }
        else
        {
            this.model.Update(tenants, clients, fleet)
        }
        return this.model.Rows
    }

    protected async BuildDetail(row: TenantListRow): Promise<Visual | undefined>
    {
        const dto: TenantDto = { id: row.id, displayName: row.displayName, clientId: row.clientId, createdAt: row.createdAt }
        const [clients, fleet] = await Promise.all([this.client.ListClients(), this.client.ListFleet()])
        return new TenantDetailView(new TenantDetailViewModel(dto, clients, fleet), () => void this.ShowList())
    }

    private static ConnectionPill(r: TenantListRow): PillEntry
    {
        return PillKinds.For(FleetPresentation.ConnectionKind(r.connection))
    }

    protected Columns(): TableColumn<TenantListRow>[]
    {
        return [
            {
                key: TenantsView.TenantKey,
                header: TenantsView.TenantHeader,
                cell: r => r.displayName,
                sort: (a, b) => a.displayName.localeCompare(b.displayName),
            },
            {
                key: TenantsView.ClientKey,
                header: TenantsView.ClientHeader,
                cell: r => r.clientName,
                sort: (a, b) => a.clientName.localeCompare(b.clientName),
            },
            { key: TenantsView.HiveKey, header: TenantsView.HiveHeader, cell: r => r.hiveName },
            {
                key: TenantsView.ConnectionKey,
                header: TenantsView.ConnectionHeader,
                cell: r => TenantsView.ConnectionPill(r).label + TenantsView.ConnectionSeparator + r.lastSeenLabel,
                tone: r => r.connection === FleetConnection.Connected ? undefined : TenantsView.ConnectionPill(r).tone,
            },
            {
                key: TenantsView.EnvsKey,
                header: TenantsView.EnvsHeader,
                cell: r => String(r.observedEnvCount),
                sort: (a, b) => a.observedEnvCount - b.observedEnvCount,
            },
            { key: TenantsView.CreatedKey, header: TenantsView.CreatedHeader, cell: r => PortalDates.Label(r.createdAt) },
        ]
    }
}
