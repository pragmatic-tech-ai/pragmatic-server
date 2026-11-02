import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantApiError } from '../../tenant-api-client.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import { PendingWork, type IHoldsPendingWork } from '../../shell/holds-pending-work.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { ReleasesSnapshot, UtcText } from './releases-snapshot.js'
import type { EnvStepEntry, OfferEntry } from './releases-snapshot.js'

// The adopt wizard's steps, in order.
export enum AdoptStep
{
    Version,
    Environments,
    Review,
    Outcome,
}

// How the adopt ended.
export enum AdoptOutcome
{
    Adopted,
    Refused,
    Unavailable,
    Failed,
}

// Where the adopt wizard sends the operator (its section).
export interface IAdoptNavigator
{
    // Leaves the wizard for the Releases page and reloads it.
    BackToReleases(): Promise<void>
    // Leaves the wizard (Cancel) without reloading.
    CancelAdopt(): void
    // Leaves the wizard and brings the Environments section to the front.
    ShowEnvironments(): void
}

// One entry of the wizard's step indicator.
export class AdoptStepViewModel extends Observable
{
    private static readonly IsCurrentProperty = 'IsCurrent'
    private static readonly IsNotCurrentProperty = 'IsNotCurrent'

    private current = false

    public constructor(public readonly Step: AdoptStep, private readonly label: string)
    {
        super()
    }

    public get Label(): string
    {
        return this.label
    }

    // The step's 1-based position.
    public get NumberText(): string
    {
        return String(this.Step + 1)
    }

    public get IsCurrent(): boolean
    {
        return this.current
    }

    public get IsNotCurrent(): boolean
    {
        return !this.current
    }

    public SetCurrent(next: boolean): void
    {
        const old = this.current
        if (old === next)
        {
            return
        }
        this.current = next
        this.RaisePropertyChanged(AdoptStepViewModel.IsCurrentProperty, old, next)
        this.RaisePropertyChanged(AdoptStepViewModel.IsNotCurrentProperty, !old, !next)
    }
}

// One environment in the Environments step: what adopting does to it.
export class AdoptEnvironmentRowViewModel extends Observable
{
    public constructor(private readonly entry: EnvStepEntry)
    {
        super()
    }

    public get Name(): string
    {
        return this.entry.EnvironmentName
    }

    public get Label(): string
    {
        return this.entry.Label
    }
}

// Adopt a version: a page of the Releases section, not a dialog. Steps
// Version (choose among the offered versions; preselected when opened for
// one), Environments (informational: adopt targets the whole hive, so every
// environment bound to it moves), Review (the impact, then Adopt <version>),
// Outcome (what the server answered). Adopt calls SelectTarget exactly once.
// While the operator is past the Version step and has not reached the
// Outcome, the page holds pending work: a cross-section open lands on it
// instead of discarding it.
export class AdoptWizardPageViewModel extends TenantPageViewModel implements IHoldsPendingWork
{
    private static readonly StepIndexProperty = 'StepIndex'
    private static readonly IsVersionStepProperty = 'IsVersionStep'
    private static readonly IsEnvironmentsStepProperty = 'IsEnvironmentsStep'
    private static readonly IsReviewStepProperty = 'IsReviewStep'
    private static readonly IsOutcomeStepProperty = 'IsOutcomeStep'
    private static readonly IsFormStepProperty = 'IsFormStep'
    private static readonly IsChoiceStepProperty = 'IsChoiceStep'
    private static readonly VersionsProperty = 'Versions'
    private static readonly SelectedVersionProperty = 'SelectedVersion'
    private static readonly VersionTextProperty = 'VersionText'
    private static readonly PublishedTextProperty = 'PublishedText'
    private static readonly NotesProperty = 'Notes'
    private static readonly EnvironmentsProperty = 'Environments'
    private static readonly HasEnvironmentsProperty = 'HasEnvironments'
    private static readonly HasNoEnvironmentsProperty = 'HasNoEnvironments'
    private static readonly ImpactTextProperty = 'ImpactText'
    private static readonly AdoptLabelProperty = 'AdoptLabel'
    private static readonly IsSubmittingProperty = 'IsSubmitting'
    private static readonly OutcomeProperty = 'Outcome'
    private static readonly OutcomeTitleProperty = 'OutcomeTitle'
    private static readonly OutcomeMessageProperty = 'OutcomeMessage'
    private static readonly IsAdoptedProperty = 'IsAdopted'
    private static readonly IsNotAdoptedProperty = 'IsNotAdopted'
    private static readonly StepLabels: readonly string[] = ['Version', 'Environments', 'Review', 'Outcome']
    private static readonly AdoptPrefix = 'Adopt '
    private static readonly PublishedPrefix = 'Published '
    private static readonly AdoptedText = 'Adopted: the hive now targets this version.'
    private static readonly RefusedText = 'Adopt was refused.'
    private static readonly UnavailableText = 'Adopt is unavailable right now.'
    private static readonly FailedText = 'The adopt could not be completed.'
    private static readonly NoOffersText = 'No versions are offered to your hive right now.'
    private static readonly NoHiveText = 'No hive yet. Versions are offered once your hive is installed.'
    private static readonly EmptyTextProperty = 'EmptyText'
    private static readonly NoText = ''
    private static readonly ConflictStatus = 409

    private readonly steps = new ObservableCollection<AdoptStepViewModel>()
    private readonly nextCommand: RelayCommand
    private readonly backStepCommand: RelayCommand
    private readonly cancelCommand: RelayCommand
    private readonly adoptCommand: RelayCommand
    private readonly backToReleasesCommand: RelayCommand
    private readonly backToEnvironmentsCommand: RelayCommand
    private snapshot: ReleasesSnapshot | undefined
    private hiveId: string | undefined
    private hasHive = true
    private step = AdoptStep.Version
    private versions = new ObservableCollection<OptionViewModel<string>>()
    private selected: OptionViewModel<string> | undefined
    private environments = new ObservableCollection<AdoptEnvironmentRowViewModel>()
    private submitted = false
    private submitting = false
    private outcome: AdoptOutcome | undefined
    private outcomeMessage = AdoptWizardPageViewModel.NoText

    public constructor(session: TenantSessionService, private readonly navigator: IAdoptNavigator, private readonly preselect?: string)
    {
        super(session)
        PendingWork.Register(this)
        AdoptWizardPageViewModel.StepLabels.forEach((label, i) => this.steps.Add(new AdoptStepViewModel(i as AdoptStep, label)))
        this.nextCommand = new RelayCommand(() => this.Next(), () => this.CanNext())
        this.backStepCommand = new RelayCommand(() => this.BackStep(), () => this.CanBackStep())
        this.cancelCommand = new RelayCommand(() => this.navigator.CancelAdopt(), () => this.IsFormStep && !this.submitting)
        this.adoptCommand = this.MutatingCommand(AdminCapability.Adopt, () => this.Adopt(), () => this.CanAdopt())
        this.backToReleasesCommand = new RelayCommand(() => { void this.navigator.BackToReleases() }, () => this.IsOutcomeStep)
        this.backToEnvironmentsCommand = new RelayCommand(() => this.navigator.ShowEnvironments(), () => this.IsOutcomeStep)
        this.SyncSteps()
    }

    public get HasPendingWork(): boolean
    {
        return this.step === AdoptStep.Environments || this.step === AdoptStep.Review
    }

    public get StepIndex(): AdoptStep
    {
        return this.step
    }

    public get Steps(): ObservableCollection<AdoptStepViewModel>
    {
        return this.steps
    }

    public get IsVersionStep(): boolean
    {
        return this.step === AdoptStep.Version
    }

    public get IsEnvironmentsStep(): boolean
    {
        return this.step === AdoptStep.Environments
    }

    public get IsReviewStep(): boolean
    {
        return this.step === AdoptStep.Review
    }

    public get IsOutcomeStep(): boolean
    {
        return this.step === AdoptStep.Outcome
    }

    // Any step before the Outcome (Cancel and Back show there).
    public get IsFormStep(): boolean
    {
        return this.step !== AdoptStep.Outcome
    }

    // Version and Environments (Next shows there).
    public get IsChoiceStep(): boolean
    {
        return this.step < AdoptStep.Review
    }

    // The offered versions, newest first.
    public get Versions(): ObservableCollection<OptionViewModel<string>>
    {
        return this.versions
    }

    public get SelectedVersion(): OptionViewModel<string> | undefined
    {
        return this.selected
    }

    public set SelectedVersion(next: OptionViewModel<string> | undefined)
    {
        if (next === this.selected || this.step !== AdoptStep.Version)
        {
            return
        }
        this.Select(next)
    }

    // The chosen version; '' when none.
    public get VersionText(): string
    {
        return this.selected?.Value ?? AdoptWizardPageViewModel.NoText
    }

    public get PublishedText(): string
    {
        const offer = this.SelectedOffer
        return offer === undefined ? AdoptWizardPageViewModel.NoText : AdoptWizardPageViewModel.PublishedPrefix + UtcText.Date(offer.Manifest.publishedAt)
    }

    public get Notes(): string
    {
        return this.SelectedOffer?.Manifest.notes ?? AdoptWizardPageViewModel.NoText
    }

    // What adopting the chosen version does to each environment.
    public get Environments(): ObservableCollection<AdoptEnvironmentRowViewModel>
    {
        return this.environments
    }

    public get HasEnvironments(): boolean
    {
        return this.environments.Count > 0
    }

    public get HasNoEnvironments(): boolean
    {
        return !this.HasEnvironments
    }

    public get ImpactText(): string
    {
        const version = this.selected?.Value
        return version === undefined || this.snapshot === undefined ? AdoptWizardPageViewModel.NoText : this.snapshot.Impact(version)
    }

    // The primary action's label: "Adopt <version>".
    public get AdoptLabel(): string
    {
        return AdoptWizardPageViewModel.AdoptPrefix + this.VersionText
    }

    public get IsSubmitting(): boolean
    {
        return this.submitting
    }

    public get Outcome(): AdoptOutcome | undefined
    {
        return this.outcome
    }

    public get OutcomeTitle(): string
    {
        switch (this.outcome)
        {
            case AdoptOutcome.Adopted:
                return AdoptWizardPageViewModel.AdoptedText
            case AdoptOutcome.Refused:
                return AdoptWizardPageViewModel.RefusedText
            case AdoptOutcome.Unavailable:
                return AdoptWizardPageViewModel.UnavailableText
            case AdoptOutcome.Failed:
                return AdoptWizardPageViewModel.FailedText
            default:
                return AdoptWizardPageViewModel.NoText
        }
    }

    // The server's message for a failed adopt, verbatim; '' on success.
    public get OutcomeMessage(): string
    {
        return this.outcomeMessage
    }

    public get IsAdopted(): boolean
    {
        return this.outcome === AdoptOutcome.Adopted
    }

    public get IsNotAdopted(): boolean
    {
        return this.outcome !== undefined && this.outcome !== AdoptOutcome.Adopted
    }

    public get EmptyText(): string
    {
        return this.hasHive ? AdoptWizardPageViewModel.NoOffersText : AdoptWizardPageViewModel.NoHiveText
    }

    public get NextCommand(): RelayCommand
    {
        return this.nextCommand
    }

    public get BackStepCommand(): RelayCommand
    {
        return this.backStepCommand
    }

    public get CancelCommand(): RelayCommand
    {
        return this.cancelCommand
    }

    public get AdoptCommand(): RelayCommand
    {
        return this.adoptCommand
    }

    public get BackToReleasesCommand(): RelayCommand
    {
        return this.backToReleasesCommand
    }

    public get BackToEnvironmentsCommand(): RelayCommand
    {
        return this.backToEnvironmentsCommand
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Adopt
    }

    // Loads the offers. Once submitted the page keeps what it shows: the
    // adopted version is no longer offered, and the Outcome must stay.
    protected override async LoadCore(): Promise<boolean>
    {
        if (this.submitted)
        {
            return true
        }
        const generation = this.LoadGeneration
        const hiveId = await this.Session.ResolveHiveId()
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        if (hiveId === undefined)
        {
            this.SetHasHive(false)
            return false
        }
        const snapshot = await ReleasesSnapshot.Load(this.Session.Client, hiveId)
        if (generation !== this.LoadGeneration || this.submitted)
        {
            return this.submitted
        }
        this.hiveId = hiveId
        this.SetHasHive(true)
        this.Apply(snapshot)
        return this.versions.Count > 0
    }

    private get SelectedOffer(): OfferEntry | undefined
    {
        const version = this.selected?.Value
        return version === undefined ? undefined : this.snapshot?.Offer(version)
    }

    // Rebuilds the version choices (a fresh collection: a realized ComboBox
    // ignores in-place changes), keeping the chosen version when it is still
    // offered; else the preselected one, else the newest. A chosen version
    // that is no longer offered sends the operator back to the Version step.
    private Apply(snapshot: ReleasesSnapshot): void
    {
        this.snapshot = snapshot
        const old = this.versions
        this.versions = new ObservableCollection<OptionViewModel<string>>()
        for (const offer of snapshot.Offers)
        {
            this.versions.Add(new OptionViewModel(offer.Version, offer.Version))
        }
        this.RaisePropertyChanged(AdoptWizardPageViewModel.VersionsProperty, old, this.versions)
        const options = this.versions.ToArray()
        const keep = this.selected?.Value ?? this.preselect
        const match = options.find(o => o.Value === keep)
        if (match === undefined && this.step !== AdoptStep.Version)
        {
            this.SetStep(AdoptStep.Version)
        }
        this.Select(match ?? options[0])
    }

    private Select(next: OptionViewModel<string> | undefined): void
    {
        const P = AdoptWizardPageViewModel
        const before = [this.VersionText, this.PublishedText, this.Notes, this.ImpactText, this.AdoptLabel, this.HasEnvironments] as const
        const oldSelected = this.selected
        const oldEnvironments = this.environments
        this.selected = next
        this.environments = new ObservableCollection<AdoptEnvironmentRowViewModel>()
        const version = next?.Value
        if (version !== undefined && this.snapshot !== undefined)
        {
            for (const entry of this.snapshot.EnvSteps(version))
            {
                this.environments.Add(new AdoptEnvironmentRowViewModel(entry))
            }
        }
        this.RaisePropertyChanged(P.SelectedVersionProperty, oldSelected, next)
        this.RaisePropertyChanged(P.VersionTextProperty, before[0], this.VersionText)
        this.RaisePropertyChanged(P.PublishedTextProperty, before[1], this.PublishedText)
        this.RaisePropertyChanged(P.NotesProperty, before[2], this.Notes)
        this.RaisePropertyChanged(P.ImpactTextProperty, before[3], this.ImpactText)
        this.RaisePropertyChanged(P.AdoptLabelProperty, before[4], this.AdoptLabel)
        this.RaisePropertyChanged(P.EnvironmentsProperty, oldEnvironments, this.environments)
        this.RaisePropertyChanged(P.HasEnvironmentsProperty, before[5], this.HasEnvironments)
        this.RaisePropertyChanged(P.HasNoEnvironmentsProperty, !before[5], this.HasNoEnvironments)
        this.RaiseCommands()
    }

    private CanNext(): boolean
    {
        return this.IsChoiceStep && this.selected !== undefined
    }

    private Next(): void
    {
        if (this.CanNext())
        {
            this.SetStep(this.step + 1)
        }
    }

    private CanBackStep(): boolean
    {
        return (this.step === AdoptStep.Environments || this.step === AdoptStep.Review) && !this.submitting
    }

    private BackStep(): void
    {
        if (this.CanBackStep())
        {
            this.SetStep(this.step - 1)
        }
    }

    private CanAdopt(): boolean
    {
        return this.step === AdoptStep.Review && this.selected !== undefined && this.hiveId !== undefined && !this.submitted
    }

    // Selects the hive's target once. A 401 propagates (the session expires);
    // every other failure is an Outcome with the server's message.
    private async Adopt(): Promise<void>
    {
        const version = this.selected?.Value
        const hiveId = this.hiveId
        if (!this.CanAdopt() || version === undefined || hiveId === undefined)
        {
            return
        }
        this.submitted = true
        this.SetSubmitting(true)
        let outcome = AdoptOutcome.Adopted
        let message = AdoptWizardPageViewModel.NoText
        try
        {
            await this.Session.Client.SelectTarget(hiveId, version)
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
            {
                this.SetSubmitting(false)
                throw e
            }
            outcome = AdoptWizardPageViewModel.OutcomeOf(e)
            message = e instanceof Error ? e.message : String(e)
        }
        this.SetSubmitting(false)
        this.SetOutcome(outcome, message)
        this.SetStep(AdoptStep.Outcome)
    }

    private static OutcomeOf(e: unknown): AdoptOutcome
    {
        if (e instanceof TenantApiError)
        {
            if (e.Status === AdoptWizardPageViewModel.ConflictStatus)
            {
                return AdoptOutcome.Refused
            }
            if (e.Status === TenantApiError.UnavailableStatus)
            {
                return AdoptOutcome.Unavailable
            }
        }
        return AdoptOutcome.Failed
    }

    private SetOutcome(outcome: AdoptOutcome, message: string): void
    {
        const P = AdoptWizardPageViewModel
        const before = [this.outcome, this.OutcomeTitle, this.outcomeMessage, this.IsAdopted, this.IsNotAdopted] as const
        this.outcome = outcome
        this.outcomeMessage = message
        this.RaisePropertyChanged(P.OutcomeProperty, before[0], this.outcome)
        this.RaisePropertyChanged(P.OutcomeTitleProperty, before[1], this.OutcomeTitle)
        this.RaisePropertyChanged(P.OutcomeMessageProperty, before[2], this.outcomeMessage)
        this.RaisePropertyChanged(P.IsAdoptedProperty, before[3], this.IsAdopted)
        this.RaisePropertyChanged(P.IsNotAdoptedProperty, before[4], this.IsNotAdopted)
    }

    private SetSubmitting(next: boolean): void
    {
        const old = this.submitting
        if (old === next)
        {
            return
        }
        this.submitting = next
        this.RaisePropertyChanged(AdoptWizardPageViewModel.IsSubmittingProperty, old, next)
        this.RaiseCommands()
    }

    private SetHasHive(next: boolean): void
    {
        const old = this.EmptyText
        this.hasHive = next
        this.RaisePropertyChanged(AdoptWizardPageViewModel.EmptyTextProperty, old, this.EmptyText)
    }

    private SetStep(next: AdoptStep): void
    {
        const old = this.step
        if (old === next)
        {
            return
        }
        const P = AdoptWizardPageViewModel
        const was = [this.IsVersionStep, this.IsEnvironmentsStep, this.IsReviewStep, this.IsOutcomeStep, this.IsFormStep, this.IsChoiceStep] as const
        this.step = next
        this.RaisePropertyChanged(P.StepIndexProperty, old, next)
        this.RaisePropertyChanged(P.IsVersionStepProperty, was[0], this.IsVersionStep)
        this.RaisePropertyChanged(P.IsEnvironmentsStepProperty, was[1], this.IsEnvironmentsStep)
        this.RaisePropertyChanged(P.IsReviewStepProperty, was[2], this.IsReviewStep)
        this.RaisePropertyChanged(P.IsOutcomeStepProperty, was[3], this.IsOutcomeStep)
        this.RaisePropertyChanged(P.IsFormStepProperty, was[4], this.IsFormStep)
        this.RaisePropertyChanged(P.IsChoiceStepProperty, was[5], this.IsChoiceStep)
        this.SyncSteps()
        this.RaiseCommands()
    }

    private SyncSteps(): void
    {
        for (const item of this.steps.ToArray())
        {
            item.SetCurrent(item.Step === this.step)
        }
    }

    private RaiseCommands(): void
    {
        this.nextCommand.RaiseCanExecuteChanged()
        this.backStepCommand.RaiseCanExecuteChanged()
        this.cancelCommand.RaiseCanExecuteChanged()
        this.backToReleasesCommand.RaiseCanExecuteChanged()
        this.backToEnvironmentsCommand.RaiseCanExecuteChanged()
        this.RaiseMutatingCommandsChanged()
    }
}
