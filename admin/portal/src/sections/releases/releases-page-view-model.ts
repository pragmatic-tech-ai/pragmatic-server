import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ReleaseVerification, type ManifestDto, type ReleaseRefreshDto } from '../../portal-types.js'
import { ReleaseChannel } from '../../release-channel.js'
import { ReleasesViewModel, type ReleaseListRow } from '../../releases-view-model.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import type { ReleasesSectionService } from './releases-section-service.js'

// Labels shared by the releases list and a release's detail.
export class ReleaseLabels
{
    private static readonly SignedLabel = 'Signed'
    private static readonly UnsignedLabel = 'Unsigned'
    private static readonly PublishedLabel = 'Published'
    private static readonly WithdrawnLabel = 'Withdrawn'
    private static readonly NotRunningLabel = 'Not running anywhere'
    private static readonly OneEnvironmentLabel = '1 environment'
    private static readonly EnvironmentsTemplate = '{n} environments'
    private static readonly CountToken = '{n}'
    private static readonly VerifiedLabel = 'Verified'
    private static readonly RejectedLabel = 'Rejected'
    // A value the record does not have: a local manifest's verification, a rejected release's image or digest.
    public static readonly NoValue = '—'
    private static readonly DigestSeparator = ':'
    private static readonly DigestLength = 12
    private static readonly CommitLength = 7

    public static Signature(manifest: ManifestDto): string
    {
        return manifest.signed === true ? ReleaseLabels.SignedLabel : ReleaseLabels.UnsignedLabel
    }

    public static Status(manifest: ManifestDto): string
    {
        return manifest.withdrawn === true ? ReleaseLabels.WithdrawnLabel : ReleaseLabels.PublishedLabel
    }

    // Verified / Rejected for a registry release; a dash for a local manifest, which was never verified.
    public static Verification(manifest: ManifestDto): string
    {
        switch (manifest.release?.state)
        {
            case ReleaseVerification.Verified:
                return ReleaseLabels.VerifiedLabel
            case ReleaseVerification.Rejected:
                return ReleaseLabels.RejectedLabel
            default:
                return ReleaseLabels.NoValue
        }
    }

    // The image reference; a dash when there is none (a rejected release records no image).
    public static Image(manifest: ManifestDto): string
    {
        return manifest.image.length > 0 ? manifest.image : ReleaseLabels.NoValue
    }

    // A digest's hash, algorithm dropped, to its first characters.
    public static ShortDigest(digest: string): string
    {
        return digest.slice(digest.lastIndexOf(ReleaseLabels.DigestSeparator) + 1).slice(0, ReleaseLabels.DigestLength)
    }

    // A git commit as git abbreviates it.
    public static ShortCommit(commit: string): string
    {
        return commit.slice(0, ReleaseLabels.CommitLength)
    }

    // How many observed environments run the version.
    public static Adoption(count: number): string
    {
        if (count === 0)
        {
            return ReleaseLabels.NotRunningLabel
        }
        return count === 1 ? ReleaseLabels.OneEnvironmentLabel : ReleaseLabels.EnvironmentsTemplate.replace(ReleaseLabels.CountToken, String(count))
    }
}

// One releases-table row; the version opens its detail.
export class ReleaseRowViewModel extends Observable
{
    private readonly openCommand: RelayCommand

    public constructor(private readonly manifest: ManifestDto, private readonly row: ReleaseListRow, open: RelayCommand)
    {
        super()
        this.openCommand = new RelayCommand(() => open.Execute(this))
    }

    public get Version(): string
    {
        return this.manifest.id
    }

    public get Image(): string
    {
        return ReleaseLabels.Image(this.manifest)
    }

    public get VerificationLabel(): string
    {
        return ReleaseLabels.Verification(this.manifest)
    }

    public get ChannelLabel(): string
    {
        return ReleaseChannel.Label(this.manifest.channel)
    }

    public get SignatureLabel(): string
    {
        return ReleaseLabels.Signature(this.manifest)
    }

    public get StatusLabel(): string
    {
        return ReleaseLabels.Status(this.manifest)
    }

    public get PublishedLabel(): string
    {
        return this.row.publishedLabel
    }

    public get AdoptionLabel(): string
    {
        return ReleaseLabels.Adoption(this.row.observedEnvCount)
    }

    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }
}

// Registry & Releases: the versions, newest first, with the environments
// observed running each. Versions come from the release registry: Refresh from
// registry imports (and verifies) what is new, then reloads the list.
export class ReleasesPageViewModel extends PortalPageViewModel
{
    private static readonly RefreshResultTextProperty = 'RefreshResultText'
    private static readonly ResultTemplate = 'Imported {imported}, rejected {rejected}'
    private static readonly ShadowedTemplate = ', shadowed {shadowed}'
    private static readonly ImportedToken = '{imported}'
    private static readonly RejectedToken = '{rejected}'
    private static readonly ShadowedToken = '{shadowed}'
    private static readonly NoText = ''

    // "Imported N, rejected M", plus ", shadowed K" when local manifests hid some registry versions.
    public static ResultText(result: ReleaseRefreshDto): string
    {
        const P = ReleasesPageViewModel
        const text = P.ResultTemplate
            .replace(P.ImportedToken, String(result.imported.length))
            .replace(P.RejectedToken, String(result.rejected.length))
        return result.shadowed.length > 0 ? text + P.ShadowedTemplate.replace(P.ShadowedToken, String(result.shadowed.length)) : text
    }

    private readonly rows = new ObservableCollection<ReleaseRowViewModel>()
    private readonly openCommand: RelayCommand
    private readonly refreshFromRegistryCommand: RelayCommand
    private refreshResultText = ReleasesPageViewModel.NoText

    public constructor(session: PortalSessionService, private readonly section: ReleasesSectionService)
    {
        super(session)
        this.openCommand = new RelayCommand(row => this.Open(row))
        this.refreshFromRegistryCommand = this.MutatingCommand(() => this.RefreshFromRegistry())
    }

    // What the last refresh from the registry did; '' before one, or when it failed (CommandErrorText says why).
    public get RefreshResultText(): string
    {
        return this.refreshResultText
    }

    public get Rows(): ObservableCollection<ReleaseRowViewModel>
    {
        return this.rows
    }

    // Opens a row's release detail; the parameter is the ReleaseRowViewModel.
    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }

    public get RefreshFromRegistryCommand(): RelayCommand
    {
        return this.refreshFromRegistryCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const api = this.Session.Client
        const [manifests, fleet] = await Promise.all([api.ListManifests(), api.ListFleet()])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        const byId = new Map<string, ManifestDto>(manifests.map(m => [m.id, m]))
        this.rows.Clear()
        for (const row of new ReleasesViewModel(manifests, fleet).Rows)
        {
            const manifest = byId.get(row.id)
            if (manifest !== undefined)
            {
                this.rows.Add(new ReleaseRowViewModel(manifest, row, this.openCommand))
            }
        }
        return this.rows.Count > 0
    }

    private Open(row: unknown): void
    {
        if (row instanceof ReleaseRowViewModel)
        {
            this.section.OpenRelease(row.Version)
        }
    }

    // Clears the last result first, so a failure never leaves stale counts next to its error.
    private async RefreshFromRegistry(): Promise<void>
    {
        this.SetRefreshResultText(ReleasesPageViewModel.NoText)
        const result = await this.Session.Client.RefreshReleases()
        this.SetRefreshResultText(ReleasesPageViewModel.ResultText(result))
        await this.Refresh()
    }

    private SetRefreshResultText(next: string): void
    {
        const old = this.refreshResultText
        if (old === next)
        {
            return
        }
        this.refreshResultText = next
        this.RaisePropertyChanged(ReleasesPageViewModel.RefreshResultTextProperty, old, next)
    }
}
