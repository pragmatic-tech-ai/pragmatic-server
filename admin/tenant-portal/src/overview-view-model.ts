import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { EnvironmentRow } from './environment-row.js'
import { TenantApiError } from './tenant-api-client.js'
import { TenantEventType } from './tenant-types.js'
import type { EnvironmentDto, HiveHealthDto, HiveRolloutDto, IOverviewSource, ManifestDto, TenantEvent } from './tenant-types.js'

// Aggregates the Overview home: environment rows, the "newer version offered" signal, and existing names.
export class OverviewViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'

    private rows: readonly EnvironmentRow[] = []
    private offered: ManifestDto | undefined
    private loaded = false
    private error = false
    private generation = 0

    public constructor(private readonly source: IOverviewSource, private readonly hiveId: string)
    {
        super()
    }

    public get Rows(): readonly EnvironmentRow[]
    {
        return this.rows
    }

    public get Loaded(): boolean
    {
        return this.loaded
    }

    public get Error(): boolean
    {
        return this.error
    }

    public get ExistingNames(): readonly string[]
    {
        return this.rows.map(r => r.Name)
    }

    public get OfferAvailable(): boolean
    {
        return this.offered !== undefined
    }

    public get OfferedVersion(): string | undefined
    {
        return this.offered === undefined ? undefined : EnvironmentRow.VersionOf(this.offered.image)
    }

    // Environments are essential: their failure is the error state. Health, manifests and rollout only
    // enrich the view, so each degrades (no health pills, no offer) instead of failing the whole home.
    public async Load(): Promise<void>
    {
        const generation = ++this.generation
        let result: [EnvironmentDto[], HiveHealthDto[], ManifestDto[], HiveRolloutDto | undefined]
        try
        {
            result = await Promise.all([
                this.source.ListEnvironments(),
                this.source.GetHealth(this.hiveId).catch((e): HiveHealthDto[] => OverviewViewModel.Degrade(e, [])),
                this.source.ListManifests().catch((e): ManifestDto[] => OverviewViewModel.Degrade(e, [])),
                this.source.GetRollout(this.hiveId).catch((e): HiveRolloutDto | undefined => OverviewViewModel.Degrade(e, undefined)),
            ])
        }
        catch (e)
        {
            if (OverviewViewModel.IsUnauthorized(e))
            {
                throw e
            }
            if (generation === this.generation)
            {
                this.error = true
                this.loaded = false
                this.RaisePropertyChanged(OverviewViewModel.RowsProperty, this.rows, this.rows)
            }
            return
        }
        if (generation !== this.generation)
        {
            return
        }
        const [environments, health, manifests, rollout] = result
        const byName = new Map(health.map(h => [h.environmentName, h]))
        const old = this.rows
        this.rows = environments.map(e => new EnvironmentRow(e, byName.get(e.name)))
        this.offered = OverviewViewModel.OfferOf(manifests, rollout)
        this.error = false
        this.loaded = true
        this.RaisePropertyChanged(OverviewViewModel.RowsProperty, old, this.rows)
    }

    // Reloads on any environment lifecycle or health event; resolves true when it did.
    public async ApplyEvent(ev: TenantEvent): Promise<boolean>
    {
        const relevant = ev.type === TenantEventType.EnvironmentCreated
            || ev.type === TenantEventType.EnvironmentChanged
            || ev.type === TenantEventType.EnvironmentDeleted
            || ev.type === TenantEventType.HealthChanged
        if (!relevant)
        {
            return false
        }
        await this.Load().catch(() => undefined)
        return true
    }

    // A 401 is session death and must surface; any other enrichment failure degrades to the fallback.
    private static Degrade<T>(e: unknown, fallback: T): T
    {
        if (OverviewViewModel.IsUnauthorized(e))
        {
            throw e
        }
        return fallback
    }

    private static IsUnauthorized(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus
    }

    // The newest non-withdrawn, non-current manifest that at least one environment is not running.
    private static OfferOf(manifests: readonly ManifestDto[], rollout: HiveRolloutDto | undefined): ManifestDto | undefined
    {
        if (rollout === undefined)
        {
            return undefined
        }
        const sorted = [...manifests].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        const currentId = OverviewViewModel.CurrentId(sorted, rollout)
        return sorted.find(m => m.withdrawn !== true
            && m.id !== currentId
            && rollout.environments.some(e => e.runningImage !== m.image))
    }

    // The target is the source of truth; with none, the running image counts only if every environment agrees.
    private static CurrentId(sorted: readonly ManifestDto[], rollout: HiveRolloutDto): string | undefined
    {
        if (rollout.targetVersion !== undefined)
        {
            return sorted.find(m => m.id === rollout.targetVersion)?.id
        }
        const images = new Set(rollout.environments.map(e => e.runningImage))
        if (images.size !== 1)
        {
            return undefined
        }
        const [image] = [...images]
        return image === undefined ? undefined : sorted.find(m => m.image === image)?.id
    }
}
