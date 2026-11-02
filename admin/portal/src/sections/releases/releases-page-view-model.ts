import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ManifestDto } from '../../portal-types.js'
import { ReleaseChannel } from '../../release-channel.js'
import { ReleasesViewModel, type ReleaseListRow } from '../../releases-view-model.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { PublishDialogViewModel } from './publish-dialog-view-model.js'
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

    public static Signature(manifest: ManifestDto): string
    {
        return manifest.signed === true ? ReleaseLabels.SignedLabel : ReleaseLabels.UnsignedLabel
    }

    public static Status(manifest: ManifestDto): string
    {
        return manifest.withdrawn === true ? ReleaseLabels.WithdrawnLabel : ReleaseLabels.PublishedLabel
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
        return this.manifest.image
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

// Registry & Releases: the published versions, newest first, with the
// environments observed running each. Publish a version opens a dialog.
export class ReleasesPageViewModel extends PortalPageViewModel
{
    private static readonly PublishTitle = 'Publish a version'

    private readonly rows = new ObservableCollection<ReleaseRowViewModel>()
    private readonly openCommand: RelayCommand
    private readonly publishCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: ReleasesSectionService)
    {
        super(session)
        this.openCommand = new RelayCommand(row => this.Open(row))
        this.publishCommand = this.MutatingCommand(() => this.Publish())
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

    public get PublishCommand(): RelayCommand
    {
        return this.publishCommand
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

    private Publish(): Promise<void>
    {
        return this.OpenCreate(this.section.Dialogs, dialogs => new PublishDialogViewModel(this.Session, dialogs),
            ReleasesPageViewModel.PublishTitle, () => this.Refresh())
    }
}
