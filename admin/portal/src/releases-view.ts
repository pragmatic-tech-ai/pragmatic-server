import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { ReleaseDetailView } from './release-detail-view.js'
import { ReleaseDetailViewModel } from './release-detail-view-model.js'
import { ReleasesViewModel } from './releases-view-model.js'
import type { ReleaseListRow } from './releases-view-model.js'
import { DataTable, PageHeader, PillKind, PillKinds, ScreenHost, TableDensity } from './kit/index.js'
import type { PillEntry, ScreenHostInputs, TableColumn } from './kit/index.js'
import type { FleetHiveDto, IPortalNavigator, IPortalView, ManifestDto } from './portal-types.js'

export enum ReleasesMode
{
    List,
    Detail,
}

// Registry section: a self-routing container (list / detail). Read-only.
// Every screen swap clears the content host and adds a freshly built screen (one parent per Visual).
export class ReleasesView extends StackPanel implements IPortalView
{
    private static readonly ListBreadcrumb: readonly string[] = ['Releases', 'Registry & Releases']
    private static readonly ListTitle = 'Registry & Releases'
    private static readonly EmptyTitle = 'No versions published yet.'
    private static readonly ErrorTitle = 'Could not load the releases.'
    private static readonly TableEmptyText = 'No versions match.'
    private static readonly SearchSeparator = ' '
    private static readonly EnvSuffix = ' environment(s)'
    private static readonly NotObserved = 'Not observed running'
    private static readonly VersionKey = 'version'
    private static readonly StatusKey = 'status'
    private static readonly ImageKey = 'image'
    private static readonly PublishedKey = 'published'
    private static readonly RunningKey = 'running'
    private static readonly VersionHeader = 'Version'
    private static readonly StatusHeader = 'Status'
    private static readonly ImageHeader = 'Image'
    private static readonly PublishedHeader = 'Published'
    private static readonly RunningHeader = 'Running'

    private readonly content = new StackPanel()
    private host: ScreenHost
    private listSlot = new StackPanel()
    private model: ReleasesViewModel | undefined
    private mode = ReleasesMode.List
    private listMounted = true
    private detailRow: ReleaseListRow | undefined
    private nav: IPortalNavigator | undefined

    public constructor(private readonly client: ControlPlaneClient)
    {
        super()
        this.Orientation = Orientation.Vertical
        this.content.Orientation = Orientation.Vertical
        this.host = new ScreenHost(ReleasesView.Inputs(true, false, true))
        this.AddChild(this.content)
        this.content.AddChild(this.host)
    }

    // Test seam: the list screen's host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the list table (populated list only).
    public get Table(): DataTable<ReleaseListRow> | undefined
    {
        const child = [...this.listSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<ReleaseListRow> : undefined
    }

    public get Mode(): ReleasesMode
    {
        return this.mode
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
        if (this.mode === ReleasesMode.Detail && this.detailRow !== undefined)
        {
            await this.ShowDetail(this.detailRow)
        }
        else if (this.mode === ReleasesMode.List)
        {
            await this.ShowList()
        }
    }

    public async ShowList(): Promise<void>
    {
        if (!this.listMounted)
        {
            this.host = new ScreenHost(ReleasesView.Inputs(true, false, true))
            this.Swap(this.host)
            this.listMounted = true
        }
        this.mode = ReleasesMode.List
        this.detailRow = undefined
        if (this.model === undefined)
        {
            this.host.Update(ReleasesView.Inputs(true, false, true))
        }
        try
        {
            const [manifests, fleet] = await Promise.all([this.client.ListManifests(), this.client.ListFleet()])
            if (this.model === undefined)
            {
                this.model = new ReleasesViewModel(manifests, fleet)
            }
            else
            {
                this.model.Update(manifests, fleet)
            }
        }
        catch
        {
            this.host.Update(ReleasesView.Inputs(false, true, true, undefined, () => void this.Refresh()))
            return
        }
        if (this.mode !== ReleasesMode.List)
        {
            return
        }
        this.host.Update(this.LoadedInputs(this.model))
    }

    public async ShowDetail(row: ReleaseListRow): Promise<void>
    {
        this.mode = ReleasesMode.Detail
        this.detailRow = row
        let manifest: ManifestDto | undefined
        let fleet: FleetHiveDto[] = []
        try
        {
            const [manifests, hives] = await Promise.all([this.client.ListManifests(), this.client.ListFleet()])
            manifest = manifests.find(m => m.id === row.id)
            fleet = hives
        }
        catch
        {
            // Treated as not found below.
        }
        if (this.mode !== ReleasesMode.Detail || this.detailRow !== row)
        {
            return
        }
        if (manifest === undefined)
        {
            this.mode = ReleasesMode.List
            this.detailRow = undefined
            this.listMounted = true
            this.host = new ScreenHost(ReleasesView.Inputs(false, true, true, undefined, () => void this.Refresh()))
            this.Swap(this.host)
            return
        }
        this.listMounted = false
        this.Swap(new ReleaseDetailView(new ReleaseDetailViewModel(manifest, fleet), () => void this.ShowList()))
    }

    private static Inputs(loading: boolean, error: boolean, isEmpty: boolean, content?: () => Visual, onRetry?: () => void): ScreenHostInputs
    {
        return {
            loading,
            allowed: true,
            error,
            isEmpty,
            empty: { title: ReleasesView.EmptyTitle },
            errorConfig: { title: ReleasesView.ErrorTitle, onRetry },
            content,
        }
    }

    private LoadedInputs(model: ReleasesViewModel): ScreenHostInputs
    {
        return {
            loading: false,
            allowed: true,
            error: false,
            isEmpty: model.Rows.length === 0,
            empty: { title: ReleasesView.EmptyTitle },
            errorConfig: { title: ReleasesView.ErrorTitle, onRetry: () => void this.Refresh() },
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

    private BuildList(model: ReleasesViewModel): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: ReleasesView.ListBreadcrumb, title: ReleasesView.ListTitle }))
        // Fresh slot per render: the previous one is still parented to the previous root.
        this.listSlot = new StackPanel()
        this.listSlot.Orientation = Orientation.Vertical
        this.listSlot.AddChild(new DataTable<ReleaseListRow>({
            columns: ReleasesView.Columns(),
            rows: model.Rows,
            density: TableDensity.Dense,
            searchText: r => r.id + ReleasesView.SearchSeparator + r.image,
            onOpen: r => void this.ShowDetail(r),
            emptyText: ReleasesView.TableEmptyText,
        }))
        root.AddChild(this.listSlot)
        return root
    }

    private static StatusPill(r: ReleaseListRow): PillEntry
    {
        return PillKinds.For(r.withdrawn ? PillKind.Withdrawn : PillKind.Published)
    }

    private static Columns(): TableColumn<ReleaseListRow>[]
    {
        return [
            {
                key: ReleasesView.VersionKey,
                header: ReleasesView.VersionHeader,
                cell: r => r.id,
                sort: (a, b) => a.id.localeCompare(b.id),
            },
            {
                key: ReleasesView.StatusKey,
                header: ReleasesView.StatusHeader,
                cell: r => ReleasesView.StatusPill(r).label,
                tone: r => r.withdrawn ? ReleasesView.StatusPill(r).tone : undefined,
            },
            { key: ReleasesView.ImageKey, header: ReleasesView.ImageHeader, cell: r => r.image },
            { key: ReleasesView.PublishedKey, header: ReleasesView.PublishedHeader, cell: r => r.publishedLabel },
            {
                key: ReleasesView.RunningKey,
                header: ReleasesView.RunningHeader,
                cell: r => r.observedEnvCount > 0 ? r.observedEnvCount + ReleasesView.EnvSuffix : ReleasesView.NotObserved,
                sort: (a, b) => a.observedEnvCount - b.observedEnvCount,
            },
        ]
    }
}
