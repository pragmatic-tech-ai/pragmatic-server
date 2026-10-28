import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { TenantDetailViewModel, TenantEnvRow } from './tenant-detail-view-model.js'
import { FleetPresentation } from './fleet-presentation.js'
import { ObservedEnvTable } from './observed-env-table.js'
import {
    DataTable, KeyActivatedButton, KeyValueGrid, ObservedPanel, PageHeader, PillKinds, ScreenHost, Section,
} from './kit/index.js'
import type { KeyValueItem, ScreenHostInputs } from './kit/index.js'

// Tenant detail: owning client, the hive binding with its observed connection, and the environments
// observed from that hive's last check-in (rendered read-only inside an ObservedPanel). The view-model
// arrives already loaded, so the body is populated immediately; a tenant with no hive shows an empty table.
export class TenantDetailView extends StackPanel
{
    private static readonly BackText = 'Back to tenants'
    private static readonly BreadcrumbRoot = 'Tenants'
    private static readonly BindingTitle = 'Hive binding'
    private static readonly EnvsTitle = 'Environments'
    private static readonly ClientLabel = 'Client'
    private static readonly HiveLabel = 'Hive'
    private static readonly ConnectionLabel = 'Connection'
    private static readonly ClusterLabel = 'Cluster'
    private static readonly ConnectionSeparator = ' - '

    private readonly vm: TenantDetailViewModel
    private readonly onBack: () => void
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private tableSlot = new StackPanel()

    public constructor(vm: TenantDetailViewModel, onBack: () => void)
    {
        super()
        this.vm = vm
        this.onBack = onBack
        this.Orientation = Orientation.Vertical
        this.host = new ScreenHost(this.Inputs())
        this.AddChild(this.host)
    }

    // Test seam: the body host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the currently shown environments table.
    public get EnvTable(): DataTable<TenantEnvRow> | undefined
    {
        const child = [...this.tableSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<TenantEnvRow> : undefined
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
            breadcrumb: [TenantDetailView.BreadcrumbRoot, this.vm.Tenant.displayName],
            title: this.vm.Tenant.displayName,
        }))
        root.AddChild(new Section({
            title: TenantDetailView.BindingTitle,
            body: new KeyValueGrid({ items: this.BindingItems() }),
        }))
        this.tableSlot = new StackPanel()
        this.tableSlot.Orientation = Orientation.Vertical
        root.AddChild(new ObservedPanel({ title: TenantDetailView.EnvsTitle, body: this.tableSlot }))
        this.tableSlot.AddChild(ObservedEnvTable.Build(this.vm.EnvRows))
        return root
    }

    private BindingItems(): KeyValueItem[]
    {
        const binding = this.vm.Binding
        const connection = PillKinds.For(FleetPresentation.ConnectionKind(binding.connection)).label
            + TenantDetailView.ConnectionSeparator + binding.lastSeenLabel
        return [
            { key: TenantDetailView.ClientLabel, value: this.vm.ClientName },
            { key: TenantDetailView.HiveLabel, value: binding.hiveName },
            { key: TenantDetailView.ConnectionLabel, value: connection },
            { key: TenantDetailView.ClusterLabel, value: binding.cluster },
        ]
    }

    private BuildBack(): Visual
    {
        const button = new KeyActivatedButton(() => this.onBack())
        const text = new TextBlock()
        text.Text = TenantDetailView.BackText
        button.Content = text
        return button
    }
}
