import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { FleetHiveDto, ManifestDto } from './portal-types.js'
import { PortalDates } from './portal-dates.js'

export interface ReleaseListRow
{
    id: string
    image: string
    withdrawn: boolean
    publishedLabel: string
    observedEnvCount: number
}

// Registry release list: published manifests with observed adoption per image.
export class ReleasesViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'

    private rows: readonly ReleaseListRow[] = []

    public constructor(manifests: readonly ManifestDto[], fleet: readonly FleetHiveDto[])
    {
        super()
        this.rows = this.Derive(manifests, fleet)
    }

    public get Rows(): readonly ReleaseListRow[]
    {
        return this.rows
    }

    public Update(manifests: readonly ManifestDto[], fleet: readonly FleetHiveDto[]): void
    {
        const old = this.rows
        this.rows = this.Derive(manifests, fleet)
        this.RaisePropertyChanged(ReleasesViewModel.RowsProperty, old, this.rows)
    }

    private Derive(manifests: readonly ManifestDto[], fleet: readonly FleetHiveDto[]): ReleaseListRow[]
    {
        // Array.prototype.sort is stable, so equal/empty dates keep input order.
        const ordered = [...manifests].sort((a, b) => ReleasesViewModel.CompareNewestFirst(a, b))
        return ordered.map(m => ({
            id: m.id,
            image: m.image,
            withdrawn: m.withdrawn === true,
            publishedLabel: PortalDates.Label(m.publishedAt),
            observedEnvCount: ReleasesViewModel.CountObserved(m.image, fleet),
        }))
    }

    private static CompareNewestFirst(a: ManifestDto, b: ManifestDto): number
    {
        const x = a.publishedAt ?? ''
        const y = b.publishedAt ?? ''
        if (x === y)
        {
            return 0
        }
        return x < y ? 1 : -1
    }

    private static CountObserved(image: string, fleet: readonly FleetHiveDto[]): number
    {
        let count = 0
        for (const hive of fleet)
        {
            for (const env of hive.environments)
            {
                if (env.image !== undefined && env.image === image)
                {
                    count++
                }
            }
        }
        return count
    }
}
