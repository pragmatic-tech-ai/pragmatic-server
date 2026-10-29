import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { HiveDetailViewModel, LedgerRow, ObservationHistoryRow } from './hive-detail-view-model.js'
import { ObservedEnvTable } from './observed-env-table.js'
import type { ObservedEnvRow } from './observed-env-table.js'
import {
    Banner, DataTable, TableDensity, KeyActivatedButton, KeyValueGrid, ObservedPanel, PageHeader, ScreenHost, Section,
} from './kit/index.js'
import type { ScreenHostInputs, KeyValueItem, TableColumn } from './kit/index.js'

// Hive detail: optional connection banner, the home channel summary, and the environments observed from
// the last check-in (read-only, inside an ObservedPanel). The view-model arrives already loaded.
export class HiveDetailView extends StackPanel
{
    private static readonly BackText = 'Back to hives'
    private static readonly BreadcrumbRoot = 'Hives'
    private static readonly HomeChannelTitle = 'Home channel'
    private static readonly ObservedTitle = 'Observed environments'
    private static readonly HistoryTitle = 'Observed history'
    private static readonly HistoryEmptyText = 'No observations recorded yet.'
    private static readonly LedgerTitle = 'Version history'
    private static readonly PolicyTitle = 'Release policy'
    private static readonly PolicyChannelsKey = 'Channels'
    private static readonly PolicyMinVersionKey = 'Minimum version'
    private static readonly PolicyHoldKey = 'Hold'
    private static readonly LedgerEmptyText = 'No version changes recorded yet.'
    private static readonly ActionKey = 'action'
    private static readonly VersionKey = 'version'
    private static readonly ActionHeader = 'Action'
    private static readonly VersionHeader = 'Version'
    private static readonly WhenKey = 'when'
    private static readonly SummaryKey = 'summary'
    private static readonly WhenHeader = 'When'
    private static readonly SummaryHeader = 'Summary'

    private readonly vm: HiveDetailViewModel
    private readonly onBack: () => void
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private tableSlot = new StackPanel()
    private historySlot = new StackPanel()
    private ledgerSlot = new StackPanel()

    public constructor(vm: HiveDetailViewModel, onBack: () => void)
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
    public get EnvTable(): DataTable<ObservedEnvRow> | undefined
    {
        const child = [...this.tableSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<ObservedEnvRow> : undefined
    }

    // Test seam: the currently shown version-history table.
    public get LedgerTable(): DataTable<LedgerRow> | undefined
    {
        const child = [...this.ledgerSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<LedgerRow> : undefined
    }

    // Test seam: the currently shown observed-history table.
    public get HistoryTable(): DataTable<ObservationHistoryRow> | undefined
    {
        const child = [...this.historySlot.Children][0]
        return child instanceof DataTable ? child as DataTable<ObservationHistoryRow> : undefined
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
            breadcrumb: [HiveDetailView.BreadcrumbRoot, this.vm.Hive.displayName],
            title: this.vm.Hive.displayName,
        }))
        if (this.vm.Banner.show)
        {
            root.AddChild(new Banner({ tone: this.vm.Banner.tone, text: this.vm.Banner.text }))
        }
        root.AddChild(new Section({
            title: HiveDetailView.HomeChannelTitle,
            body: new KeyValueGrid({ items: [...this.vm.HomeChannel] }),
        }))
        root.AddChild(new Section({ title: HiveDetailView.PolicyTitle, body: new KeyValueGrid({ items: this.BuildPolicyItems() }) }))
        this.tableSlot = new StackPanel()
        this.tableSlot.Orientation = Orientation.Vertical
        root.AddChild(new ObservedPanel({ title: HiveDetailView.ObservedTitle, body: this.tableSlot }))
        this.tableSlot.AddChild(ObservedEnvTable.Build([...this.vm.EnvRows]))
        this.historySlot = new StackPanel()
        this.historySlot.Orientation = Orientation.Vertical
        this.historySlot.AddChild(this.BuildHistoryTable())
        root.AddChild(new Section({ title: HiveDetailView.HistoryTitle, body: this.historySlot }))
        this.ledgerSlot = new StackPanel()
        this.ledgerSlot.Orientation = Orientation.Vertical
        this.ledgerSlot.AddChild(this.BuildLedgerTable())
        root.AddChild(new Section({ title: HiveDetailView.LedgerTitle, body: this.ledgerSlot }))
        return root
    }

    private BuildPolicyItems(): KeyValueItem[]
    {
        const policy = this.vm.HivePolicy
        return [
            { key: HiveDetailView.PolicyChannelsKey, value: policy.channelsLabel },
            { key: HiveDetailView.PolicyMinVersionKey, value: policy.minVersionLabel },
            { key: HiveDetailView.PolicyHoldKey, value: policy.heldLabel },
        ]
    }

    private BuildHistoryTable(): DataTable<ObservationHistoryRow>
    {
        const columns: TableColumn<ObservationHistoryRow>[] = [
            { key: HiveDetailView.WhenKey, header: HiveDetailView.WhenHeader, cell: r => r.whenLabel },
            { key: HiveDetailView.SummaryKey, header: HiveDetailView.SummaryHeader, cell: r => r.summaryLabel },
        ]
        return new DataTable<ObservationHistoryRow>({
            columns,
            rows: [...this.vm.ObservationHistory],
            density: TableDensity.Dense,
            emptyText: HiveDetailView.HistoryEmptyText,
        })
    }

    private BuildLedgerTable(): DataTable<LedgerRow>
    {
        const columns: TableColumn<LedgerRow>[] = [
            { key: HiveDetailView.WhenKey, header: HiveDetailView.WhenHeader, cell: r => r.whenLabel },
            { key: HiveDetailView.ActionKey, header: HiveDetailView.ActionHeader, cell: r => r.actionLabel },
            { key: HiveDetailView.VersionKey, header: HiveDetailView.VersionHeader, cell: r => r.version },
        ]
        return new DataTable<LedgerRow>({
            columns,
            rows: [...this.vm.LedgerHistory],
            density: TableDensity.Dense,
            emptyText: HiveDetailView.LedgerEmptyText,
        })
    }

    private BuildBack(): Visual
    {
        const button = new KeyActivatedButton(() => this.onBack())
        const text = new TextBlock()
        text.Text = HiveDetailView.BackText
        button.Content = text
        return button
    }
}
