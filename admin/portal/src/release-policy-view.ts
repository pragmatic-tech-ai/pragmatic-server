import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { Act, ActVariant, Banner, BannerTone, DataTable, KeyActivatedButton, PageHeader, ScreenHost, Section, TableDensity } from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'
import type { OperatorContext } from './operator-context.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'
import { ReleasePolicyViewModel } from './release-policy-view-model.js'
import type { GatedRow, PolicyRow, RolloutRow, TargetRow } from './release-policy-view-model.js'
import { ReleaseChannel } from './release-channel.js'

export enum GatingMode
{
    Normal,
    Gate,
    Ungate,
    SetChannels,
    SetMinVersion,
    Hold,
}

// Release policy: the current gating allowlist, per-hive target selections, and the actual rollout status per environment. Full operators can gate or ungate a version for a tenant.
export class ReleasePolicyView extends StackPanel implements IPortalView
{
    private static readonly Breadcrumb: readonly string[] = ['Releases', 'Release Policy']
    private static readonly TitleText = 'Release Policy'
    private static readonly CurrentModelNote = 'This is the current gating and selection model: the versions each tenant may adopt, the target each hive is set to, and the actual rollout status reported by each environment. Per-tenant policy is live: set a tenant subscribed channels, a minimum-version floor, or a hold, and blocked tags show why a gated version cannot be adopted. The adoption ledger is still pending.'
    private static readonly GatedTitle = 'Gated versions'
    private static readonly TargetsTitle = 'Selected targets'
    private static readonly RolloutTitle = 'Rollout status'
    private static readonly PolicyTitle = 'Tenant policy'
    private static readonly PolicyEmptyText = 'No tenant has a policy set yet.'
    private static readonly ChannelsKey = 'channels'
    private static readonly FloorKey = 'floor'
    private static readonly HeldKey = 'held'
    private static readonly BlockedKey = 'blocked'
    private static readonly ChannelsHeader = 'Channels'
    private static readonly FloorHeader = 'Minimum version'
    private static readonly HeldHeader = 'Hold'
    private static readonly BlockedHeader = 'Blocked'
    private static readonly HoldSeparator = ': '
    private static readonly SetChannelsLabel = 'Set channels'
    private static readonly SetMinVersionLabel = 'Set floor'
    private static readonly HoldLabel = 'Hold'
    private static readonly SetChannelsFormTitle = 'Set the subscribed channels of a tenant'
    private static readonly SetMinVersionFormTitle = 'Set or clear the minimum version of a tenant'
    private static readonly HoldFormTitle = 'Hold or release a tenant'
    private static readonly ApplyLabel = 'Apply'
    private static readonly ClearLabel = 'Clear'
    private static readonly ReleaseLabel = 'Release'
    private static readonly SelectedPrefix = '[x] '
    private static readonly UnselectedPrefix = '[ ] '
    private static readonly ReasonPlaceholder = 'Reason'
    private static readonly TenantRequiredText = 'Tenant id is required.'
    private static readonly ChannelRequiredText = 'Tenant id and at least one channel are required.'
    private static readonly VersionRequiredText = 'Tenant id and version are required.'
    private static readonly ReasonRequiredText = 'Tenant id and reason are required.'
    private static readonly EnvKey = 'env'
    private static readonly RunningKey = 'running'
    private static readonly StatusKey = 'status'
    private static readonly EnvHeader = 'Environment'
    private static readonly RunningHeader = 'Running'
    private static readonly StatusHeader = 'Status'
    private static readonly RolloutEmptyText = 'No rollout information yet.'
    private static readonly OwnerKey = 'owner'
    private static readonly VersionKey = 'version'
    private static readonly GatedKey = 'gated'
    private static readonly HiveKey = 'hive'
    private static readonly TargetKey = 'target'
    private static readonly SelectedKey = 'selected'
    private static readonly OwnerHeader = 'Client / tenant'
    private static readonly VersionHeader = 'Version'
    private static readonly GatedHeader = 'Gated'
    private static readonly HiveHeader = 'Hive'
    private static readonly TargetHeader = 'Target version'
    private static readonly SelectedHeader = 'Selected'
    private static readonly SearchSeparator = ' '
    private static readonly GatedEmptyText = 'No versions are gated yet.'
    private static readonly TargetsEmptyText = 'No hive has a target selected yet.'
    private static readonly EmptyTitle = 'No release policy yet. Gated versions, hive targets, and rollout status appear here once set.'
    private static readonly ErrorTitle = 'Could not load the release policy.'
    private static readonly GateLabel = 'Gate version'
    private static readonly UngateLabel = 'Ungate version'
    private static readonly GateFormTitle = 'Gate a version for a tenant'
    private static readonly UngateFormTitle = 'Ungate a version for a tenant'
    private static readonly GateSubmitLabel = 'Gate'
    private static readonly UngateSubmitLabel = 'Ungate'
    private static readonly CancelLabel = 'Cancel'
    private static readonly TenantPlaceholder = 'Tenant id'
    private static readonly VersionPlaceholder = 'Version'
    private static readonly BlankText = ''
    private static readonly RequiredText = 'Tenant id and version are required.'
    private static readonly FailedText = 'The change could not be saved. Check the values and try again.'

    private readonly client: ControlPlaneClient
    private readonly operator: OperatorContext
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent, so reusing slots across
    // renders would double-parent them and throw on a second Refresh.
    private gatedSlot = new StackPanel()
    private targetSlot = new StackPanel()
    private rolloutSlot = new StackPanel()
    private formSlot = new StackPanel()
    private policySlot = new StackPanel()
    private pendingChannels = new Set<string>()
    private mode = GatingMode.Normal
    private errorText: TextBlock | undefined
    private model: ReleasePolicyViewModel | undefined
    private nav: IPortalNavigator | undefined

    public constructor(client: ControlPlaneClient, operator: OperatorContext)
    {
        super()
        this.client = client
        this.operator = operator
        this.Orientation = Orientation.Vertical
        this.host = new ScreenHost(this.Inputs(true, false, true))
        this.AddChild(this.host)
    }

    // Test seam: the body host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the attached navigator.
    public get Navigator(): IPortalNavigator | undefined
    {
        return this.nav
    }

    // Test seam: the current gating mode.
    public get Mode(): GatingMode
    {
        return this.mode
    }

    // Test seam: the open gating form's error line.
    public get ErrorLine(): string
    {
        return this.errorText?.Text ?? ReleasePolicyView.BlankText
    }

    // Test seam: tests drive mode changes directly. Re-renders from the held model with no network fetch.
    public EnterMode(mode: GatingMode): void
    {
        this.mode = mode
        this.pendingChannels = new Set<string>()
        if (this.model !== undefined)
        {
            this.ShowModel(this.model)
        }
    }

    // Test seam: the currently shown gated-versions table (populated state only).
    public get GatedTable(): DataTable<GatedRow> | undefined
    {
        const child = [...this.gatedSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<GatedRow> : undefined
    }

    // Test seam: the currently shown rollout-status table (populated state only).
    public get RolloutTable(): DataTable<RolloutRow> | undefined
    {
        const child = [...this.rolloutSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<RolloutRow> : undefined
    }

    // Test seam: the currently shown selected-targets table (populated state only).
    public get TargetTable(): DataTable<TargetRow> | undefined
    {
        const child = [...this.targetSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<TargetRow> : undefined
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
        // An open gating form is left untouched: rebuilding it would discard what the operator is typing.
        if (this.mode !== GatingMode.Normal && this.model !== undefined)
        {
            return
        }
        if (this.model === undefined)
        {
            this.host.Update(this.Inputs(true, false, true))
        }
        try
        {
            const [gating, selections, tenants, clients, fleet, rollouts, policies, manifests] = await Promise.all([
                this.client.ListGating(),
                this.client.ListSelections(),
                this.client.ListTenants(),
                this.client.ListClients(),
                this.client.ListFleet(),
                this.client.ListRollouts(),
                this.client.ListPolicies(),
                this.client.ListManifests(),
            ])
            if (this.model === undefined)
            {
                this.model = new ReleasePolicyViewModel(gating, selections, tenants, clients, fleet, rollouts, policies, manifests)
            }
            else
            {
                this.model.Update(gating, selections, tenants, clients, fleet, rollouts, policies, manifests)
            }
        }
        catch
        {
            this.ClearSlots()
            this.host.Update(this.Inputs(false, true, true))
            return
        }
        this.ShowModel(this.model)
    }

    private Inputs(loading: boolean, error: boolean, isEmpty: boolean, content?: () => Visual): ScreenHostInputs
    {
        return {
            loading,
            allowed: true,
            error,
            isEmpty,
            empty: { title: ReleasePolicyView.EmptyTitle },
            errorConfig: { title: ReleasePolicyView.ErrorTitle, onRetry: () => void this.Refresh() },
            content,
        }
    }

    private ClearSlots(): void
    {
        this.gatedSlot = new StackPanel()
        this.targetSlot = new StackPanel()
        this.rolloutSlot = new StackPanel()
        this.formSlot = new StackPanel()
        this.policySlot = new StackPanel()
        this.errorText = undefined
        this.mode = GatingMode.Normal
    }

    private ShowModel(model: ReleasePolicyViewModel): void
    {
        const isEmpty = model.GatedRows.length === 0 && model.TargetRows.length === 0
            && model.RolloutRows.length === 0 && model.PolicyRows.length === 0 && !this.operator.CanMutate
        if (isEmpty)
        {
            this.ClearSlots()
        }
        this.host.Update(this.Inputs(false, false, isEmpty, () => this.BuildContent(model)))
    }

    private BuildContent(model: ReleasePolicyViewModel): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: ReleasePolicyView.Breadcrumb, title: ReleasePolicyView.TitleText }))
        root.AddChild(new Banner({ tone: BannerTone.Info, text: ReleasePolicyView.CurrentModelNote }))
        // Fresh slots per render: the previous ones are still parented to the previous Sections.
        this.gatedSlot = new StackPanel()
        this.gatedSlot.Orientation = Orientation.Vertical
        this.gatedSlot.AddChild(new DataTable<GatedRow>({
            columns: ReleasePolicyView.GatedColumns(),
            rows: model.GatedRows,
            density: TableDensity.Dense,
            searchText: r => r.ownerLabel + ReleasePolicyView.SearchSeparator + r.version,
            emptyText: ReleasePolicyView.GatedEmptyText,
        }))
        this.policySlot = new StackPanel()
        this.policySlot.Orientation = Orientation.Vertical
        this.policySlot.AddChild(new DataTable<PolicyRow>({
            columns: ReleasePolicyView.PolicyColumns(),
            rows: model.PolicyRows,
            density: TableDensity.Dense,
            searchText: r => r.ownerLabel + ReleasePolicyView.SearchSeparator + r.channelsLabel,
            emptyText: ReleasePolicyView.PolicyEmptyText,
        }))
        this.targetSlot = new StackPanel()
        this.targetSlot.Orientation = Orientation.Vertical
        this.targetSlot.AddChild(new DataTable<TargetRow>({
            columns: ReleasePolicyView.TargetColumns(),
            rows: model.TargetRows,
            density: TableDensity.Dense,
            searchText: r => r.hiveName + ReleasePolicyView.SearchSeparator + r.ownerLabel
                + ReleasePolicyView.SearchSeparator + r.targetVersion,
            emptyText: ReleasePolicyView.TargetsEmptyText,
        }))
        this.rolloutSlot = new StackPanel()
        this.rolloutSlot.Orientation = Orientation.Vertical
        this.rolloutSlot.AddChild(new DataTable<RolloutRow>({
            columns: ReleasePolicyView.RolloutColumns(),
            rows: model.RolloutRows,
            density: TableDensity.Dense,
            searchText: r => r.hiveName + ReleasePolicyView.SearchSeparator + r.ownerLabel
                + ReleasePolicyView.SearchSeparator + r.envName + ReleasePolicyView.SearchSeparator + r.targetLabel
                + ReleasePolicyView.SearchSeparator + r.runningLabel + ReleasePolicyView.SearchSeparator + r.statusLabel,
            emptyText: ReleasePolicyView.RolloutEmptyText,
        }))
        root.AddChild(new Section({ title: ReleasePolicyView.GatedTitle, body: this.gatedSlot }))
        root.AddChild(new Section({ title: ReleasePolicyView.PolicyTitle, body: this.policySlot }))
        root.AddChild(new Section({ title: ReleasePolicyView.TargetsTitle, body: this.targetSlot }))
        root.AddChild(new Section({ title: ReleasePolicyView.RolloutTitle, body: this.rolloutSlot }))
        const actions = new StackPanel()
        actions.Orientation = Orientation.Horizontal
        actions.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.GateLabel, () => this.EnterMode(GatingMode.Gate))))
        actions.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.UngateLabel, () => this.EnterMode(GatingMode.Ungate), ActVariant.Danger)))
        actions.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.SetChannelsLabel, () => this.EnterMode(GatingMode.SetChannels))))
        actions.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.SetMinVersionLabel, () => this.EnterMode(GatingMode.SetMinVersion))))
        actions.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.HoldLabel, () => this.EnterMode(GatingMode.Hold), ActVariant.Danger)))
        root.AddChild(actions)
        // A Refresh() while the form is open is skipped (see Refresh), so the live fields keep their typed input.
        this.formSlot = new StackPanel()
        this.formSlot.Orientation = Orientation.Vertical
        this.errorText = undefined
        if (this.mode !== GatingMode.Normal)
        {
            const gate = this.mode === GatingMode.Gate
            const policyForm = this.mode === GatingMode.SetChannels || this.mode === GatingMode.SetMinVersion
                || this.mode === GatingMode.Hold
            this.formSlot.AddChild(policyForm ? this.BuildPolicyForm() : this.BuildGatingForm(gate))
            root.AddChild(new Section({
                title: this.FormTitle(gate),
                body: this.formSlot,
            }))
        }
        return root
    }

    private FormTitle(gate: boolean): string
    {
        switch (this.mode)
        {
            case GatingMode.SetChannels:
                return ReleasePolicyView.SetChannelsFormTitle
            case GatingMode.SetMinVersion:
                return ReleasePolicyView.SetMinVersionFormTitle
            case GatingMode.Hold:
                return ReleasePolicyView.HoldFormTitle
            default:
                return gate ? ReleasePolicyView.GateFormTitle : ReleasePolicyView.UngateFormTitle
        }
    }

    // Inline policy forms: tenant id + mode-specific inputs, apply/clear actions and cancel.
    private BuildPolicyForm(): Visual
    {
        const tenantBox = ReleasePolicyView.Box(ReleasePolicyView.TenantPlaceholder)
        const errorText = new TextBlock()
        this.errorText = errorText
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        body.AddChild(tenantBox)
        if (this.mode === GatingMode.SetChannels)
        {
            for (const channel of [ReleaseChannel.Stable, ReleaseChannel.Early])
            {
                body.AddChild(this.ChannelToggle(channel))
            }
            body.AddChild(errorText)
            body.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.ApplyLabel, () => void this.ApplyPolicy(
                tenantBox.Text, this.pendingChannels.size > 0, ReleasePolicyView.ChannelRequiredText,
                t => this.client.SetTenantChannels(t, [...this.pendingChannels])), ActVariant.Primary)))
        }
        else if (this.mode === GatingMode.SetMinVersion)
        {
            const versionBox = ReleasePolicyView.Box(ReleasePolicyView.VersionPlaceholder)
            body.AddChild(versionBox)
            body.AddChild(errorText)
            body.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.ApplyLabel, () => void this.ApplyPolicy(
                tenantBox.Text, versionBox.Text.trim() !== ReleasePolicyView.BlankText, ReleasePolicyView.VersionRequiredText,
                t => this.client.SetTenantMinVersion(t, versionBox.Text.trim())), ActVariant.Primary)))
            body.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.ClearLabel, () => void this.ApplyPolicy(
                tenantBox.Text, true, ReleasePolicyView.TenantRequiredText,
                t => this.client.ClearTenantMinVersion(t)))))
        }
        else
        {
            const reasonBox = ReleasePolicyView.Box(ReleasePolicyView.ReasonPlaceholder)
            body.AddChild(reasonBox)
            body.AddChild(errorText)
            body.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.HoldLabel, () => void this.ApplyPolicy(
                tenantBox.Text, reasonBox.Text.trim() !== ReleasePolicyView.BlankText, ReleasePolicyView.ReasonRequiredText,
                t => this.client.SetTenantHold(t, reasonBox.Text.trim())), ActVariant.Danger)))
            body.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.ReleaseLabel, () => void this.ApplyPolicy(
                tenantBox.Text, true, ReleasePolicyView.TenantRequiredText,
                t => this.client.ClearTenantHold(t)))))
        }
        const cancel = new KeyActivatedButton(() => this.EnterMode(GatingMode.Normal))
        const cancelText = new TextBlock()
        cancelText.Text = ReleasePolicyView.CancelLabel
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
            label.Text = (this.pendingChannels.has(channel) ? ReleasePolicyView.SelectedPrefix : ReleasePolicyView.UnselectedPrefix) + channel
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

    private async ApplyPolicy(tenantId: string, valid: boolean, requiredText: string, call: (tenant: string) => Promise<unknown>): Promise<void>
    {
        if (this.errorText !== undefined)
        {
            this.errorText.Text = ReleasePolicyView.BlankText
        }
        const tenant = tenantId.trim()
        if (tenant === ReleasePolicyView.BlankText || !valid)
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = requiredText
            }
            return
        }
        try
        {
            await call(tenant)
        }
        catch
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = ReleasePolicyView.FailedText
            }
            return
        }
        this.mode = GatingMode.Normal
        await this.Refresh()
    }

    // One form for both modes: tenant + version + submit + cancel + error line.
    private BuildGatingForm(gate: boolean): Visual
    {
        const tenantBox = ReleasePolicyView.Box(ReleasePolicyView.TenantPlaceholder)
        const versionBox = ReleasePolicyView.Box(ReleasePolicyView.VersionPlaceholder)
        const errorText = new TextBlock()
        this.errorText = errorText
        const submit = new Act(this.operator.MutatingAct(
            gate ? ReleasePolicyView.GateSubmitLabel : ReleasePolicyView.UngateSubmitLabel,
            () => void this.Submit(tenantBox.Text, versionBox.Text),
            gate ? ActVariant.Primary : ActVariant.Danger,
        ))
        const cancel = new KeyActivatedButton(() => this.EnterMode(GatingMode.Normal))
        const cancelText = new TextBlock()
        cancelText.Text = ReleasePolicyView.CancelLabel
        cancel.Content = cancelText
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        body.AddChild(tenantBox)
        body.AddChild(versionBox)
        body.AddChild(errorText)
        body.AddChild(submit)
        body.AddChild(cancel)
        return body
    }

    private static Box(placeholder: string): TextBox
    {
        const box = new TextBox()
        box.Placeholder = placeholder
        return box
    }

    private async Submit(tenantId: string, version: string): Promise<void>
    {
        if (this.errorText !== undefined)
        {
            this.errorText.Text = ReleasePolicyView.BlankText
        }
        const tenant = tenantId.trim()
        const ver = version.trim()
        if (tenant === ReleasePolicyView.BlankText || ver === ReleasePolicyView.BlankText)
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = ReleasePolicyView.RequiredText
            }
            return
        }
        try
        {
            if (this.mode === GatingMode.Gate)
            {
                await this.client.Gate(tenant, ver)
            }
            else
            {
                await this.client.Ungate(tenant, ver)
            }
        }
        catch
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = ReleasePolicyView.FailedText
            }
            return
        }
        this.mode = GatingMode.Normal
        await this.Refresh()
    }

    private static GatedColumns(): TableColumn<GatedRow>[]
    {
        return [
            { key: ReleasePolicyView.OwnerKey, header: ReleasePolicyView.OwnerHeader, cell: r => r.ownerLabel },
            { key: ReleasePolicyView.VersionKey, header: ReleasePolicyView.VersionHeader, cell: r => r.version },
            { key: ReleasePolicyView.GatedKey, header: ReleasePolicyView.GatedHeader, cell: r => r.gatedLabel },
            { key: ReleasePolicyView.BlockedKey, header: ReleasePolicyView.BlockedHeader, cell: r => r.blockedLabel ?? ReleasePolicyView.BlankText },
        ]
    }

    private static PolicyColumns(): TableColumn<PolicyRow>[]
    {
        return [
            { key: ReleasePolicyView.OwnerKey, header: ReleasePolicyView.OwnerHeader, cell: r => r.ownerLabel },
            { key: ReleasePolicyView.ChannelsKey, header: ReleasePolicyView.ChannelsHeader, cell: r => r.channelsLabel },
            { key: ReleasePolicyView.FloorKey, header: ReleasePolicyView.FloorHeader, cell: r => r.minVersionLabel },
            { key: ReleasePolicyView.HeldKey, header: ReleasePolicyView.HeldHeader, cell: r => r.held ? r.heldLabel + ReleasePolicyView.HoldSeparator + r.holdReason : r.heldLabel },
        ]
    }

    private static TargetColumns(): TableColumn<TargetRow>[]
    {
        return [
            { key: ReleasePolicyView.HiveKey, header: ReleasePolicyView.HiveHeader, cell: r => r.hiveName },
            { key: ReleasePolicyView.OwnerKey, header: ReleasePolicyView.OwnerHeader, cell: r => r.ownerLabel },
            { key: ReleasePolicyView.TargetKey, header: ReleasePolicyView.TargetHeader, cell: r => r.targetVersion },
            { key: ReleasePolicyView.SelectedKey, header: ReleasePolicyView.SelectedHeader, cell: r => r.selectedLabel },
        ]
    }

    private static RolloutColumns(): TableColumn<RolloutRow>[]
    {
        return [
            { key: ReleasePolicyView.HiveKey, header: ReleasePolicyView.HiveHeader, cell: r => r.hiveName, sort: (a, b) => a.hiveName.localeCompare(b.hiveName) },
            { key: ReleasePolicyView.OwnerKey, header: ReleasePolicyView.OwnerHeader, cell: r => r.ownerLabel },
            { key: ReleasePolicyView.EnvKey, header: ReleasePolicyView.EnvHeader, cell: r => r.envName },
            { key: ReleasePolicyView.TargetKey, header: ReleasePolicyView.TargetHeader, cell: r => r.targetLabel },
            { key: ReleasePolicyView.RunningKey, header: ReleasePolicyView.RunningHeader, cell: r => r.runningLabel },
            { key: ReleasePolicyView.StatusKey, header: ReleasePolicyView.StatusHeader, cell: r => r.statusLabel, tone: r => r.statusTone },
        ]
    }
}
