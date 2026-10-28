import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { HiveDetailViewModel } from './hive-detail-view-model.js'
import { ObservedEnvTable } from './observed-env-table.js'
import type { ObservedEnvRow } from './observed-env-table.js'
import {
    Banner, DataTable, KeyActivatedButton, KeyValueGrid, ObservedPanel, PageHeader, ScreenHost, Section,
} from './kit/index.js'
import type { ScreenHostInputs } from './kit/index.js'

// Hive detail: optional connection banner, the home channel summary, and the environments observed from
// the last check-in (read-only, inside an ObservedPanel). The view-model arrives already loaded.
export class HiveDetailView extends StackPanel
{
    private static readonly BackText = 'Back to hives'
    private static readonly BreadcrumbRoot = 'Hives'
    private static readonly HomeChannelTitle = 'Home channel'
    private static readonly ObservedTitle = 'Observed environments'

    private readonly vm: HiveDetailViewModel
    private readonly onBack: () => void
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private tableSlot = new StackPanel()

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
        this.tableSlot = new StackPanel()
        this.tableSlot.Orientation = Orientation.Vertical
        root.AddChild(new ObservedPanel({ title: HiveDetailView.ObservedTitle, body: this.tableSlot }))
        this.tableSlot.AddChild(ObservedEnvTable.Build([...this.vm.EnvRows]))
        return root
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
