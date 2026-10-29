import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { Act, ActVariant, Banner, BannerTone, DataTable, KeyActivatedButton, PageHeader, ScreenHost, Section, TableDensity } from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'
import type { OperatorContext } from './operator-context.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'
import { ReleasePolicyViewModel } from './release-policy-view-model.js'
import type { GatedRow, RolloutRow, TargetRow } from './release-policy-view-model.js'

export enum GatingMode
{
    Normal,
    Gate,
    Ungate,
}

// Release policy: the current gating allowlist, per-hive target selections, and the actual rollout status per environment. Full operators can gate or ungate a version for a tenant.
export class ReleasePolicyView extends StackPanel implements IPortalView
{
    private static readonly Breadcrumb: readonly string[] = ['Releases', 'Release Policy']
    private static readonly TitleText = 'Release Policy'
    private static readonly CurrentModelNote = 'This is the current gating and selection model: the versions each tenant may adopt, the target each hive is set to, and the actual rollout status reported by each environment. Scoped rules, channels, minimum versions, holds, and the adoption ledger are not yet available.'
    private static readonly GatedTitle = 'Gated versions'
    private static readonly TargetsTitle = 'Selected targets'
    private static readonly RolloutTitle = 'Rollout status'
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
            const [gating, selections, tenants, clients, fleet, rollouts] = await Promise.all([
                this.client.ListGating(),
                this.client.ListSelections(),
                this.client.ListTenants(),
                this.client.ListClients(),
                this.client.ListFleet(),
                this.client.ListRollouts(),
            ])
            if (this.model === undefined)
            {
                this.model = new ReleasePolicyViewModel(gating, selections, tenants, clients, fleet, rollouts)
            }
            else
            {
                this.model.Update(gating, selections, tenants, clients, fleet, rollouts)
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
        this.errorText = undefined
        this.mode = GatingMode.Normal
    }

    private ShowModel(model: ReleasePolicyViewModel): void
    {
        const isEmpty = model.GatedRows.length === 0 && model.TargetRows.length === 0
            && model.RolloutRows.length === 0 && !this.operator.CanMutate
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
        root.AddChild(new Section({ title: ReleasePolicyView.TargetsTitle, body: this.targetSlot }))
        root.AddChild(new Section({ title: ReleasePolicyView.RolloutTitle, body: this.rolloutSlot }))
        const actions = new StackPanel()
        actions.Orientation = Orientation.Horizontal
        actions.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.GateLabel, () => this.EnterMode(GatingMode.Gate))))
        actions.AddChild(new Act(this.operator.MutatingAct(ReleasePolicyView.UngateLabel, () => this.EnterMode(GatingMode.Ungate), ActVariant.Danger)))
        root.AddChild(actions)
        // A Refresh() while the form is open is skipped, so the live fields keep their typed input
        // (same fresh-slot cost as the Clients create form).
        this.formSlot = new StackPanel()
        this.formSlot.Orientation = Orientation.Vertical
        this.errorText = undefined
        if (this.mode !== GatingMode.Normal)
        {
            const gate = this.mode === GatingMode.Gate
            this.formSlot.AddChild(this.BuildGatingForm(gate))
            root.AddChild(new Section({
                title: gate ? ReleasePolicyView.GateFormTitle : ReleasePolicyView.UngateFormTitle,
                body: this.formSlot,
            }))
        }
        return root
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
