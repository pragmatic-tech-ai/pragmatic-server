import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { FleetHiveDto, ManifestDto } from './portal-types.js'
import { FleetViewModel } from './fleet-view-model.js'
import { PortalDates } from './portal-dates.js'
import { BannerTone, PillKind } from './kit/index.js'
import { ReleaseChannel } from './release-channel.js'
import type { KeyValueItem } from './kit/index.js'

export interface ReleaseAdoptionRow
{
    hiveName: string
    ownerLabel: string
    envName: string
    ready: boolean
}

export interface ReleaseBannerState
{
    show: boolean
    tone: BannerTone
    text: string
}

// Pure derivation for one release's detail page: profile, withdrawn banner, adoption rows.
export class ReleaseDetailViewModel extends Observable
{
    private static readonly KeyVersion = 'Version'
    private static readonly KeyImage = 'Image'
    private static readonly KeyDigest = 'Digest'
    private static readonly DigestLength = 12
    private static readonly DigestSeparator = ':'
    private static readonly KeyPublished = 'Published'
    private static readonly KeyStatus = 'Status'
    private static readonly KeyWhatsNew = "What's new"
    private static readonly StatusPublished = 'Published'
    private static readonly StatusWithdrawn = 'Withdrawn'
    private static readonly NoNotes = '(none)'
    private static readonly NoText = ''
    private static readonly WithdrawnText =
        'This version is withdrawn. Hives stop seeing it as adoptable after their next check-in. Environments already running it keep running it until their tenant adopts another version.'

    public constructor(
        private readonly manifest: ManifestDto,
        private readonly fleet: readonly FleetHiveDto[],
    )
    {
        super()
    }

    public get Version(): string
    {
        return this.manifest.id
    }

    public get Withdrawn(): boolean
    {
        return this.manifest.withdrawn === true
    }

    public get ChannelPill(): PillKind
    {
        return this.manifest.channel === ReleaseChannel.Early ? PillKind.EarlyAccess : PillKind.Stable
    }

    public get SignedPill(): PillKind
    {
        return this.manifest.signed === true ? PillKind.Signed : PillKind.Unsigned
    }

    public get Profile(): readonly KeyValueItem[]
    {
        const m = this.manifest
        const notes = m.notes && m.notes.length > 0 ? m.notes : ReleaseDetailViewModel.NoNotes
        const status = m.withdrawn === true ? ReleaseDetailViewModel.StatusWithdrawn : ReleaseDetailViewModel.StatusPublished
        const rows: KeyValueItem[] = [
            { key: ReleaseDetailViewModel.KeyVersion, value: m.id },
            { key: ReleaseDetailViewModel.KeyImage, value: m.image },
        ]
        if (m.digest !== undefined && m.digest.length > 0)
        {
            rows.push({ key: ReleaseDetailViewModel.KeyDigest, value: m.digest.slice(m.digest.lastIndexOf(ReleaseDetailViewModel.DigestSeparator) + 1).slice(0, ReleaseDetailViewModel.DigestLength) })
        }
        rows.push(
            { key: ReleaseDetailViewModel.KeyPublished, value: PortalDates.Label(m.publishedAt) },
            { key: ReleaseDetailViewModel.KeyStatus, value: status },
            { key: ReleaseDetailViewModel.KeyWhatsNew, value: notes },
        )
        return rows
    }

    public get WithdrawnBanner(): ReleaseBannerState
    {
        if (this.manifest.withdrawn === true)
        {
            return { show: true, tone: BannerTone.Warning, text: ReleaseDetailViewModel.WithdrawnText }
        }
        return { show: false, tone: BannerTone.Warning, text: ReleaseDetailViewModel.NoText }
    }

    public get AdoptionRows(): readonly ReleaseAdoptionRow[]
    {
        const rows: ReleaseAdoptionRow[] = []
        for (const hive of this.fleet)
        {
            const ownerLabel = FleetViewModel.OwnerLabel(hive)
            for (const env of hive.environments)
            {
                if (env.image !== undefined && env.image === this.manifest.image)
                {
                    rows.push({ hiveName: hive.displayName, ownerLabel, envName: env.name, ready: env.ready })
                }
            }
        }
        return rows
    }
}
