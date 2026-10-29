import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import type { HiveDetailViewModel, LedgerRow, ObservationHistoryRow } from './hive-detail-view-model.js'
import { ObservedEnvTable } from './observed-env-table.js'
import type { ObservedEnvRow } from './observed-env-table.js'
import {
    Act, ActVariant, Banner, DataTable, TableDensity, KeyActivatedButton, KeyValueGrid, ObservedPanel, PageHeader, ScreenHost, Section,
} from './kit/index.js'
import type { ScreenHostInputs, KeyValueItem, TableColumn } from './kit/index.js'
import type { OperatorContext } from './operator-context.js'
import { ReleaseChannel } from './release-channel.js'

export enum HivePolicyMode
{
    Normal,
    SetChannels,
    SetMinVersion,
    Hold,
}

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
    private static readonly PolicyTitle = 'Per-hive policy'
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
    private static readonly SetChannelsLabel = 'Set channels'
    private static readonly SetMinVersionLabel = 'Set floor'
    private static readonly HoldLabel = 'Hold'
    private static readonly SetChannelsFormTitle = 'Set the subscribed channels of this hive'
    private static readonly SetMinVersionFormTitle = 'Set or clear the minimum version of this hive'
    private static readonly HoldFormTitle = 'Hold or release this hive'
    private static readonly ApplyLabel = 'Apply'
    private static readonly ClearLabel = 'Clear'
    private static readonly ReleaseLabel = 'Release'
    private static readonly CancelLabel = 'Cancel'
    private static readonly SelectedPrefix = '[x] '
    private static readonly UnselectedPrefix = '[ ] '
    private static readonly VersionPlaceholder = 'Version'
    private static readonly ReasonPlaceholder = 'Reason'
    private static readonly BlankText = ''
    private static readonly VersionRequiredText = 'Version is required.'
    private static readonly ReasonRequiredText = 'A reason is required.'
    private static readonly ChannelRequiredText = 'At least one channel is required.'
    private static readonly FailedText = 'The change could not be saved. Check the values and try again.'

    private readonly vm: HiveDetailViewModel
    private readonly onBack: () => void
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private readonly client: ControlPlaneClient | undefined
    private readonly operator: OperatorContext | undefined
    private readonly onPolicyChanged: (() => Promise<void>) | undefined
    private pendingChannels = new Set<string>()
    private mode = HivePolicyMode.Normal
    private errorText: TextBlock | undefined
    private tableSlot = new StackPanel()
    private historySlot = new StackPanel()
    private ledgerSlot = new StackPanel()

    public constructor(
        vm: HiveDetailViewModel,
        onBack: () => void,
        client?: ControlPlaneClient,
        operator?: OperatorContext,
        onPolicyChanged?: () => Promise<void>)
    {
        super()
        this.vm = vm
        this.onBack = onBack
        this.client = client
        this.operator = operator
        this.onPolicyChanged = onPolicyChanged
        this.Orientation = Orientation.Vertical
        this.host = new ScreenHost(this.Inputs())
        this.AddChild(this.host)
    }

    // Test seam: the body host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the current policy edit mode.
    public get Mode(): HivePolicyMode
    {
        return this.mode
    }

    // Test seam: the open policy form's error line.
    public get ErrorLine(): string
    {
        return this.errorText?.Text ?? HiveDetailView.BlankText
    }

    // Test seam: tests drive mode changes directly. Re-renders from the held view-model.
    public EnterMode(mode: HivePolicyMode): void
    {
        this.mode = mode
        this.pendingChannels = new Set<string>()
        this.host.Update(this.Inputs())
    }

    // Editing renders only when every dependency is injected.
    private get CanEdit(): boolean
    {
        return this.client !== undefined && this.operator !== undefined && this.onPolicyChanged !== undefined
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
        this.errorText = undefined
        if (this.CanEdit && this.operator !== undefined)
        {
            const actions = new StackPanel()
            actions.Orientation = Orientation.Horizontal
            actions.AddChild(new Act(this.operator.MutatingAct(HiveDetailView.SetChannelsLabel, () => this.EnterMode(HivePolicyMode.SetChannels))))
            actions.AddChild(new Act(this.operator.MutatingAct(HiveDetailView.SetMinVersionLabel, () => this.EnterMode(HivePolicyMode.SetMinVersion))))
            actions.AddChild(new Act(this.operator.MutatingAct(HiveDetailView.HoldLabel, () => this.EnterMode(HivePolicyMode.Hold), ActVariant.Danger)))
            root.AddChild(actions)
            if (this.mode !== HivePolicyMode.Normal)
            {
                root.AddChild(new Section({ title: this.FormTitle(), body: this.BuildPolicyForm(this.operator) }))
            }
        }
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

    private FormTitle(): string
    {
        switch (this.mode)
        {
            case HivePolicyMode.SetChannels:
                return HiveDetailView.SetChannelsFormTitle
            case HivePolicyMode.SetMinVersion:
                return HiveDetailView.SetMinVersionFormTitle
            default:
                return HiveDetailView.HoldFormTitle
        }
    }

    // Inline policy forms: mode-specific inputs, apply/clear actions and cancel. The hive id is the page's hive.
    private BuildPolicyForm(operator: OperatorContext): Visual
    {
        const client = this.client as ControlPlaneClient
        const errorText = new TextBlock()
        this.errorText = errorText
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        if (this.mode === HivePolicyMode.SetChannels)
        {
            for (const channel of [ReleaseChannel.Stable, ReleaseChannel.Early])
            {
                body.AddChild(this.ChannelToggle(channel))
            }
            body.AddChild(errorText)
            body.AddChild(new Act(operator.MutatingAct(HiveDetailView.ApplyLabel, () => void this.ApplyPolicy(
                this.pendingChannels.size > 0, HiveDetailView.ChannelRequiredText,
                id => client.SetHiveChannels(id, [...this.pendingChannels])), ActVariant.Primary)))
        }
        else if (this.mode === HivePolicyMode.SetMinVersion)
        {
            const versionBox = HiveDetailView.Box(HiveDetailView.VersionPlaceholder)
            body.AddChild(versionBox)
            body.AddChild(errorText)
            body.AddChild(new Act(operator.MutatingAct(HiveDetailView.ApplyLabel, () => void this.ApplyPolicy(
                versionBox.Text.trim() !== HiveDetailView.BlankText, HiveDetailView.VersionRequiredText,
                id => client.SetHiveMinVersion(id, versionBox.Text.trim())), ActVariant.Primary)))
            body.AddChild(new Act(operator.MutatingAct(HiveDetailView.ClearLabel, () => void this.ApplyPolicy(
                true, HiveDetailView.VersionRequiredText,
                id => client.ClearHiveMinVersion(id)))))
        }
        else
        {
            const reasonBox = HiveDetailView.Box(HiveDetailView.ReasonPlaceholder)
            body.AddChild(reasonBox)
            body.AddChild(errorText)
            body.AddChild(new Act(operator.MutatingAct(HiveDetailView.HoldLabel, () => void this.ApplyPolicy(
                reasonBox.Text.trim() !== HiveDetailView.BlankText, HiveDetailView.ReasonRequiredText,
                id => client.SetHiveHold(id, reasonBox.Text.trim())), ActVariant.Danger)))
            body.AddChild(new Act(operator.MutatingAct(HiveDetailView.ReleaseLabel, () => void this.ApplyPolicy(
                true, HiveDetailView.ReasonRequiredText,
                id => client.ClearHiveHold(id)))))
        }
        const cancel = new KeyActivatedButton(() => this.EnterMode(HivePolicyMode.Normal))
        const cancelText = new TextBlock()
        cancelText.Text = HiveDetailView.CancelLabel
        cancel.Content = cancelText
        body.AddChild(cancel)
        return body
    }

    // A toggle that adds or removes the channel from the pending selection and reflects it in its label.
    private ChannelToggle(channel: string): KeyActivatedButton
    {
        const label = new TextBlock()
        const show = (): void =>
        {
            label.Text = (this.pendingChannels.has(channel) ? HiveDetailView.SelectedPrefix : HiveDetailView.UnselectedPrefix) + channel
        }
        const button = new KeyActivatedButton(() =>
        {
            if (this.pendingChannels.has(channel))
            {
                this.pendingChannels.delete(channel)
            }
            else
            {
                this.pendingChannels.add(channel)
            }
            show()
        })
        show()
        button.Content = label
        return button
    }

    private async ApplyPolicy(valid: boolean, requiredText: string, call: (hiveId: string) => Promise<unknown>): Promise<void>
    {
        if (this.errorText !== undefined)
        {
            this.errorText.Text = HiveDetailView.BlankText
        }
        if (!valid)
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = requiredText
            }
            return
        }
        try
        {
            await call(this.vm.Hive.id)
        }
        catch
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = HiveDetailView.FailedText
            }
            return
        }
        this.mode = HivePolicyMode.Normal
        await this.onPolicyChanged?.()
    }

    private static Box(placeholder: string): TextBox
    {
        const box = new TextBox()
        box.Placeholder = placeholder
        return box
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
