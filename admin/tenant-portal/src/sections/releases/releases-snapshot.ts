import { UtcText } from '../../shell/utc-text.js'
import type { TenantApiClient } from '../../tenant-api-client.js'
import { EnvStatus, VersionBadge } from '../../tenant-types.js'
import type { AdoptionLedgerDto, EnvironmentDto, HiveRolloutDto, ManifestDto, RolloutEnvDto } from '../../tenant-types.js'

// What adopting a version does to one environment.
export enum EnvStepKind
{
    OnVersion,
    WillRestart,
    StartsLater,
}

// One published version, newest first, with its badge relative to the hive.
export class VersionEntry
{
    public constructor(public readonly Manifest: ManifestDto, public readonly Badge: VersionBadge)
    {
    }

    public get Version(): string
    {
        return this.Manifest.id
    }

    public get IsWithdrawn(): boolean
    {
        return this.Manifest.withdrawn === true
    }

    public get IsCurrent(): boolean
    {
        return this.Badge === VersionBadge.Current
    }
}

// An offered version: adoptable (not withdrawn, not the current one), with
// how many of the hive's environments do not run it yet.
export class OfferEntry
{
    public constructor(public readonly Manifest: ManifestDto, public readonly NotOnCount: number)
    {
    }

    public get Version(): string
    {
        return this.Manifest.id
    }
}

// One environment's line in the adopt wizard's Environments step.
export class EnvStepEntry
{
    private static readonly OnVersionLabel = 'Already on this version'
    private static readonly WillRestartLabel = 'Will restart'
    private static readonly StartsLaterLabel = 'Starts on this version when next started'

    public constructor(public readonly EnvironmentName: string, public readonly Status: EnvStatus, public readonly Kind: EnvStepKind)
    {
    }

    public get Label(): string
    {
        switch (this.Kind)
        {
            case EnvStepKind.OnVersion:
                return EnvStepEntry.OnVersionLabel
            case EnvStepKind.WillRestart:
                return EnvStepEntry.WillRestartLabel
            case EnvStepKind.StartsLater:
                return EnvStepEntry.StartsLaterLabel
        }
    }
}

// One adoption-ledger entry as shown in Version history.
export class LedgerEntry
{
    private static readonly ActionLabels: ReadonlyMap<string, string> = new Map<string, string>([
        ['gated', 'Gated'],
        ['ungated', 'Ungated'],
        ['withdrawn', 'Withdrawn'],
        ['restored', 'Restored'],
        ['selected', 'Selected as target'],
        ['adopted', 'Adopted'],
    ])

    public constructor(private readonly dto: AdoptionLedgerDto)
    {
    }

    public get Version(): string
    {
        return this.dto.version
    }

    // The friendly action label; the raw action when it is not a known one.
    public get ActionLabel(): string
    {
        return LedgerEntry.ActionLabels.get(this.dto.action) ?? this.dto.action
    }

    public get WhenLabel(): string
    {
        return UtcText.DateTime(this.dto.at)
    }
}

// One load of everything the Releases page and the adopt wizard show: the
// published versions (newest first) with the hive's current one, what each
// environment runs, the offers, and the hive's adoption history. Immutable;
// UI-free.
export class ReleasesSnapshot
{
    private static readonly ImpactPrefix = 'Rolling to '
    private static readonly ImpactMiddle = ' restarts: '
    private static readonly ImpactNoEnvironments = ' (no environments are bound to this hive)'
    private static readonly NameSeparator = ', '

    public readonly Versions: readonly VersionEntry[]
    public readonly Ledger: readonly LedgerEntry[]
    private readonly statuses: ReadonlyMap<string, EnvStatus>

    private constructor(manifests: readonly ManifestDto[], private readonly rollout: HiveRolloutDto, environments: readonly EnvironmentDto[], ledger: readonly AdoptionLedgerDto[])
    {
        const sorted = [...manifests].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        const currentId = ReleasesSnapshot.CurrentId(sorted, rollout)
        const currentIndex = sorted.findIndex(m => m.id === currentId)
        this.Versions = sorted.map((manifest, i) => new VersionEntry(manifest, ReleasesSnapshot.BadgeOf(manifest, i, currentIndex)))
        this.statuses = new Map(environments.map(e => [e.name, e.status]))
        // The server's order: newest first.
        this.Ledger = ledger.map(e => new LedgerEntry(e))
    }

    public static From(manifests: readonly ManifestDto[], rollout: HiveRolloutDto, environments: readonly EnvironmentDto[], ledger: readonly AdoptionLedgerDto[]): ReleasesSnapshot
    {
        return new ReleasesSnapshot(manifests, rollout, environments, ledger)
    }

    public static async Load(client: TenantApiClient, hiveId: string): Promise<ReleasesSnapshot>
    {
        const [manifests, rollout, environments, ledger] = await Promise.all([
            client.ListManifests(),
            client.GetRollout(hiveId),
            client.ListEnvironments(),
            client.ListLedger(hiveId),
        ])
        return ReleasesSnapshot.From(manifests, rollout, environments, ledger)
    }

    // The hive's current version; undefined when it cannot be told.
    public get CurrentVersion(): string | undefined
    {
        return this.Versions.find(v => v.IsCurrent)?.Version
    }

    // The environments the hive's rollout reports, in its order.
    public get Environments(): readonly RolloutEnvDto[]
    {
        return this.rollout.environments
    }

    // Every non-withdrawn, non-current version, newest first.
    public get Offers(): readonly OfferEntry[]
    {
        return this.Versions
            .filter(v => !v.IsWithdrawn && !v.IsCurrent)
            .map(v => new OfferEntry(v.Manifest, this.rollout.environments.filter(e => e.runningImage !== v.Manifest.image).length))
    }

    public Offer(version: string): OfferEntry | undefined
    {
        return this.Offers.find(o => o.Version === version)
    }

    // Whether `environment` runs `version`.
    public Runs(environment: RolloutEnvDto, version: VersionEntry): boolean
    {
        return environment.runningImage === version.Manifest.image
    }

    // What adopting `version` does to each environment.
    public EnvSteps(version: string): readonly EnvStepEntry[]
    {
        const image = this.Versions.find(v => v.Version === version)?.Manifest.image
        return this.rollout.environments.map(e =>
        {
            const status = this.statuses.get(e.environmentName) ?? EnvStatus.Unknown
            const kind = image !== undefined && e.runningImage === image
                ? EnvStepKind.OnVersion
                : status === EnvStatus.Running ? EnvStepKind.WillRestart : EnvStepKind.StartsLater
            return new EnvStepEntry(e.environmentName, status, kind)
        })
    }

    public Impact(version: string): string
    {
        const S = ReleasesSnapshot
        const names = this.rollout.environments.map(e => e.environmentName).join(S.NameSeparator)
        return names.length === 0
            ? S.ImpactPrefix + version + S.ImpactNoEnvironments
            : S.ImpactPrefix + version + S.ImpactMiddle + names
    }

    // The current version keeps Current even if withdrawn; any other
    // withdrawn version is Withdrawn; the one after the current is Previous.
    private static BadgeOf(manifest: ManifestDto, index: number, currentIndex: number): VersionBadge
    {
        if (index === currentIndex)
        {
            return VersionBadge.Current
        }
        if (manifest.withdrawn === true)
        {
            return VersionBadge.Withdrawn
        }
        return currentIndex >= 0 && index === currentIndex + 1 ? VersionBadge.Previous : VersionBadge.Available
    }

    // The target is the source of truth; with none, the running image counts
    // only if every environment agrees.
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
