import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ReleaseAdoptionRow, ReleaseDetailViewModel } from './release-detail-view-model.js'
import { OperatorContext } from './operator-context.js'
import {
    Act, ActVariant, Banner, DataTable, KeyActivatedButton, KeyValueGrid, ObservedPanel, PageHeader, PillKind, PillKinds, PillTone,
    ScreenHost, Section, StatusPill, TableDensity,
} from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'

// Release detail: optional withdrawn banner, the release profile, and the environments observed running
// this version (read-only, inside an ObservedPanel). The view-model arrives already derived.
export class ReleaseDetailView extends StackPanel
{
    private static readonly BackText = 'Back to releases'
    private static readonly BreadcrumbRoot = 'Registry & Releases'
    private static readonly ReleaseTitle = 'Release'
    private static readonly WhereTitle = 'Where it runs'
    private static readonly EmptyText = 'No running environment observed on this version.'
    private static readonly WithdrawLabel = 'Withdraw version'
    private static readonly RestoreLabel = 'Restore version'
    private static readonly FailedText = 'Could not change the version state. Please try again.'
    private static readonly BlankText = ''
    private static readonly HiveKey = 'hive'
    private static readonly OwnerKey = 'owner'
    private static readonly EnvKey = 'environment'
    private static readonly StatusKey = 'status'
    private static readonly HiveHeader = 'Hive'
    private static readonly OwnerHeader = 'Client / tenant'
    private static readonly EnvHeader = 'Environment'
    private static readonly StatusHeader = 'Status'

    private readonly vm: ReleaseDetailViewModel
    private readonly onBack: () => void
    private readonly operator: OperatorContext
    private readonly onToggleWithdrawn: (withdraw: boolean) => Promise<void>
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private withdrawAction: Act | undefined
    private errorText: TextBlock | undefined
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private tableSlot = new StackPanel()

    public constructor(
        vm: ReleaseDetailViewModel,
        onBack: () => void,
        operator: OperatorContext,
        onToggleWithdrawn: (withdraw: boolean) => Promise<void>,
    )
    {
        super()
        this.vm = vm
        this.onBack = onBack
        this.operator = operator
        this.onToggleWithdrawn = onToggleWithdrawn
        this.Orientation = Orientation.Vertical
        this.host = new ScreenHost(this.Inputs())
        this.AddChild(this.host)
    }

    // Test seam: the body host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the currently shown adoption table.
    public get AdoptionTable(): DataTable<ReleaseAdoptionRow> | undefined
    {
        const child = [...this.tableSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<ReleaseAdoptionRow> : undefined
    }

    // Test seam: the withdraw / restore action.
    public get WithdrawAction(): Act | undefined
    {
        return this.withdrawAction
    }

    // Test seam: the current action error line.
    public get ErrorLine(): string
    {
        return this.errorText?.Text ?? ReleaseDetailView.BlankText
    }

    private async Toggle(): Promise<void>
    {
        if (this.errorText !== undefined)
        {
            this.errorText.Text = ReleaseDetailView.BlankText
        }
        try
        {
            await this.onToggleWithdrawn(!this.vm.Withdrawn)
        }
        catch
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = ReleaseDetailView.FailedText
            }
        }
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
            breadcrumb: [ReleaseDetailView.BreadcrumbRoot, this.vm.Version],
            title: this.vm.Version,
        }))
        const pills = new StackPanel()
        pills.Orientation = Orientation.Horizontal
        pills.AddChild(new StatusPill(this.vm.ChannelPill))
        pills.AddChild(new StatusPill(this.vm.SignedPill))
        root.AddChild(pills)
        const banner = this.vm.WithdrawnBanner
        if (banner.show)
        {
            root.AddChild(new Banner({ tone: banner.tone, text: banner.text }))
        }
        const withdrawn = this.vm.Withdrawn
        this.withdrawAction = new Act(this.operator.MutatingAct(
            withdrawn ? ReleaseDetailView.RestoreLabel : ReleaseDetailView.WithdrawLabel,
            () => void this.Toggle(),
            withdrawn ? ActVariant.Secondary : ActVariant.Danger,
        ))
        root.AddChild(this.withdrawAction)
        this.errorText = new TextBlock()
        this.errorText.Text = ReleaseDetailView.BlankText
        root.AddChild(this.errorText)
        root.AddChild(new Section({
            title: ReleaseDetailView.ReleaseTitle,
            body: new KeyValueGrid({ items: [...this.vm.Profile] }),
        }))
        this.tableSlot = new StackPanel()
        this.tableSlot.Orientation = Orientation.Vertical
        root.AddChild(new ObservedPanel({ title: ReleaseDetailView.WhereTitle, body: this.tableSlot }))
        this.tableSlot.AddChild(this.BuildTable())
        return root
    }

    private BuildTable(): DataTable<ReleaseAdoptionRow>
    {
        return new DataTable<ReleaseAdoptionRow>({
            columns: ReleaseDetailView.Columns(),
            rows: [...this.vm.AdoptionRows],
            density: TableDensity.Dense,
            searchText: r => r.envName,
            emptyText: ReleaseDetailView.EmptyText,
        })
    }

    private static Columns(): TableColumn<ReleaseAdoptionRow>[]
    {
        return [
            { key: ReleaseDetailView.HiveKey, header: ReleaseDetailView.HiveHeader, cell: r => r.hiveName },
            { key: ReleaseDetailView.OwnerKey, header: ReleaseDetailView.OwnerHeader, cell: r => r.ownerLabel },
            {
                key: ReleaseDetailView.EnvKey,
                header: ReleaseDetailView.EnvHeader,
                cell: r => r.envName,
                sort: (a, b) => a.envName.localeCompare(b.envName),
            },
            {
                key: ReleaseDetailView.StatusKey,
                header: ReleaseDetailView.StatusHeader,
                cell: r => PillKinds.For(r.ready ? PillKind.Healthy : PillKind.Failing).label,
                tone: r => r.ready ? undefined : PillTone.Danger,
            },
        ]
    }

    private BuildBack(): Visual
    {
        const button = new KeyActivatedButton(() => this.onBack())
        const text = new TextBlock()
        text.Text = ReleaseDetailView.BackText
        button.Content = text
        return button
    }
}
