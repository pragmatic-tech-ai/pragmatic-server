import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { FleetHiveDto } from './portal-types.js'
import { FleetConnection, FleetViewModel } from './fleet-view-model.js'
import type { FleetRow } from './fleet-view-model.js'

export interface HiveListRow
{
    id: string
    displayName: string
    ownerLabel: string
    cluster: string
    connection: FleetConnection
    lastSeenLabel: string
    envCount: number
    notReadyCount: number
}

// Global hive list: fleet-derived state plus the cluster backend / mode.
export class HivesViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'

    private static readonly ClusterSeparator = ' / '

    private rows: readonly HiveListRow[] = []

    public constructor(
        fleet: FleetHiveDto[],
        private readonly now: () => Date = () => new Date(),
        private readonly quietThresholdMs?: number,
    )
    {
        super()
        this.rows = this.Derive(fleet)
    }

    public get Rows(): readonly HiveListRow[]
    {
        return this.rows
    }

    public Update(fleet: FleetHiveDto[]): void
    {
        const old = this.rows
        this.rows = this.Derive(fleet)
        this.RaisePropertyChanged(HivesViewModel.RowsProperty, old, this.rows)
    }

    private Derive(fleet: FleetHiveDto[]): HiveListRow[]
    {
        const fleetRows = new Map<string, FleetRow>()
        for (const r of new FleetViewModel(fleet, this.now, this.quietThresholdMs).Rows)
        {
            fleetRows.set(r.id, r)
        }
        const result: HiveListRow[] = []
        for (const dto of fleet)
        {
            const r = fleetRows.get(dto.id)
            if (r === undefined)
            {
                continue
            }
            result.push({
                id: dto.id,
                displayName: r.displayName,
                ownerLabel: r.ownerLabel,
                cluster: dto.clusterBackend + HivesViewModel.ClusterSeparator + dto.clusterMode,
                connection: r.connection,
                lastSeenLabel: r.lastSeenLabel,
                envCount: r.envCount,
                notReadyCount: r.notReadyCount,
            })
        }
        return result
    }
}
