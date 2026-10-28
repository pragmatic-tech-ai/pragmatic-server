import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { FleetPresentation } from './fleet-presentation.js'
import { FleetConnection } from './fleet-view-model.js'
import { DataTable, PageHeader, PillKinds, ScreenHost, TableDensity } from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'
import { PortalDates } from './portal-dates.js'
import type { ClientDto, FleetHiveDto, IPortalNavigator, IPortalView, TenantDto } from './portal-types.js'
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
// Every screen swap clears the content host and adds a freshly built screen (one parent per Visual).
export class TenantsView extends StackPanel implements IPortalView
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

    private readonly content = new StackPanel()
    private host: ScreenHost
    private listSlot = new StackPanel()
    private model: TenantsViewModel | undefined
    private mode = TenantsMode.List
    private listMounted = true
    private detailRow: TenantListRow | undefined
    private nav: IPortalNavigator | undefined

    public constructor(private readonly client: ControlPlaneClient)
    {
        super()
        this.Orientation = Orientation.Vertical
        this.content.Orientation = Orientation.Vertical
        this.host = new ScreenHost(TenantsView.Inputs(true, false, true))
        this.AddChild(this.content)
        this.content.AddChild(this.host)
    }

    // Test seam: the list screen's host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the list table (populated list only).
    public get Table(): DataTable<TenantListRow> | undefined
    {
        const child = [...this.listSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<TenantListRow> : undefined
    }

    public get Mode(): TenantsMode
    {
        return this.mode
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
        if (this.mode === TenantsMode.Detail && this.detailRow !== undefined)
        {
            await this.ShowDetail(this.detailRow)
        }
        else if (this.mode === TenantsMode.List)
        {
            await this.ShowList()
        }
    }

    public async ShowList(): Promise<void>
    {
        if (!this.listMounted)
        {
            this.host = new ScreenHost(TenantsView.Inputs(true, false, true))
            this.Swap(this.host)
            this.listMounted = true
        }
        this.mode = TenantsMode.List
        this.detailRow = undefined
        if (this.model === undefined)
        {
            this.host.Update(TenantsView.Inputs(true, false, true))
        }
        try
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
        }
        catch
        {
            this.host.Update(TenantsView.Inputs(false, true, true, undefined, () => void this.Refresh()))
            return
        }
        if (this.mode !== TenantsMode.List)
        {
            return
        }
        this.host.Update(this.LoadedInputs(this.model))
    }

    public async ShowDetail(row: TenantListRow): Promise<void>
    {
        this.mode = TenantsMode.Detail
        this.detailRow = row
        const dto: TenantDto = { id: row.id, displayName: row.displayName, clientId: row.clientId, createdAt: row.createdAt }
        let clients: ClientDto[]
        let fleet: FleetHiveDto[]
        try
        {
            [clients, fleet] = await Promise.all([this.client.ListClients(), this.client.ListFleet()])
        }
        catch
        {
            if (this.mode !== TenantsMode.Detail || this.detailRow !== row)
            {
                return
            }
            this.mode = TenantsMode.List
            this.detailRow = undefined
            this.listMounted = true
            this.host = new ScreenHost(TenantsView.Inputs(false, true, true))
            this.Swap(this.host)
            return
        }
        if (this.mode !== TenantsMode.Detail || this.detailRow !== row)
        {
            return
        }
        this.listMounted = false
        this.Swap(new TenantDetailView(new TenantDetailViewModel(dto, clients, fleet), () => void this.ShowList()))
    }

    private static Inputs(loading: boolean, error: boolean, isEmpty: boolean, content?: () => Visual, onRetry?: () => void): ScreenHostInputs
    {
        return {
            loading,
            allowed: true,
            error,
            isEmpty,
            empty: { title: TenantsView.EmptyTitle },
            errorConfig: { title: TenantsView.ErrorTitle, onRetry },
            content,
        }
    }

    private LoadedInputs(model: TenantsViewModel): ScreenHostInputs
    {
        return {
            loading: false,
            allowed: true,
            error: false,
            isEmpty: model.Rows.length === 0,
            empty: { title: TenantsView.EmptyTitle },
            errorConfig: { title: TenantsView.ErrorTitle, onRetry: () => void this.Refresh() },
            content: () => this.BuildList(model),
        }
    }

    private Swap(screen: Visual): void
    {
        for (const child of [...this.content.Children])
        {
            this.content.RemoveChild(child)
        }
        this.content.AddChild(screen)
    }

    private BuildList(model: TenantsViewModel): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: TenantsView.ListBreadcrumb, title: TenantsView.ListTitle }))
        // Fresh slot per render: the previous one is still parented to the previous root.
        this.listSlot = new StackPanel()
        this.listSlot.Orientation = Orientation.Vertical
        this.listSlot.AddChild(new DataTable<TenantListRow>({
            columns: TenantsView.Columns(),
            rows: model.Rows,
            density: TableDensity.Dense,
            searchText: r => r.displayName + TenantsView.SearchSeparator + r.id + TenantsView.SearchSeparator + r.clientName,
            onOpen: r => void this.ShowDetail(r),
            emptyText: TenantsView.TableEmptyText,
        }))
        root.AddChild(this.listSlot)
        return root
    }

    private static ConnectionPill(r: TenantListRow): ReturnType<typeof PillKinds.For>
    {
        return PillKinds.For(FleetPresentation.ConnectionKind(r.connection))
    }

    private static Columns(): TableColumn<TenantListRow>[]
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
