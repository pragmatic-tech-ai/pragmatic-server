import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
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
    private static readonly ReasonPlaceholder = 'Why are you withdrawing this version?'
    private static readonly ConsequenceText = 'Environments listed below keep running this version until their tenant adopts another.'
    private static readonly ConfirmLabel = 'Confirm withdraw'
    private static readonly CancelLabel = 'Cancel'
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
    private readonly onToggleWithdrawn: (withdraw: boolean, reason?: string) => Promise<void>
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private withdrawAction: Act | undefined
    private errorText: TextBlock | undefined
    // View-local state of the inline reason sub-panel; fresh visuals per build.
    private reasonOpen = false
    private reasonBox: TextBox | undefined
    private confirmAction: Act | undefined
    private cancelButton: KeyActivatedButton | undefined
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private tableSlot = new StackPanel()

    public constructor(
        vm: ReleaseDetailViewModel,
        onBack: () => void,
        operator: OperatorContext,
        onToggleWithdrawn: (withdraw: boolean, reason?: string) => Promise<void>,
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

    // Test seam: whether the inline reason panel is showing.
    public get ReasonPanelOpen(): boolean
    {
        return this.reasonOpen
    }

    // Test seam: the reason input (only while the panel is open).
    public get ReasonBox(): TextBox | undefined
    {
        return this.reasonBox
    }

    // Test seam: the confirm-withdraw action (only while the panel is open).
    public get ConfirmAction(): Act | undefined
    {
        return this.confirmAction
    }

    // Test seam: the cancel button of the reason panel (only while open).
    public get CancelButton(): KeyActivatedButton | undefined
    {
        return this.cancelButton
    }

    private SetReasonOpen(open: boolean): void
    {
        this.reasonOpen = open
        this.host.Update(this.Inputs())
    }

    private async Confirm(): Promise<void>
    {
        const reason = (this.reasonBox?.Text ?? ReleaseDetailView.BlankText).trim()
        if (reason.length === 0)
        {
            return
        }
        this.reasonOpen = false
        await this.Toggle(true, reason)
    }

    private BuildReasonPanel(): Visual
    {
        const box = new TextBox()
        box.Placeholder = ReleaseDetailView.ReasonPlaceholder
        this.reasonBox = box
        const consequence = new TextBlock()
        consequence.Text = ReleaseDetailView.ConsequenceText
        const confirm = new Act(this.operator.MutatingAct(
            ReleaseDetailView.ConfirmLabel,
            () => void this.Confirm(),
            ActVariant.Danger,
        ))
        this.confirmAction = confirm
        const cancel = new KeyActivatedButton(() => this.SetReasonOpen(false))
        const cancelText = new TextBlock()
        cancelText.Text = ReleaseDetailView.CancelLabel
        cancel.Content = cancelText
        this.cancelButton = cancel
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        body.AddChild(box)
        body.AddChild(consequence)
        body.AddChild(confirm)
        body.AddChild(cancel)
        return body
    }

    private async Toggle(withdraw: boolean, reason?: string): Promise<void>
    {
        if (this.errorText !== undefined)
        {
            this.errorText.Text = ReleaseDetailView.BlankText
        }
        try
        {
            await this.onToggleWithdrawn(withdraw, reason)
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
            () => (withdrawn ? void this.Toggle(false) : this.SetReasonOpen(true)),
            withdrawn ? ActVariant.Secondary : ActVariant.Danger,
        ))
        root.AddChild(this.withdrawAction)
        this.reasonBox = undefined
        this.confirmAction = undefined
        this.cancelButton = undefined
        if (this.reasonOpen && !withdrawn)
        {
            root.AddChild(this.BuildReasonPanel())
        }
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
