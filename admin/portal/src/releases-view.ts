import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { ReleaseDetailView } from './release-detail-view.js'
import { ReleaseDetailViewModel } from './release-detail-view-model.js'
import { ReleasesViewModel } from './releases-view-model.js'
import type { ReleaseListRow } from './releases-view-model.js'
import { SectionContainerView, SectionState } from './section-container-view.js'
import type { SectionLabels } from './section-container-view.js'
import { PillKind, PillKinds } from './kit/index.js'
import type { PillEntry, TableColumn } from './kit/index.js'

export enum ReleasesMode
{
    List,
    Detail,
}

// Registry section: a self-routing container (list / detail). Read-only.
export class ReleasesView extends SectionContainerView<ReleaseListRow>
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

    private model: ReleasesViewModel | undefined = undefined

    public constructor(private readonly client: ControlPlaneClient)
    {
        super()
    }

    public get Mode(): ReleasesMode
    {
        return this.State === SectionState.Detail ? ReleasesMode.Detail : ReleasesMode.List
    }

    protected Labels(): SectionLabels
    {
        return {
            listBreadcrumb: ReleasesView.ListBreadcrumb,
            listTitle: ReleasesView.ListTitle,
            emptyTitle: ReleasesView.EmptyTitle,
            errorTitle: ReleasesView.ErrorTitle,
            tableEmptyText: ReleasesView.TableEmptyText,
        }
    }

    protected SearchText(row: ReleaseListRow): string
    {
        return row.id + ReleasesView.SearchSeparator + row.image
    }

    protected async LoadRows(): Promise<readonly ReleaseListRow[]>
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
        return this.model.Rows
    }

    protected async BuildDetail(row: ReleaseListRow): Promise<Visual | undefined>
    {
        const [manifests, fleet] = await Promise.all([this.client.ListManifests(), this.client.ListFleet()])
        const manifest = manifests.find(m => m.id === row.id)
        if (manifest === undefined)
        {
            return undefined
        }
        return new ReleaseDetailView(new ReleaseDetailViewModel(manifest, fleet), () => void this.ShowList())
    }

    private static StatusPill(r: ReleaseListRow): PillEntry
    {
        return PillKinds.For(r.withdrawn ? PillKind.Withdrawn : PillKind.Published)
    }

    protected Columns(): TableColumn<ReleaseListRow>[]
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
