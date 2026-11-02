import type { HiveRolloutDto, ManifestDto } from '../../tenant-types.js'

// Which published version Pragmatic is offering the hive (or one of its
// environments) that it does not run yet. Withdrawn versions are never offered.
export class VersionOffer
{
    // The newest non-withdrawn manifest newer than the current one (the
    // target, else the image every environment runs) that at least one
    // environment is not running; undefined without a rollout report.
    public static ForHive(manifests: readonly ManifestDto[], rollout: HiveRolloutDto | undefined): ManifestDto | undefined
    {
        if (rollout === undefined)
        {
            return undefined
        }
        const sorted = VersionOffer.NewestFirst(manifests)
        const currentId = VersionOffer.CurrentId(sorted, rollout)
        // Only what is newer than the current version is an offer.
        const current = sorted.findIndex(m => m.id === currentId)
        const newer = current < 0 ? sorted : sorted.slice(0, current)
        return newer.find(m => m.withdrawn !== true
            && rollout.environments.some(e => e.runningImage !== m.image))
    }

    // How many of the rollout's environments do not run `offer` yet.
    public static BehindCount(offer: ManifestDto, rollout: HiveRolloutDto | undefined): number
    {
        return (rollout?.environments ?? []).filter(e => e.runningImage !== offer.image).length
    }

    // The manifests, newest published first.
    public static NewestFirst(manifests: readonly ManifestDto[]): ManifestDto[]
    {
        return [...manifests].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    }

    // The target is the source of truth; with none, the running image counts
    // only if every environment agrees.
    public static CurrentId(sorted: readonly ManifestDto[], rollout: HiveRolloutDto): string | undefined
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
