import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { EnvStatus, TenantEventType, VersionBadge } from './tenant-types.js'
import type { HiveRolloutDto, IReleasesSource, ManifestDto, TenantEvent } from './tenant-types.js'
import { TenantApiError } from './tenant-api-client.js'

export enum AdoptOutcome
{
    Adopted,
    Refused,
    Unavailable,
    Unknown,
}

export enum EnvStepKind
{
    OnVersion,
    WillRestart,
    StartsLater,
}

export type VersionRow = { manifest: ManifestDto; version: string; badge: VersionBadge; withdrawn: boolean }
export type Offer = { manifest: ManifestDto; version: string; notOnCount: number }
export type MatrixColumn = { version: string; manifest: ManifestDto; badge: VersionBadge }
export type MatrixCell = { version: string; running: boolean }
export type MatrixRow = { environmentName: string; status: EnvStatus; cells: readonly MatrixCell[] }
export type MatrixModel = { columns: readonly MatrixColumn[]; rows: readonly MatrixRow[] }
export type EnvStepInfo = { environmentName: string; status: EnvStatus; kind: EnvStepKind; label: string }
export type AdoptResult = { outcome: AdoptOutcome; message: string | undefined }

// Offers, the runs-what matrix, per-environment wizard info, and the hive-wide adopt flow.
export class ReleasesViewModel extends Observable
{
    public static readonly VersionsProperty = 'Versions'

    public static readonly LabelOnVersion = 'Already on this version'
    public static readonly LabelWillRestart = 'Will restart'
    public static readonly LabelStartsLater = 'Starts on this version when next started'

    private static readonly ImpactPrefix = 'Rolling to '
    private static readonly ImpactMiddle = ' restarts: '
    private static readonly ImpactNoEnvironments = ' (no environments are bound to this hive)'
    private static readonly NameSeparator = ', '
    private static readonly ConflictStatus = 409
    private static readonly UnavailableStatus = 503

    private versions: readonly VersionRow[] = []
    private rollout: HiveRolloutDto = { targetVersion: undefined, environments: [] }
    private statuses = new Map<string, EnvStatus>()
    private running: string | undefined
    private lastResult: AdoptResult | undefined
    private generation = 0

    public constructor(private readonly source: IReleasesSource, private readonly hiveId: string)
    {
        super()
    }

    public get Versions(): readonly VersionRow[]
    {
        return this.versions
    }

    public get RunningVersion(): string | undefined
    {
        return this.running
    }

    // The outcome and unaugmented server message of the last ConfirmAdopt.
    public get LastResult(): AdoptResult | undefined
    {
        return this.lastResult
    }

    public async Load(): Promise<void>
    {
        const generation = ++this.generation
        const [manifests, rollout, environments] = await Promise.all([
            this.source.ListManifests(),
            this.source.GetRollout(this.hiveId),
            this.source.ListEnvironments(),
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
            version: manifest.id,
            // The current version keeps Current even if withdrawn; any other withdrawn version is Withdrawn.
            badge: i === currentIndex
                ? VersionBadge.Current
                : manifest.withdrawn === true
                    ? VersionBadge.Withdrawn
                    : currentIndex >= 0 && i === currentIndex + 1 ? VersionBadge.Previous : VersionBadge.Available,
            withdrawn: manifest.withdrawn === true,
        }))
        this.running = currentIndex >= 0 ? sorted[currentIndex]!.id : undefined
        this.rollout = rollout
        this.statuses = new Map(environments.map(e => [e.name, e.status]))
        this.RaisePropertyChanged(ReleasesViewModel.VersionsProperty, old, this.versions)
    }

    public get Offers(): readonly Offer[]
    {
        return this.versions
            .filter(r => !r.withdrawn && r.badge !== VersionBadge.Current)
            .map(r => ({
                manifest: r.manifest,
                version: r.version,
                notOnCount: this.rollout.environments.filter(e => e.runningImage !== r.manifest.image).length,
            }))
    }

    public get Matrix(): MatrixModel
    {
        const columns = this.versions.map(r => ({ version: r.version, manifest: r.manifest, badge: r.badge }))
        const rows = this.rollout.environments.map(e => ({
            environmentName: e.environmentName,
            status: this.StatusOf(e.environmentName),
            cells: columns.map(c => ({ version: c.version, running: e.runningImage === c.manifest.image })),
        }))
        return { columns, rows }
    }

    public EnvSteps(version: string): readonly EnvStepInfo[]
    {
        const image = this.versions.find(r => r.version === version)?.manifest.image
        return this.rollout.environments.map(e =>
        {
            const status = this.StatusOf(e.environmentName)
            const kind = image !== undefined && e.runningImage === image
                ? EnvStepKind.OnVersion
                : status === EnvStatus.Running ? EnvStepKind.WillRestart : EnvStepKind.StartsLater
            return { environmentName: e.environmentName, status, kind, label: ReleasesViewModel.LabelFor(kind) }
        })
    }

    public Impact(version: string): string
    {
        const names = this.rollout.environments.map(e => e.environmentName).join(ReleasesViewModel.NameSeparator)
        return names === ''
            ? ReleasesViewModel.ImpactPrefix + version + ReleasesViewModel.ImpactNoEnvironments
            : ReleasesViewModel.ImpactPrefix + version + ReleasesViewModel.ImpactMiddle + names
    }

    // No optimistic mutation: the target only changes through a successful Load.
    public async ConfirmAdopt(version: string): Promise<AdoptOutcome>
    {
        // A withdrawn version is never adoptable; the view hides it, and this guards a direct call.
        if (this.versions.find(r => r.version === version)?.withdrawn === true)
        {
            this.lastResult = { outcome: AdoptOutcome.Unknown, message: undefined }
            return AdoptOutcome.Unknown
        }
        let result: AdoptResult
        try
        {
            await this.source.SelectTarget(this.hiveId, version)
            result = { outcome: AdoptOutcome.Adopted, message: undefined }
        }
        catch (e)
        {
            result = ReleasesViewModel.ResultOf(e)
        }
        this.lastResult = result
        if (result.outcome === AdoptOutcome.Adopted || result.outcome === AdoptOutcome.Unknown)
        {
            await this.Load().catch(() => undefined)
        }
        return result.outcome
    }

    // Reloads when a change or delete is for one of this hive's environments; resolves true when it did.
    public async ApplyEvent(ev: TenantEvent): Promise<boolean>
    {
        const lifecycle = ev.type === TenantEventType.EnvironmentChanged || ev.type === TenantEventType.EnvironmentDeleted
        if (!lifecycle || !this.rollout.environments.some(e => e.environmentName === ev.environmentName))
        {
            return false
        }
        await this.Load().catch(() => undefined)
        return true
    }

    private static ResultOf(e: unknown): AdoptResult
    {
        const message = e instanceof Error ? e.message : undefined
        if (e instanceof TenantApiError)
        {
            if (e.Status === ReleasesViewModel.ConflictStatus)
            {
                return { outcome: AdoptOutcome.Refused, message }
            }
            if (e.Status === ReleasesViewModel.UnavailableStatus)
            {
                return { outcome: AdoptOutcome.Unavailable, message }
            }
        }
        return { outcome: AdoptOutcome.Unknown, message }
    }

    private static LabelFor(kind: EnvStepKind): string
    {
        switch (kind)
        {
            case EnvStepKind.OnVersion:
                return ReleasesViewModel.LabelOnVersion
            case EnvStepKind.WillRestart:
                return ReleasesViewModel.LabelWillRestart
            default:
                return ReleasesViewModel.LabelStartsLater
        }
    }

    private StatusOf(name: string): EnvStatus
    {
        return this.statuses.get(name) ?? EnvStatus.Unknown
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
}
