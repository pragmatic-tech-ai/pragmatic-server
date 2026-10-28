import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ClientDetailViewModel, ClientTenantRow } from './client-detail-view-model.js'
import { FleetConnection } from './fleet-view-model.js'
import { FleetPresentation } from './fleet-presentation.js'
import {
    DataTable, KeyActivatedButton, KeyValueGrid, PageHeader, PillKinds, ScreenHost, Section, TableDensity,
} from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'

// Client detail: contract/profile plus one row per tenant with its hive's observed connection. The view-model
// arrives already loaded, so the body is populated immediately; a client with no tenants shows an empty table.
export class ClientDetailView extends StackPanel
{
    private static readonly BackText = 'Back to clients'
    private static readonly BreadcrumbRoot = 'Clients'
    private static readonly ProfileTitle = 'Contract & profile'
    private static readonly TenantsTitle = 'Tenants and hives'
    private static readonly ObservedCaption = "Connection and environments are observed from each hive's last check-in."
    private static readonly TableEmptyText = 'No tenants yet.'
    private static readonly TenantKey = 'tenant'
    private static readonly HiveKey = 'hive'
    private static readonly ConnectionKey = 'connection'
    private static readonly EnvsKey = 'envs'
    private static readonly TenantHeader = 'Tenant'
    private static readonly HiveHeader = 'Hive'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly EnvsHeader = 'Observed envs'
    private static readonly ConnectionSeparator = ' - '
    private static readonly SearchSeparator = ' '

    private readonly vm: ClientDetailViewModel
    private readonly onBack: () => void
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private tableSlot = new StackPanel()

    public constructor(vm: ClientDetailViewModel, onBack: () => void)
    {
        super()
        this.vm = vm
        this.onBack = onBack
        this.Orientation = Orientation.Vertical
        this.tableSlot.Orientation = Orientation.Vertical
        this.host = new ScreenHost(this.Inputs())
        this.AddChild(this.host)
    }

    // Test seam: the body host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the currently shown tenant table.
    public get Table(): DataTable<ClientTenantRow> | undefined
    {
        const child = [...this.tableSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<ClientTenantRow> : undefined
    }

    private Inputs(): ScreenHostInputs
    {
        return {
            loading: false,
            allowed: true,
            error: false,
            isEmpty: false,
            content: () => this.BuildContent(),
        }
    }

    private BuildContent(): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(this.BuildBack())
        root.AddChild(new PageHeader({
            breadcrumb: [ClientDetailView.BreadcrumbRoot, this.vm.Client.displayName],
            title: this.vm.Client.displayName,
        }))
        root.AddChild(new Section({
            title: ClientDetailView.ProfileTitle,
            body: new KeyValueGrid({ items: this.vm.Profile }),
        }))
        this.tableSlot = new StackPanel()
        this.tableSlot.Orientation = Orientation.Vertical
        root.AddChild(new Section({
            title: ClientDetailView.TenantsTitle,
            sub: ClientDetailView.ObservedCaption,
            body: this.tableSlot,
        }))
        this.tableSlot.AddChild(new DataTable<ClientTenantRow>({
            columns: ClientDetailView.Columns(),
            rows: this.vm.Rows,
            density: TableDensity.Dense,
            searchText: r => r.tenantName + ClientDetailView.SearchSeparator + r.hiveName,
            emptyText: ClientDetailView.TableEmptyText,
        }))
        return root
    }

    private BuildBack(): Visual
    {
        const button = new KeyActivatedButton(() => this.onBack())
        const text = new TextBlock()
        text.Text = ClientDetailView.BackText
        button.Content = text
        return button
    }

    private static Columns(): TableColumn<ClientTenantRow>[]
    {
        return [
            {
                key: ClientDetailView.TenantKey,
                header: ClientDetailView.TenantHeader,
                cell: r => r.tenantName,
                sort: (a, b) => a.tenantName.localeCompare(b.tenantName),
            },
            {
                key: ClientDetailView.HiveKey,
                header: ClientDetailView.HiveHeader,
                cell: r => r.hiveName,
            },
            {
                key: ClientDetailView.ConnectionKey,
                header: ClientDetailView.ConnectionHeader,
                cell: r => PillKinds.For(FleetPresentation.ConnectionKind(r.connection)).label
                    + ClientDetailView.ConnectionSeparator + r.lastSeenLabel,
                tone: r => r.connection === FleetConnection.Connected
                    ? undefined
                    : PillKinds.For(FleetPresentation.ConnectionKind(r.connection)).tone,
            },
            {
                key: ClientDetailView.EnvsKey,
                header: ClientDetailView.EnvsHeader,
                cell: r => String(r.observedEnvCount),
                sort: (a, b) => a.observedEnvCount - b.observedEnvCount,
            },
        ]
    }
}
