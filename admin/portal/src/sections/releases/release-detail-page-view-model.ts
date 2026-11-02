import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { FleetViewModel } from '../../fleet-view-model.js'
import { PortalDates } from '../../portal-dates.js'
import type { FleetEnvDto, FleetHiveDto, ManifestDto } from '../../portal-types.js'
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

// One version's detail: its manifest, signature, what's new, and where it runs
// (observed, read-only). Withdraw asks for the version and a reason; Restore
// returns a withdrawn version to offers.
export class ReleaseDetailPageViewModel extends PortalPageViewModel
{
    private static readonly NotFoundTemplate = 'Version {id} was not found.'
    private static readonly IdToken = '{id}'
    private static readonly NoNotesLabel = 'No release notes.'
    private static readonly NoDigestLabel = '-'
    private static readonly DigestSeparator = ':'
    private static readonly DigestLength = 12
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
    private static readonly WithdrawnTextProperty = 'WithdrawnText'
    private static readonly HasAdoptionProperty = 'HasAdoption'
    private static readonly HasNoAdoptionProperty = 'HasNoAdoption'

    private manifest: ManifestDto | undefined
    private readonly adoptionRows = new ObservableCollection<ReleaseAdoptionRowViewModel>()
    private readonly withdrawCommand: RelayCommand
    private readonly restoreCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: ReleasesSectionService, public readonly Version: string)
    {
        super(session)
        this.withdrawCommand = this.MutatingCommand(() => this.Withdraw(), () => this.manifest !== undefined && !this.IsWithdrawn)
        this.restoreCommand = this.MutatingCommand(() => this.Restore(), () => this.IsWithdrawn)
    }

    public get Image(): string
    {
        return this.manifest?.image ?? ''
    }

    // The image digest's first characters; '-' when the registry recorded none.
    public get DigestLabel(): string
    {
        const digest = this.manifest?.digest
        if (digest === undefined || digest.length === 0)
        {
            return ReleaseDetailPageViewModel.NoDigestLabel
        }
        return digest.slice(digest.lastIndexOf(ReleaseDetailPageViewModel.DigestSeparator) + 1).slice(0, ReleaseDetailPageViewModel.DigestLength)
    }

    public get ChannelLabel(): string
    {
        return ReleaseChannel.Label(this.manifest?.channel)
    }

    public get SignatureLabel(): string
    {
        return this.manifest === undefined ? '' : ReleaseLabels.Signature(this.manifest)
    }

    public get StatusLabel(): string
    {
        return this.manifest === undefined ? '' : ReleaseLabels.Status(this.manifest)
    }

    public get PublishedLabel(): string
    {
        return this.manifest === undefined ? '' : PortalDates.Label(this.manifest.publishedAt)
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

    // The withdrawn notice with its provenance; '' while published.
    public get WithdrawnText(): string
    {
        const manifest = this.manifest
        if (manifest?.withdrawn !== true)
        {
            return ''
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

    public get BackCommand(): RelayCommand
    {
        return this.section.BackCommand
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
        this.adoptionRows.Clear()
        for (const hive of fleet)
        {
            for (const env of hive.environments)
            {
                if (env.image !== undefined && env.image === manifest.image)
                {
                    this.adoptionRows.Add(new ReleaseAdoptionRowViewModel(hive, env))
                }
            }
        }
        return true
    }

    // Takes a (re)loaded or just-changed manifest and raises what it changed.
    private Apply(manifest: ManifestDto): void
    {
        const P = ReleaseDetailPageViewModel
        const before = [this.Image, this.DigestLabel, this.ChannelLabel, this.SignatureLabel, this.StatusLabel,
            this.PublishedLabel, this.NotesLabel, this.WithdrawnText] as const
        const wasWithdrawn = this.IsWithdrawn
        const hadAdoption = this.HasAdoption
        // A private copy: what was shown stays as it was until the next Apply.
        this.manifest = { ...manifest }
        this.RaisePropertyChanged(P.ImageProperty, before[0], this.Image)
        this.RaisePropertyChanged(P.DigestLabelProperty, before[1], this.DigestLabel)
        this.RaisePropertyChanged(P.ChannelLabelProperty, before[2], this.ChannelLabel)
        this.RaisePropertyChanged(P.SignatureLabelProperty, before[3], this.SignatureLabel)
        this.RaisePropertyChanged(P.StatusLabelProperty, before[4], this.StatusLabel)
        this.RaisePropertyChanged(P.PublishedLabelProperty, before[5], this.PublishedLabel)
        this.RaisePropertyChanged(P.NotesLabelProperty, before[6], this.NotesLabel)
        this.RaisePropertyChanged(P.WithdrawnTextProperty, before[7], this.WithdrawnText)
        this.RaisePropertyChanged(P.IsWithdrawnProperty, wasWithdrawn, this.IsWithdrawn)
        this.RaisePropertyChanged(P.HasAdoptionProperty, hadAdoption, this.HasAdoption)
        this.RaisePropertyChanged(P.HasNoAdoptionProperty, !hadAdoption, this.HasNoAdoption)
        this.withdrawCommand.RaiseCanExecuteChanged()
        this.restoreCommand.RaiseCanExecuteChanged()
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
