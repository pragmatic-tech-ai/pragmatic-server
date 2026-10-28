import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { Banner, BannerTone, DataTable, PageHeader, ScreenHost, Section, TableDensity } from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'
import { ReleasePolicyViewModel } from './release-policy-view-model.js'
import type { GatedRow, TargetRow } from './release-policy-view-model.js'

// Release policy: the current gating allowlist and per-hive target selections. Read-only; observes only.
export class ReleasePolicyView extends StackPanel implements IPortalView
{
    private static readonly Breadcrumb: readonly string[] = ['Releases', 'Release Policy']
    private static readonly TitleText = 'Release Policy'
    private static readonly CurrentModelNote = 'This is the current gating and selection model: the versions each tenant may adopt, and the target each hive is set to. Scoped rules, channels, minimum versions, holds, and the adoption ledger are not yet available.'
    private static readonly GatedTitle = 'Gated versions'
    private static readonly TargetsTitle = 'Selected targets'
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
    private static readonly EmptyTitle = 'No release policy yet. Gated versions and hive targets appear here once set.'
    private static readonly ErrorTitle = 'Could not load the release policy.'

    private readonly client: ControlPlaneClient
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent, so reusing slots across
    // renders would double-parent them and throw on a second Refresh.
    private gatedSlot = new StackPanel()
    private targetSlot = new StackPanel()
    private model: ReleasePolicyViewModel | undefined
    private nav: IPortalNavigator | undefined

    public constructor(client: ControlPlaneClient)
    {
        super()
        this.client = client
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

    // Test seam: the currently shown gated-versions table (populated state only).
    public get GatedTable(): DataTable<GatedRow> | undefined
    {
        const child = [...this.gatedSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<GatedRow> : undefined
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
        if (this.model === undefined)
        {
            this.host.Update(this.Inputs(true, false, true))
        }
        try
        {
            const [gating, selections, tenants, clients, fleet] = await Promise.all([
                this.client.ListGating(),
                this.client.ListSelections(),
                this.client.ListTenants(),
                this.client.ListClients(),
                this.client.ListFleet(),
            ])
            if (this.model === undefined)
            {
                this.model = new ReleasePolicyViewModel(gating, selections, tenants, clients, fleet)
            }
            else
            {
                this.model.Update(gating, selections, tenants, clients, fleet)
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
    }

    private ShowModel(model: ReleasePolicyViewModel): void
    {
        const isEmpty = model.GatedRows.length === 0 && model.TargetRows.length === 0
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
        root.AddChild(new Section({ title: ReleasePolicyView.GatedTitle, body: this.gatedSlot }))
        root.AddChild(new Section({ title: ReleasePolicyView.TargetsTitle, body: this.targetSlot }))
        return root
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
}
