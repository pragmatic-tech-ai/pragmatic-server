import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantEventType, VersionBadge } from './tenant-types.js'
import type { HiveDto, HiveHealthDto, HiveRolloutDto, ManifestDto, TenantEvent } from './tenant-types.js'

// The slice of TenantApiClient the hive detail needs.
export interface IHiveDetailSource
{
    ListManifests(): Promise<ManifestDto[]>
    GetRollout(hiveId: string): Promise<HiveRolloutDto>
    GetHealth(hiveId: string): Promise<HiveHealthDto[]>
    SelectTarget(hiveId: string, version: string): Promise<void>
}

export type VersionRow = { manifest: ManifestDto; badge: VersionBadge; isTarget: boolean; withdrawn: boolean }
export type PendingTarget = { version: string; impact: string }
export type FailedRoll = { message: string; stayedOn: string }

// Published versions, running version, health, and the roll / rollback flow for one hive.
export class HiveDetailViewModel extends Observable
{
    public static readonly VersionsProperty = 'Versions'
    public static readonly PendingProperty = 'Pending'
    public static readonly FailedRollProperty = 'FailedRoll'

    private static readonly ImpactPrefix = 'Rolling to '
    private static readonly ImpactMiddle = ' restarts: '
    private static readonly ImpactNoEnvironments = ' (no environments are bound to this hive)'
    private static readonly NameSeparator = ', '
    private static readonly UnknownVersion = 'unknown'

    private versions: readonly VersionRow[] = []
    private health: readonly HiveHealthDto[] = []
    private envNames: readonly string[] = []
    private running: string | undefined
    private pending: PendingTarget | undefined
    private failedRoll: FailedRoll | undefined
    private generation = 0

    public constructor(private readonly source: IHiveDetailSource, private readonly hive: HiveDto)
    {
        super()
    }

    public get Versions(): readonly VersionRow[]
    {
        return this.versions
    }

    public get Health(): readonly HiveHealthDto[]
    {
        return this.health
    }

    public get RunningVersion(): string | undefined
    {
        return this.running
    }

    public get IsEmpty(): boolean
    {
        return this.versions.length === 0
    }

    public get Pending(): PendingTarget | undefined
    {
        return this.pending
    }

    public get FailedRoll(): FailedRoll | undefined
    {
        return this.failedRoll
    }

    public async Load(): Promise<void>
    {
        const generation = ++this.generation
        const [manifests, rollout, health] = await Promise.all([
            this.source.ListManifests(),
            this.source.GetRollout(this.hive.id),
            this.source.GetHealth(this.hive.id),
        ])
        if (generation !== this.generation)
        {
            return
        }
        const sorted = [...manifests].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        const currentId = this.CurrentId(sorted, rollout)
        const currentIndex = sorted.findIndex(m => m.id === currentId)
        const old = this.versions
        this.versions = sorted.map((manifest, i) => ({
            manifest,
            // The current (running) version keeps its Current badge even if withdrawn; any other withdrawn version is
            // badged Withdrawn, overriding the positional Previous/Available meaning.
            badge: i === currentIndex
                ? VersionBadge.Current
                : manifest.withdrawn === true
                    ? VersionBadge.Withdrawn
                    : currentIndex >= 0 && i === currentIndex + 1 ? VersionBadge.Previous : VersionBadge.Available,
            isTarget: i === currentIndex,
            withdrawn: manifest.withdrawn === true,
        }))
        this.running = currentIndex >= 0 ? sorted[currentIndex]!.id : undefined
        this.health = health
        this.envNames = rollout.environments.map(e => e.environmentName)
        this.RaisePropertyChanged(HiveDetailViewModel.VersionsProperty, old, this.versions)
    }

    public BeginTarget(version: string): void
    {
        // A withdrawn version is never a valid roll target; the view hides its button, and this guards a direct call.
        if (this.versions.find(r => r.manifest.id === version)?.withdrawn === true)
        {
            return
        }
        const names = this.envNames.join(HiveDetailViewModel.NameSeparator)
        const impact = names === ''
            ? HiveDetailViewModel.ImpactPrefix + version + HiveDetailViewModel.ImpactNoEnvironments
            : HiveDetailViewModel.ImpactPrefix + version + HiveDetailViewModel.ImpactMiddle + names
        this.SetFailedRoll(undefined)
        this.SetPending({ version, impact })
    }

    public CancelTarget(): void
    {
        this.SetPending(undefined)
    }

    // On failure the last good Load stays in place: the roll did not take.
    public async ConfirmTarget(): Promise<void>
    {
        const pending = this.pending
        if (pending === undefined)
        {
            return
        }
        try
        {
            await this.source.SelectTarget(this.hive.id, pending.version)
        }
        catch (e)
        {
            this.SetPending(undefined)
            this.SetFailedRoll({ message: (e as Error).message, stayedOn: this.running ?? HiveDetailViewModel.UnknownVersion })
            return
        }
        this.SetPending(undefined)
        await this.Load()
    }

    // Reloads when a change or delete is for one of this hive's environments; resolves true when it did.
    // A create carries no hive attribution, so the hive detail leaves it to TenantApp's pane refresh.
    public async ApplyEvent(ev: TenantEvent): Promise<boolean>
    {
        const lifecycle = ev.type === TenantEventType.EnvironmentChanged || ev.type === TenantEventType.EnvironmentDeleted
        if (!lifecycle || !this.envNames.includes(ev.environmentName))
        {
            return false
        }
        // A failed live refresh is intentionally ignored: the next successful event or Refresh recovers.
        await this.Load().catch(() => undefined)
        return true
    }

    // The target is the source of truth; with none, the running image counts only if every environment agrees.
    private CurrentId(sorted: readonly ManifestDto[], rollout: HiveRolloutDto): string | undefined
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

    private SetPending(value: PendingTarget | undefined): void
    {
        const old = this.pending
        this.pending = value
        this.RaisePropertyChanged(HiveDetailViewModel.PendingProperty, old, value)
    }

    private SetFailedRoll(value: FailedRoll | undefined): void
    {
        const old = this.failedRoll
        this.failedRoll = value
        this.RaisePropertyChanged(HiveDetailViewModel.FailedRollProperty, old, value)
    }
}
