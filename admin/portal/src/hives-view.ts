import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { FleetPresentation } from './fleet-presentation.js'
import { FleetConnection } from './fleet-view-model.js'
import { HiveDetailView } from './hive-detail-view.js'
import { HiveDetailViewModel } from './hive-detail-view-model.js'
import { HivesViewModel } from './hives-view-model.js'
import type { HiveListRow } from './hives-view-model.js'
import { SectionContainerView, SectionState } from './section-container-view.js'
import type { SectionLabels } from './section-container-view.js'
import { PillKind, PillKinds, PillTone } from './kit/index.js'
import type { PillEntry, TableColumn } from './kit/index.js'

export enum HivesMode
{
    List,
    Detail,
}

// Hives section: a self-routing container (list / detail). Read-only; creation is not part of this section.
export class HivesView extends SectionContainerView<HiveListRow>
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

    private model: HivesViewModel | undefined = undefined

    public constructor(private readonly client: ControlPlaneClient)
    {
        super()
    }

    public get Mode(): HivesMode
    {
        return this.State === SectionState.Detail ? HivesMode.Detail : HivesMode.List
    }

    protected Labels(): SectionLabels
    {
        return {
            listBreadcrumb: HivesView.ListBreadcrumb,
            listTitle: HivesView.ListTitle,
            emptyTitle: HivesView.EmptyTitle,
            errorTitle: HivesView.ErrorTitle,
            tableEmptyText: HivesView.TableEmptyText,
        }
    }

    protected SearchText(row: HiveListRow): string
    {
        return row.displayName + HivesView.SearchSeparator + row.ownerLabel
    }

    protected async LoadRows(): Promise<readonly HiveListRow[]>
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
        return this.model.Rows
    }

    protected async BuildDetail(row: HiveListRow): Promise<Visual | undefined>
    {
        const fleet = await this.client.ListFleet()
        const hive = fleet.find(h => h.id === row.id)
        if (hive === undefined)
        {
            return undefined
        }
        const observations = await this.client.ListHiveObservations(hive.id)
        const vm = new HiveDetailViewModel(hive, undefined, undefined, observations)
        return new HiveDetailView(vm, () => void this.ShowList())
    }

    private static ConnectionPill(r: HiveListRow): PillEntry
    {
        return PillKinds.For(FleetPresentation.ConnectionKind(r.connection))
    }

    protected Columns(): TableColumn<HiveListRow>[]
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
