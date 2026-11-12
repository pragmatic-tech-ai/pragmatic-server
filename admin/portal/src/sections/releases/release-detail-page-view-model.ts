import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { FleetViewModel } from '../../fleet-view-model.js'
import { PortalDates } from '../../portal-dates.js'
import { ReleaseVerification, type FleetEnvDto, type FleetHiveDto, type ManifestDto, type ReleaseApp } from '../../portal-types.js'
import { ReleaseApps } from '../../release-apps.js'
import { ReleaseChannel } from '../../release-channel.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { ReleaseLabels } from './releases-page-view-model.js'
import type { ReleasesSectionService } from './releases-section-service.js'

// One environment observed running the version (reported by its hive).
export class ReleaseAdoptionRowViewModel extends Observable
{
    private static readonly ReadyLabel = 'Ready'
    private static readonly NotReadyLabel = 'Not ready'

    private readonly ownerLabel: string

    public constructor(private readonly hive: FleetHiveDto, private readonly env: FleetEnvDto)
    {
        super()
        this.ownerLabel = FleetViewModel.OwnerLabel(hive)
    }

    public get HiveName(): string
    {
        return this.hive.displayName
    }

    public get OwnerLabel(): string
    {
        return this.ownerLabel
    }

    public get Environment(): string
    {
        return this.env.name
    }

    public get ReadyLabel(): string
    {
        return this.env.ready ? ReleaseAdoptionRowViewModel.ReadyLabel : ReleaseAdoptionRowViewModel.NotReadyLabel
    }
}

// One image of a registry release: its app, repository and digest (short, the
// full digest on hover).
export class ReleaseImageRowViewModel extends Observable
{
    public constructor(public readonly App: ReleaseApp, public readonly Repository: string, public readonly Digest: string)
    {
        super()
    }

    public get DigestLabel(): string
    {
        return ReleaseLabels.ShortDigest(this.Digest)
    }
}

// One sibling repository a release was built from, at its commit (short, the
// full sha on hover).
export class ReleaseSiblingCommitRowViewModel extends Observable
{
    public constructor(public readonly Repo: string, public readonly Commit: string)
    {
        super()
    }

    public get CommitShort(): string
    {
        return ReleaseLabels.ShortCommit(this.Commit)
    }
}

// One version's detail: its manifest, signature, what's new, and where it runs
// (observed, read-only). A version imported from the release registry also
// shows its provenance: verification, build time, commits, signer and its
// images (or why it was rejected). Withdraw asks for the version and a reason;
// Restore returns a withdrawn version to offers.
export class ReleaseDetailPageViewModel extends PortalPageViewModel
{
    private static readonly NotFoundTemplate = 'Version {id} was not found.'
    private static readonly IdToken = '{id}'
    private static readonly NoNotesLabel = 'No release notes.'
    private static readonly WithdrawnNotice = 'This version is withdrawn. Hives stop seeing it as adoptable after their next check-in. Environments already running it keep running it until their tenant adopts another version.'
    private static readonly WithdrawalTemplate = ' Reason: {reason} (withdrawn by {actor} on {date}).'
    private static readonly ReasonToken = '{reason}'
    private static readonly ActorToken = '{actor}'
    private static readonly DateToken = '{date}'
    private static readonly WithdrawTitle = 'Withdraw this version?'
    private static readonly WithdrawMessage = 'Withdrawing removes this version from every offer. It does not reach into hives: environments already on it keep running it until their tenant adopts another version. You can restore it later.'
    private static readonly WithdrawLabel = 'Withdraw'
    private static readonly ReasonLabel = 'Reason (recorded with the withdrawal)'
    private static readonly ImageProperty = 'Image'
    private static readonly DigestLabelProperty = 'DigestLabel'
    private static readonly ChannelLabelProperty = 'ChannelLabel'
    private static readonly SignatureLabelProperty = 'SignatureLabel'
    private static readonly StatusLabelProperty = 'StatusLabel'
    private static readonly PublishedLabelProperty = 'PublishedLabel'
    private static readonly NotesLabelProperty = 'NotesLabel'
    private static readonly IsWithdrawnProperty = 'IsWithdrawn'
    private static readonly IsPublishedProperty = 'IsPublished'
    private static readonly NoText = ''
    private static readonly WithdrawnTextProperty = 'WithdrawnText'
    private static readonly HasAdoptionProperty = 'HasAdoption'
    private static readonly HasNoAdoptionProperty = 'HasNoAdoption'
    private static readonly HasReleaseProperty = 'HasRelease'
    private static readonly IsRejectedProperty = 'IsRejected'
    private static readonly IsVerifiedProperty = 'IsVerified'
    private static readonly VerificationLabelProperty = 'VerificationLabel'
    private static readonly BuiltAtLabelProperty = 'BuiltAtLabel'
    private static readonly ServerCommitProperty = 'ServerCommit'
    private static readonly ServerCommitShortProperty = 'ServerCommitShort'
    private static readonly SigningKeyIdProperty = 'SigningKeyId'
    private static readonly RejectedReasonProperty = 'RejectedReason'
    private static readonly HasImagesProperty = 'HasImages'
    private static readonly HasSiblingCommitsProperty = 'HasSiblingCommits'

    private manifest: ManifestDto | undefined
    private readonly adoptionRows = new ObservableCollection<ReleaseAdoptionRowViewModel>()
    private readonly imageRows = new ObservableCollection<ReleaseImageRowViewModel>()
    private readonly siblingCommitRows = new ObservableCollection<ReleaseSiblingCommitRowViewModel>()
    private readonly withdrawCommand: RelayCommand
    private readonly restoreCommand: RelayCommand
    private readonly backCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: ReleasesSectionService, public readonly Version: string)
    {
        super(session)
        this.withdrawCommand = this.MutatingCommand(() => this.Withdraw(), () => this.manifest !== undefined && !this.IsWithdrawn)
        this.restoreCommand = this.MutatingCommand(() => this.Restore(), () => this.IsWithdrawn)
        this.backCommand = new RelayCommand(() => { void this.section.BackAndRefresh() })
    }

    // The image reference; a dash for a rejected release, which records none.
    public get Image(): string
    {
        return this.manifest === undefined ? ReleaseDetailPageViewModel.NoText : ReleaseLabels.Image(this.manifest)
    }

    // The image digest's first characters; a dash when the registry recorded none.
    public get DigestLabel(): string
    {
        const digest = this.manifest?.digest
        if (digest === undefined || digest.length === 0)
        {
            return ReleaseLabels.NoValue
        }
        return ReleaseLabels.ShortDigest(digest)
    }

    // Whether the version came from the release registry (a local manifest has no provenance to show).
    public get HasRelease(): boolean
    {
        return this.manifest?.release !== undefined
    }

    public get IsRejected(): boolean
    {
        return this.manifest?.release?.state === ReleaseVerification.Rejected
    }

    // A verified registry release: its build provenance (built-at, commit, signer) is shown.
    public get IsVerified(): boolean
    {
        return this.manifest?.release?.state === ReleaseVerification.Verified
    }

    public get VerificationLabel(): string
    {
        return this.manifest === undefined ? ReleaseDetailPageViewModel.NoText : ReleaseLabels.Verification(this.manifest)
    }

    // When the release was built, to the minute (UTC).
    public get BuiltAtLabel(): string
    {
        const builtAt = this.manifest?.release?.builtAt
        return builtAt === undefined ? ReleaseDetailPageViewModel.NoText : PortalDates.DateTimeLabel(builtAt)
    }

    // The full pragmatic-server commit the release was tagged on (the hover text of ServerCommitShort).
    public get ServerCommit(): string
    {
        return this.manifest?.release?.serverCommit ?? ReleaseDetailPageViewModel.NoText
    }

    public get ServerCommitShort(): string
    {
        return ReleaseLabels.ShortCommit(this.ServerCommit)
    }

    // The id of the release key that signed the images.
    public get SigningKeyId(): string
    {
        return this.manifest?.release?.signingKeyId ?? ReleaseDetailPageViewModel.NoText
    }

    // Why verification failed; '' unless Rejected.
    public get RejectedReason(): string
    {
        const reason = this.IsRejected ? this.manifest?.release?.rejectedReason : undefined
        return reason ?? ReleaseDetailPageViewModel.NoText
    }

    // The release's images, in release order.
    public get ImageRows(): ObservableCollection<ReleaseImageRowViewModel>
    {
        return this.imageRows
    }

    public get HasImages(): boolean
    {
        return this.imageRows.Count > 0
    }

    // The sibling repositories the release was built from, by name.
    public get SiblingCommitRows(): ObservableCollection<ReleaseSiblingCommitRowViewModel>
    {
        return this.siblingCommitRows
    }

    public get HasSiblingCommits(): boolean
    {
        return this.siblingCommitRows.Count > 0
    }

    public get ChannelLabel(): string
    {
        return ReleaseChannel.Label(this.manifest?.channel)
    }

    public get SignatureLabel(): string
    {
        return this.manifest === undefined ? ReleaseDetailPageViewModel.NoText : ReleaseLabels.Signature(this.manifest)
    }

    public get StatusLabel(): string
    {
        return this.manifest === undefined ? ReleaseDetailPageViewModel.NoText : ReleaseLabels.Status(this.manifest)
    }

    public get PublishedLabel(): string
    {
        return this.manifest === undefined ? ReleaseDetailPageViewModel.NoText : PortalDates.Label(this.manifest.publishedAt)
    }

    public get NotesLabel(): string
    {
        const notes = this.manifest?.notes
        return notes !== undefined && notes.length > 0 ? notes : ReleaseDetailPageViewModel.NoNotesLabel
    }

    public get IsWithdrawn(): boolean
    {
        return this.manifest?.withdrawn === true
    }

    // Loaded and not withdrawn: the page offers Withdraw (Restore otherwise).
    public get IsPublished(): boolean
    {
        return this.manifest !== undefined && !this.IsWithdrawn
    }

    // The withdrawn notice with its provenance; '' while published.
    public get WithdrawnText(): string
    {
        const manifest = this.manifest
        if (manifest?.withdrawn !== true)
        {
            return ReleaseDetailPageViewModel.NoText
        }
        const w = manifest.withdrawal
        if (w === undefined)
        {
            return ReleaseDetailPageViewModel.WithdrawnNotice
        }
        const P = ReleaseDetailPageViewModel
        return P.WithdrawnNotice + P.WithdrawalTemplate
            .replace(P.ReasonToken, w.reason)
            .replace(P.ActorToken, w.actor)
            .replace(P.DateToken, PortalDates.Label(w.at))
    }

    public get AdoptionRows(): ObservableCollection<ReleaseAdoptionRowViewModel>
    {
        return this.adoptionRows
    }

    public get HasAdoption(): boolean
    {
        return this.adoptionRows.Count > 0
    }

    public get HasNoAdoption(): boolean
    {
        return this.adoptionRows.Count === 0
    }

    // Back to the list, reloaded: a withdraw or restore here changed it.
    public get BackCommand(): RelayCommand
    {
        return this.backCommand
    }

    public get WithdrawCommand(): RelayCommand
    {
        return this.withdrawCommand
    }

    public get RestoreCommand(): RelayCommand
    {
        return this.restoreCommand
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
        const manifest = manifests.find(m => m.id === this.Version)
        if (manifest === undefined)
        {
            throw new Error(ReleaseDetailPageViewModel.NotFoundTemplate.replace(ReleaseDetailPageViewModel.IdToken, this.Version))
        }
        this.Apply(manifest)
        const hadAdoption = this.HasAdoption
        this.adoptionRows.Clear()
        for (const hive of fleet)
        {
            for (const env of hive.environments)
            {
                // A rejected release has no image, so nothing can be running it.
                if (manifest.image.length > 0 && env.image !== undefined && env.image === manifest.image)
                {
                    this.adoptionRows.Add(new ReleaseAdoptionRowViewModel(hive, env))
                }
            }
        }
        // Raised only once the rows are in: the flags read the row count.
        this.RaisePropertyChanged(ReleaseDetailPageViewModel.HasAdoptionProperty, hadAdoption, this.HasAdoption)
        this.RaisePropertyChanged(ReleaseDetailPageViewModel.HasNoAdoptionProperty, !hadAdoption, this.HasNoAdoption)
        return true
    }

    // Takes a (re)loaded or just-changed manifest and raises what it changed.
    private Apply(manifest: ManifestDto): void
    {
        const P = ReleaseDetailPageViewModel
        const before = [this.Image, this.DigestLabel, this.ChannelLabel, this.SignatureLabel, this.StatusLabel,
            this.PublishedLabel, this.NotesLabel, this.WithdrawnText] as const
        const releaseBefore = [this.VerificationLabel, this.BuiltAtLabel, this.ServerCommit, this.ServerCommitShort,
            this.SigningKeyId, this.RejectedReason] as const
        const flagsBefore = [this.HasRelease, this.IsRejected, this.IsVerified, this.HasImages, this.HasSiblingCommits] as const
        const wasWithdrawn = this.IsWithdrawn
        const wasPublished = this.IsPublished
        // A private copy: what was shown stays as it was until the next Apply.
        this.manifest = { ...manifest }
        this.FillRelease(manifest)
        this.RaisePropertyChanged(P.ImageProperty, before[0], this.Image)
        this.RaisePropertyChanged(P.DigestLabelProperty, before[1], this.DigestLabel)
        this.RaisePropertyChanged(P.ChannelLabelProperty, before[2], this.ChannelLabel)
        this.RaisePropertyChanged(P.SignatureLabelProperty, before[3], this.SignatureLabel)
        this.RaisePropertyChanged(P.StatusLabelProperty, before[4], this.StatusLabel)
        this.RaisePropertyChanged(P.PublishedLabelProperty, before[5], this.PublishedLabel)
        this.RaisePropertyChanged(P.NotesLabelProperty, before[6], this.NotesLabel)
        this.RaisePropertyChanged(P.WithdrawnTextProperty, before[7], this.WithdrawnText)
        this.RaisePropertyChanged(P.IsWithdrawnProperty, wasWithdrawn, this.IsWithdrawn)
        this.RaisePropertyChanged(P.IsPublishedProperty, wasPublished, this.IsPublished)
        this.RaisePropertyChanged(P.VerificationLabelProperty, releaseBefore[0], this.VerificationLabel)
        this.RaisePropertyChanged(P.BuiltAtLabelProperty, releaseBefore[1], this.BuiltAtLabel)
        this.RaisePropertyChanged(P.ServerCommitProperty, releaseBefore[2], this.ServerCommit)
        this.RaisePropertyChanged(P.ServerCommitShortProperty, releaseBefore[3], this.ServerCommitShort)
        this.RaisePropertyChanged(P.SigningKeyIdProperty, releaseBefore[4], this.SigningKeyId)
        this.RaisePropertyChanged(P.RejectedReasonProperty, releaseBefore[5], this.RejectedReason)
        this.RaisePropertyChanged(P.HasReleaseProperty, flagsBefore[0], this.HasRelease)
        this.RaisePropertyChanged(P.IsRejectedProperty, flagsBefore[1], this.IsRejected)
        this.RaisePropertyChanged(P.IsVerifiedProperty, flagsBefore[2], this.IsVerified)
        this.RaisePropertyChanged(P.HasImagesProperty, flagsBefore[3], this.HasImages)
        this.RaisePropertyChanged(P.HasSiblingCommitsProperty, flagsBefore[4], this.HasSiblingCommits)
        this.withdrawCommand.RaiseCanExecuteChanged()
        this.restoreCommand.RaiseCanExecuteChanged()
    }

    // Refills the image and sibling-commit rows from the release (none for a local manifest).
    private FillRelease(manifest: ManifestDto): void
    {
        this.imageRows.Clear()
        this.siblingCommitRows.Clear()
        const release = manifest.release
        if (release === undefined)
        {
            return
        }
        const images: Partial<Record<ReleaseApp, { repository: string; digest: string }>> = release.images ?? {}
        for (const app of ReleaseApps.All)
        {
            const image = images[app]
            if (image !== undefined)
            {
                this.imageRows.Add(new ReleaseImageRowViewModel(app, image.repository, image.digest))
            }
        }
        const siblings = release.siblingCommits ?? {}
        for (const repo of Object.keys(siblings).sort((a, b) => a.localeCompare(b)))
        {
            this.siblingCommitRows.Add(new ReleaseSiblingCommitRowViewModel(repo, siblings[repo] as string))
        }
    }

    private Withdraw(): Promise<void>
    {
        return this.ConfirmByName(this.section.Dialogs, {
            Expected: this.Version,
            Title: ReleaseDetailPageViewModel.WithdrawTitle,
            Message: ReleaseDetailPageViewModel.WithdrawMessage,
            ConfirmLabel: ReleaseDetailPageViewModel.WithdrawLabel,
            ReasonLabel: ReleaseDetailPageViewModel.ReasonLabel,
            Action: async (reason) => { this.Apply(await this.Session.Client.SetManifestWithdrawn(this.Version, true, reason)) },
            OnConfirmed: () => Promise.resolve(),
        })
    }

    private async Restore(): Promise<void>
    {
        this.Apply(await this.Session.Client.SetManifestWithdrawn(this.Version, false))
    }
}
