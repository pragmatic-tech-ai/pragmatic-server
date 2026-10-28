import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { FleetPresentation } from './fleet-presentation.js'
import { FleetConnection } from './fleet-view-model.js'
import { HiveDetailView } from './hive-detail-view.js'
import { HiveDetailViewModel } from './hive-detail-view-model.js'
import { HivesViewModel } from './hives-view-model.js'
import type { HiveListRow } from './hives-view-model.js'
import { DataTable, PageHeader, PillKind, PillKinds, PillTone, ScreenHost, TableDensity } from './kit/index.js'
import type { PillEntry, ScreenHostInputs, TableColumn } from './kit/index.js'
import type { FleetHiveDto, IPortalNavigator, IPortalView } from './portal-types.js'

export enum HivesMode
{
    List,
    Detail,
}

// Hives section: a self-routing container (list / detail). Read-only; creation is not part of this section.
// Every screen swap clears the content host and adds a freshly built screen (one parent per Visual).
export class HivesView extends StackPanel implements IPortalView
{
    private static readonly ListBreadcrumb: readonly string[] = ['Provisioning', 'Hives']
    private static readonly ListTitle = 'Hives'
    private static readonly EmptyTitle = 'No hives yet.'
    private static readonly ErrorTitle = 'Could not load the hives.'
    private static readonly TableEmptyText = 'No hives match.'
    private static readonly SearchSeparator = ' '
    private static readonly ConnectionSeparator = ' - '
    private static readonly HiveKey = 'hive'
    private static readonly OwnerKey = 'owner'
    private static readonly ClusterKey = 'cluster'
    private static readonly ConnectionKey = 'connection'
    private static readonly HealthKey = 'health'
    private static readonly EnvsKey = 'envs'
    private static readonly HiveHeader = 'Hive'
    private static readonly OwnerHeader = 'Client / tenant'
    private static readonly ClusterHeader = 'Cluster'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly HealthHeader = 'Health'
    private static readonly EnvsHeader = 'Envs'

    private readonly content = new StackPanel()
    private host: ScreenHost
    private listSlot = new StackPanel()
    private model: HivesViewModel | undefined
    private mode = HivesMode.List
    private listMounted = true
    private detailRow: HiveListRow | undefined
    private nav: IPortalNavigator | undefined

    public constructor(private readonly client: ControlPlaneClient)
    {
        super()
        this.Orientation = Orientation.Vertical
        this.content.Orientation = Orientation.Vertical
        this.host = new ScreenHost(HivesView.Inputs(true, false, true))
        this.AddChild(this.content)
        this.content.AddChild(this.host)
    }

    // Test seam: the list screen's host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the list table (populated list only).
    public get Table(): DataTable<HiveListRow> | undefined
    {
        const child = [...this.listSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<HiveListRow> : undefined
    }

    public get Mode(): HivesMode
    {
        return this.mode
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
        if (this.mode === HivesMode.Detail && this.detailRow !== undefined)
        {
            await this.ShowDetail(this.detailRow)
        }
        else if (this.mode === HivesMode.List)
        {
            await this.ShowList()
        }
    }

    public async ShowList(): Promise<void>
    {
        if (!this.listMounted)
        {
            this.host = new ScreenHost(HivesView.Inputs(true, false, true))
            this.Swap(this.host)
            this.listMounted = true
        }
        this.mode = HivesMode.List
        this.detailRow = undefined
        if (this.model === undefined)
        {
            this.host.Update(HivesView.Inputs(true, false, true))
        }
        try
        {
            const fleet = await this.client.ListFleet()
            if (this.model === undefined)
            {
                this.model = new HivesViewModel(fleet)
            }
            else
            {
                this.model.Update(fleet)
            }
        }
        catch
        {
            this.host.Update(HivesView.Inputs(false, true, true, undefined, () => void this.Refresh()))
            return
        }
        if (this.mode !== HivesMode.List)
        {
            return
        }
        this.host.Update(this.LoadedInputs(this.model))
    }

    public async ShowDetail(row: HiveListRow): Promise<void>
    {
        this.mode = HivesMode.Detail
        this.detailRow = row
        let hive: FleetHiveDto | undefined
        try
        {
            const fleet = await this.client.ListFleet()
            hive = fleet.find(h => h.id === row.id)
        }
        catch
        {
            // Treated as not found below.
        }
        if (this.mode !== HivesMode.Detail || this.detailRow !== row)
        {
            return
        }
        if (hive === undefined)
        {
            this.mode = HivesMode.List
            this.detailRow = undefined
            this.listMounted = true
            this.host = new ScreenHost(HivesView.Inputs(false, true, true, undefined, () => void this.Refresh()))
            this.Swap(this.host)
            return
        }
        this.listMounted = false
        this.Swap(new HiveDetailView(new HiveDetailViewModel(hive), () => void this.ShowList()))
    }

    private static Inputs(loading: boolean, error: boolean, isEmpty: boolean, content?: () => Visual, onRetry?: () => void): ScreenHostInputs
    {
        return {
            loading,
            allowed: true,
            error,
            isEmpty,
            empty: { title: HivesView.EmptyTitle },
            errorConfig: { title: HivesView.ErrorTitle, onRetry },
            content,
        }
    }

    private LoadedInputs(model: HivesViewModel): ScreenHostInputs
    {
        return {
            loading: false,
            allowed: true,
            error: false,
            isEmpty: model.Rows.length === 0,
            empty: { title: HivesView.EmptyTitle },
            errorConfig: { title: HivesView.ErrorTitle, onRetry: () => void this.Refresh() },
            content: () => this.BuildList(model),
        }
    }

    private Swap(screen: Visual): void
    {
        for (const child of [...this.content.Children])
        {
            this.content.RemoveChild(child)
        }
        this.content.AddChild(screen)
    }

    private BuildList(model: HivesViewModel): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: HivesView.ListBreadcrumb, title: HivesView.ListTitle }))
        // Fresh slot per render: the previous one is still parented to the previous root.
        this.listSlot = new StackPanel()
        this.listSlot.Orientation = Orientation.Vertical
        this.listSlot.AddChild(new DataTable<HiveListRow>({
            columns: HivesView.Columns(),
            rows: model.Rows,
            density: TableDensity.Dense,
            searchText: r => r.displayName + HivesView.SearchSeparator + r.ownerLabel,
            onOpen: r => void this.ShowDetail(r),
            emptyText: HivesView.TableEmptyText,
        }))
        root.AddChild(this.listSlot)
        return root
    }

    private static ConnectionPill(r: HiveListRow): PillEntry
    {
        return PillKinds.For(FleetPresentation.ConnectionKind(r.connection))
    }

    private static Columns(): TableColumn<HiveListRow>[]
    {
        return [
            {
                key: HivesView.HiveKey,
                header: HivesView.HiveHeader,
                cell: r => r.displayName,
                sort: (a, b) => a.displayName.localeCompare(b.displayName),
            },
            {
                key: HivesView.OwnerKey,
                header: HivesView.OwnerHeader,
                cell: r => r.ownerLabel,
                sort: (a, b) => a.ownerLabel.localeCompare(b.ownerLabel),
            },
            { key: HivesView.ClusterKey, header: HivesView.ClusterHeader, cell: r => r.cluster },
            {
                key: HivesView.ConnectionKey,
                header: HivesView.ConnectionHeader,
                cell: r => HivesView.ConnectionPill(r).label + HivesView.ConnectionSeparator + r.lastSeenLabel,
                tone: r => r.connection === FleetConnection.Connected ? undefined : HivesView.ConnectionPill(r).tone,
            },
            {
                key: HivesView.HealthKey,
                header: HivesView.HealthHeader,
                cell: r => PillKinds.For(r.notReadyCount > 0 ? PillKind.Failing : PillKind.Healthy).label,
                tone: r => r.notReadyCount > 0 ? PillTone.Danger : undefined,
            },
            {
                key: HivesView.EnvsKey,
                header: HivesView.EnvsHeader,
                cell: r => String(r.envCount),
                sort: (a, b) => a.envCount - b.envCount,
            },
        ]
    }
}
