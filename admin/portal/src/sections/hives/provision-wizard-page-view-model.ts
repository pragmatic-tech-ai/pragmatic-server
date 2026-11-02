import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../../api-client.js'
import type { HiveClusterBackend, HiveProvisionMode } from '../../portal-types.js'
import { ProvisionWizardViewModel, WizardStep } from '../../provision-wizard-view-model.js'
import type { OptionViewModel } from '../../shell/option-view-model.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { HiveOptions } from './hive-options.js'
import type { HivesSectionService } from './hives-section-service.js'

// The wizard's steps, in order. Bootstrap is the one-time reveal that
// follows a successful provision.
export enum ProvisionStep
{
    Client,
    Tenant,
    Hive,
    Review,
    Bootstrap,
}

// One entry of the wizard's step indicator.
export class ProvisionStepViewModel extends Observable
{
    private static readonly IsCurrentProperty = 'IsCurrent'
    private static readonly IsNotCurrentProperty = 'IsNotCurrent'

    private current = false

    public constructor(public readonly Step: ProvisionStep, private readonly label: string)
    {
        super()
    }

    public get Label(): string
    {
        return this.label
    }

    // The step's 1-based position, for the indicator.
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
        this.RaisePropertyChanged(ProvisionStepViewModel.IsCurrentProperty, old, next)
        this.RaisePropertyChanged(ProvisionStepViewModel.IsNotCurrentProperty, !old, !next)
    }
}

// Stand up a hive: one provision call creates a Client, its Tenant (with a
// first Owner) and the Tenant's Hive. A page of the Hives section, not a
// dialog: it ends on the Bootstrap step, which shows the Owner password and
// the agent token once. Finish needs both "I've saved it" flags, clears both
// values and moves on to the new hive's detail. Leaving through the rail
// first keeps this page, with its values, as the section's current page.
// The values are never logged and live nowhere else; the provision result
// itself is not kept.
export class ProvisionWizardPageViewModel extends PortalPageViewModel
{
    private static readonly ClientLabel = 'Client'
    private static readonly TenantLabel = 'Tenant'
    private static readonly HiveLabel = 'Hive'
    private static readonly ReviewLabel = 'Review'
    private static readonly BootstrapLabel = 'Bootstrap'
    private static readonly SummarySeparator = ' / '
    private static readonly FailedPrefix = 'Provisioning failed: '
    private static readonly RolledBackPrefix = ' Rolled back: '
    private static readonly ResiduePrefix = ' Residue (needs manual cleanup): '
    private static readonly ListSeparator = ', '
    private static readonly SentenceEnd = '.'
    private static readonly CopiedText = 'Copied.'
    private static readonly CopyFailedText = 'Could not copy. Select the value and copy it by hand.'
    private static readonly NoText = ''
    private static readonly StepIndexProperty = 'StepIndex'
    private static readonly IsClientStepProperty = 'IsClientStep'
    private static readonly IsTenantStepProperty = 'IsTenantStep'
    private static readonly IsHiveStepProperty = 'IsHiveStep'
    private static readonly IsReviewStepProperty = 'IsReviewStep'
    private static readonly IsBootstrapStepProperty = 'IsBootstrapStep'
    private static readonly IsFormStepProperty = 'IsFormStep'
    private static readonly IsInputStepProperty = 'IsInputStep'
    private static readonly IsSubmittingProperty = 'IsSubmitting'
    private static readonly WizardErrorTextProperty = 'ErrorText'
    private static readonly SelectedBackendProperty = 'SelectedBackend'
    private static readonly SelectedClusterModeProperty = 'SelectedClusterMode'
    private static readonly SelectedRegistryModeProperty = 'SelectedRegistryMode'
    private static readonly ClusterSummaryProperty = 'ClusterSummary'
    private static readonly RegistrySummaryProperty = 'RegistrySummary'
    private static readonly ProvisionedHiveIdProperty = 'ProvisionedHiveId'
    private static readonly OwnerPasswordProperty = 'OwnerPassword'
    private static readonly AgentTokenProperty = 'AgentToken'
    private static readonly OwnerSavedProperty = 'OwnerSaved'
    private static readonly AgentSavedProperty = 'AgentSaved'
    private static readonly CopyStatusProperty = 'CopyStatus'

    // The form state, validation and request shape (shared with the legacy view).
    private readonly form: ProvisionWizardViewModel
    private readonly stepLabels: readonly string[]
    private readonly steps = new ObservableCollection<ProvisionStepViewModel>()
    private readonly backends = new ObservableCollection<OptionViewModel<HiveClusterBackend>>()
    private readonly clusterModes = new ObservableCollection<OptionViewModel<HiveProvisionMode>>()
    private readonly registryModes = new ObservableCollection<OptionViewModel<HiveProvisionMode>>()
    private readonly nextCommand: RelayCommand
    private readonly backStepCommand: RelayCommand
    private readonly cancelCommand: RelayCommand
    private readonly submitCommand: RelayCommand
    private readonly finishCommand: RelayCommand
    private readonly copyOwnerPasswordCommand: RelayCommand
    private readonly copyAgentTokenCommand: RelayCommand
    private step = ProvisionStep.Client
    private submitting = false
    private provisionError = ProvisionWizardPageViewModel.NoText
    private selectedBackend: OptionViewModel<HiveClusterBackend> | undefined
    private selectedClusterMode: OptionViewModel<HiveProvisionMode> | undefined
    private selectedRegistryMode: OptionViewModel<HiveProvisionMode> | undefined
    private provisionedHiveId = ProvisionWizardPageViewModel.NoText
    private ownerPassword = ProvisionWizardPageViewModel.NoText
    private agentToken = ProvisionWizardPageViewModel.NoText
    private ownerSaved = false
    private agentSaved = false
    private copyStatus = ProvisionWizardPageViewModel.NoText

    public constructor(session: PortalSessionService, private readonly section: HivesSectionService)
    {
        super(session)
        const C = ProvisionWizardPageViewModel
        this.form = new ProvisionWizardViewModel(session.Client)
        this.stepLabels = [C.ClientLabel, C.TenantLabel, C.HiveLabel, C.ReviewLabel, C.BootstrapLabel]
        this.stepLabels.forEach((label, i) => this.steps.Add(new ProvisionStepViewModel(i as ProvisionStep, label)))
        HiveOptions.Backends().forEach(o => this.backends.Add(o))
        HiveOptions.Modes().forEach(o => this.clusterModes.Add(o))
        HiveOptions.Modes().forEach(o => this.registryModes.Add(o))
        this.selectedBackend = this.backends.Get(0)
        this.selectedClusterMode = this.clusterModes.Get(0)
        this.selectedRegistryMode = this.registryModes.Get(0)
        this.ApplyChoices()
        this.nextCommand = new RelayCommand(() => this.Next(), () => this.CanNext())
        this.backStepCommand = new RelayCommand(() => this.BackStep(), () => this.CanBackStep())
        this.cancelCommand = new RelayCommand(() => this.section.Back(), () => this.IsFormStep && !this.submitting)
        this.submitCommand = this.MutatingCommand(() => this.Submit(), () => this.CanSubmit())
        this.finishCommand = new RelayCommand(() => this.Finish(), () => this.CanFinish())
        this.copyOwnerPasswordCommand = new RelayCommand(() => { void this.Copy(this.ownerPassword) }, () => this.ownerPassword.length > 0)
        this.copyAgentTokenCommand = new RelayCommand(() => { void this.Copy(this.agentToken) }, () => this.agentToken.length > 0)
        this.SyncSteps()
    }

    public get StepIndex(): ProvisionStep
    {
        return this.step
    }

    public get StepLabels(): readonly string[]
    {
        return this.stepLabels
    }

    // The step indicator's entries, one per StepLabels entry.
    public get Steps(): ObservableCollection<ProvisionStepViewModel>
    {
        return this.steps
    }

    public get IsClientStep(): boolean
    {
        return this.step === ProvisionStep.Client
    }

    public get IsTenantStep(): boolean
    {
        return this.step === ProvisionStep.Tenant
    }

    public get IsHiveStep(): boolean
    {
        return this.step === ProvisionStep.Hive
    }

    public get IsReviewStep(): boolean
    {
        return this.step === ProvisionStep.Review
    }

    public get IsBootstrapStep(): boolean
    {
        return this.step === ProvisionStep.Bootstrap
    }

    // Any step before the reveal (Back and Cancel live there).
    public get IsFormStep(): boolean
    {
        return this.step !== ProvisionStep.Bootstrap
    }

    // A step that takes input (Next lives there).
    public get IsInputStep(): boolean
    {
        return this.step < ProvisionStep.Review
    }

    public get IsSubmitting(): boolean
    {
        return this.submitting
    }

    // Why the last provision failed (with what was rolled back and what was
    // left behind), or else the base page's load error.
    public override get ErrorText(): string
    {
        return this.provisionError.length > 0 ? this.provisionError : super.ErrorText
    }

    public get ClientId(): string
    {
        return this.form.ClientId
    }

    public set ClientId(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.ClientIdProperty, this.form.ClientId, value, v => { this.form.ClientId = v })
    }

    public get ClientDisplayName(): string
    {
        return this.form.ClientDisplayName
    }

    public set ClientDisplayName(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.ClientDisplayNameProperty, this.form.ClientDisplayName, value, v => { this.form.ClientDisplayName = v })
    }

    public get SubscriptionRef(): string
    {
        return this.form.SubscriptionRef
    }

    public set SubscriptionRef(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.SubscriptionRefProperty, this.form.SubscriptionRef, value, v => { this.form.SubscriptionRef = v })
    }

    public get TenantId(): string
    {
        return this.form.TenantId
    }

    public set TenantId(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.TenantIdProperty, this.form.TenantId, value, v => { this.form.TenantId = v })
    }

    public get TenantDisplayName(): string
    {
        return this.form.TenantDisplayName
    }

    public set TenantDisplayName(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.TenantDisplayNameProperty, this.form.TenantDisplayName, value, v => { this.form.TenantDisplayName = v })
    }

    public get OwnerEmail(): string
    {
        return this.form.OwnerEmail
    }

    public set OwnerEmail(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.OwnerEmailProperty, this.form.OwnerEmail, value, v => { this.form.OwnerEmail = v })
    }

    public get HiveId(): string
    {
        return this.form.HiveId
    }

    public set HiveId(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.HiveIdProperty, this.form.HiveId, value, v => { this.form.HiveId = v })
    }

    public get HiveDisplayName(): string
    {
        return this.form.HiveDisplayName
    }

    public set HiveDisplayName(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.HiveDisplayNameProperty, this.form.HiveDisplayName, value, v => { this.form.HiveDisplayName = v })
    }

    public get Backends(): ObservableCollection<OptionViewModel<HiveClusterBackend>>
    {
        return this.backends
    }

    public get SelectedBackend(): OptionViewModel<HiveClusterBackend> | undefined
    {
        return this.selectedBackend
    }

    public set SelectedBackend(value: OptionViewModel<HiveClusterBackend> | undefined)
    {
        this.SetChoice(ProvisionWizardPageViewModel.SelectedBackendProperty, this.selectedBackend, value, v => { this.selectedBackend = v })
    }

    public get ClusterModes(): ObservableCollection<OptionViewModel<HiveProvisionMode>>
    {
        return this.clusterModes
    }

    public get SelectedClusterMode(): OptionViewModel<HiveProvisionMode> | undefined
    {
        return this.selectedClusterMode
    }

    public set SelectedClusterMode(value: OptionViewModel<HiveProvisionMode> | undefined)
    {
        this.SetChoice(ProvisionWizardPageViewModel.SelectedClusterModeProperty, this.selectedClusterMode, value, v => { this.selectedClusterMode = v })
    }

    public get ConfigRef(): string
    {
        return this.form.ConfigRef
    }

    public set ConfigRef(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.ConfigRefProperty, this.form.ConfigRef, value, v => { this.form.ConfigRef = v })
    }

    public get RegistryModes(): ObservableCollection<OptionViewModel<HiveProvisionMode>>
    {
        return this.registryModes
    }

    public get SelectedRegistryMode(): OptionViewModel<HiveProvisionMode> | undefined
    {
        return this.selectedRegistryMode
    }

    public set SelectedRegistryMode(value: OptionViewModel<HiveProvisionMode> | undefined)
    {
        this.SetChoice(ProvisionWizardPageViewModel.SelectedRegistryModeProperty, this.selectedRegistryMode, value, v => { this.selectedRegistryMode = v })
    }

    public get Endpoint(): string
    {
        return this.form.Endpoint
    }

    public set Endpoint(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.EndpointProperty, this.form.Endpoint, value, v => { this.form.Endpoint = v })
    }

    public get CredentialRef(): string
    {
        return this.form.CredentialRef
    }

    public set CredentialRef(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.CredentialRefProperty, this.form.CredentialRef, value, v => { this.form.CredentialRef = v })
    }

    public get TrustRootRef(): string
    {
        return this.form.TrustRootRef
    }

    public set TrustRootRef(value: string)
    {
        this.SetFormField(ProvisionWizardViewModel.TrustRootRefProperty, this.form.TrustRootRef, value, v => { this.form.TrustRootRef = v })
    }

    // The chosen cluster backend and mode, for the Review step.
    public get ClusterSummary(): string
    {
        return (this.selectedBackend?.Label ?? ProvisionWizardPageViewModel.NoText)
            + ProvisionWizardPageViewModel.SummarySeparator
            + (this.selectedClusterMode?.Label ?? ProvisionWizardPageViewModel.NoText)
    }

    // The chosen registry mode, for the Review step.
    public get RegistrySummary(): string
    {
        return this.selectedRegistryMode?.Label ?? ProvisionWizardPageViewModel.NoText
    }

    // The provisioned hive's id; '' until the provision succeeds.
    public get ProvisionedHiveId(): string
    {
        return this.provisionedHiveId
    }

    // The new Owner's one-time password; '' before the provision and after Finish.
    public get OwnerPassword(): string
    {
        return this.ownerPassword
    }

    // The hive agent's one-time bootstrap token; '' before the provision and after Finish.
    public get AgentToken(): string
    {
        return this.agentToken
    }

    public get OwnerSaved(): boolean
    {
        return this.ownerSaved
    }

    public set OwnerSaved(next: boolean)
    {
        const old = this.ownerSaved
        if (old === next)
        {
            return
        }
        this.ownerSaved = next
        this.RaisePropertyChanged(ProvisionWizardPageViewModel.OwnerSavedProperty, old, next)
        this.finishCommand.RaiseCanExecuteChanged()
    }

    public get AgentSaved(): boolean
    {
        return this.agentSaved
    }

    public set AgentSaved(next: boolean)
    {
        const old = this.agentSaved
        if (old === next)
        {
            return
        }
        this.agentSaved = next
        this.RaisePropertyChanged(ProvisionWizardPageViewModel.AgentSavedProperty, old, next)
        this.finishCommand.RaiseCanExecuteChanged()
    }

    public get CopyStatus(): string
    {
        return this.copyStatus
    }

    public get NextCommand(): RelayCommand
    {
        return this.nextCommand
    }

    public get BackStepCommand(): RelayCommand
    {
        return this.backStepCommand
    }

    // Leaves the wizard for the hives list; offered before the reveal only.
    public get CancelCommand(): RelayCommand
    {
        return this.cancelCommand
    }

    public get SubmitCommand(): RelayCommand
    {
        return this.submitCommand
    }

    public get FinishCommand(): RelayCommand
    {
        return this.finishCommand
    }

    public get CopyOwnerPasswordCommand(): RelayCommand
    {
        return this.copyOwnerPasswordCommand
    }

    public get CopyAgentTokenCommand(): RelayCommand
    {
        return this.copyAgentTokenCommand
    }

    // Nothing to load: the wizard starts empty, and a refresh (a live update)
    // keeps its step and values.
    protected override LoadCore(): Promise<boolean>
    {
        return Promise.resolve(true)
    }

    private CanNext(): boolean
    {
        const formStep = ProvisionWizardPageViewModel.FormStepOf(this.step)
        return formStep !== undefined && this.form.StepValid(formStep)
    }

    private CanBackStep(): boolean
    {
        return this.step > ProvisionStep.Client && this.IsFormStep && !this.submitting
    }

    private CanSubmit(): boolean
    {
        return this.step === ProvisionStep.Review && !this.submitting && this.form.CanProvision()
    }

    private CanFinish(): boolean
    {
        return this.ownerSaved && this.agentSaved && (this.ownerPassword.length > 0 || this.agentToken.length > 0)
    }

    private Next(): void
    {
        if (this.CanNext())
        {
            this.SetStep(this.step + 1)
        }
    }

    private BackStep(): void
    {
        if (this.CanBackStep())
        {
            this.SetProvisionError(ProvisionWizardPageViewModel.NoText)
            this.SetStep(this.step - 1)
        }
    }

    // Runs inside the page's Guard: a 401 is rethrown so the session expires;
    // any other failure stays on Review with ErrorText describing it.
    private async Submit(): Promise<void>
    {
        if (this.submitting)
        {
            return
        }
        this.SetSubmitting(true)
        this.SetProvisionError(ProvisionWizardPageViewModel.NoText)
        try
        {
            const result = await this.form.Provision()
            this.provisionedHiveId = result.hive.id
            this.RaisePropertyChanged(ProvisionWizardPageViewModel.ProvisionedHiveIdProperty, ProvisionWizardPageViewModel.NoText, this.provisionedHiveId)
            this.SetSecrets(result.secrets.ownerPassword, result.secrets.agentToken)
            this.SetStep(ProvisionStep.Bootstrap)
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
            {
                throw e
            }
            this.SetProvisionError(ProvisionWizardPageViewModel.Describe(e))
        }
        finally
        {
            this.SetSubmitting(false)
        }
    }

    // Clears both values, then the new hive's detail replaces this page.
    private Finish(): void
    {
        if (!this.CanFinish())
        {
            return
        }
        this.SetSecrets(ProvisionWizardPageViewModel.NoText, ProvisionWizardPageViewModel.NoText)
        this.section.ShowHiveAfterProvision(this.provisionedHiveId)
    }

    private async Copy(value: string): Promise<void>
    {
        const clipboard = this.section.Clipboard
        if (clipboard === undefined || value.length === 0)
        {
            this.SetCopyStatus(ProvisionWizardPageViewModel.CopyFailedText)
            return
        }
        try
        {
            await clipboard.WriteText(value)
            this.SetCopyStatus(ProvisionWizardPageViewModel.CopiedText)
        }
        catch
        {
            this.SetCopyStatus(ProvisionWizardPageViewModel.CopyFailedText)
        }
    }

    private static FormStepOf(step: ProvisionStep): WizardStep | undefined
    {
        switch (step)
        {
            case ProvisionStep.Client:
                return WizardStep.Client
            case ProvisionStep.Tenant:
                return WizardStep.Tenant
            case ProvisionStep.Hive:
                return WizardStep.Hive
            default:
                return undefined
        }
    }

    private static Describe(e: unknown): string
    {
        const C = ProvisionWizardPageViewModel
        let text = C.FailedPrefix + (e instanceof Error ? e.message : String(e))
        if (e instanceof ApiError && e.rollback !== undefined)
        {
            if (e.rollback.rolledBack.length > 0)
            {
                text += C.RolledBackPrefix + e.rollback.rolledBack.join(C.ListSeparator) + C.SentenceEnd
            }
            if (e.rollback.residue.length > 0)
            {
                text += C.ResiduePrefix + e.rollback.residue.join(C.ListSeparator) + C.SentenceEnd
            }
        }
        return text
    }

    private SetFormField(name: string, old: string, next: string, assign: (value: string) => void): void
    {
        if (old === next)
        {
            return
        }
        assign(next)
        this.RaisePropertyChanged(name, old, next)
        this.RaiseCommandsChanged()
    }

    private SetChoice<T>(name: string, old: OptionViewModel<T> | undefined, next: OptionViewModel<T> | undefined, assign: (value: OptionViewModel<T> | undefined) => void): void
    {
        if (old === next)
        {
            return
        }
        const C = ProvisionWizardPageViewModel
        const oldCluster = this.ClusterSummary
        const oldRegistry = this.RegistrySummary
        assign(next)
        this.ApplyChoices()
        this.RaisePropertyChanged(name, old, next)
        this.RaisePropertyChanged(C.ClusterSummaryProperty, oldCluster, this.ClusterSummary)
        this.RaisePropertyChanged(C.RegistrySummaryProperty, oldRegistry, this.RegistrySummary)
    }

    // Copies the ComboBox choices into the form (a cleared choice keeps the
    // form's previous value).
    private ApplyChoices(): void
    {
        if (this.selectedBackend !== undefined)
        {
            this.form.Backend = this.selectedBackend.Value
        }
        if (this.selectedClusterMode !== undefined)
        {
            this.form.ClusterMode = this.selectedClusterMode.Value
        }
        if (this.selectedRegistryMode !== undefined)
        {
            this.form.RegistryMode = this.selectedRegistryMode.Value
        }
    }

    private SetStep(next: ProvisionStep): void
    {
        const C = ProvisionWizardPageViewModel
        const old = this.step
        if (old === next)
        {
            return
        }
        const was = [this.IsClientStep, this.IsTenantStep, this.IsHiveStep, this.IsReviewStep, this.IsBootstrapStep, this.IsFormStep, this.IsInputStep]
        this.step = next
        this.RaisePropertyChanged(C.StepIndexProperty, old, next)
        this.RaisePropertyChanged(C.IsClientStepProperty, was[0], this.IsClientStep)
        this.RaisePropertyChanged(C.IsTenantStepProperty, was[1], this.IsTenantStep)
        this.RaisePropertyChanged(C.IsHiveStepProperty, was[2], this.IsHiveStep)
        this.RaisePropertyChanged(C.IsReviewStepProperty, was[3], this.IsReviewStep)
        this.RaisePropertyChanged(C.IsBootstrapStepProperty, was[4], this.IsBootstrapStep)
        this.RaisePropertyChanged(C.IsFormStepProperty, was[5], this.IsFormStep)
        this.RaisePropertyChanged(C.IsInputStepProperty, was[6], this.IsInputStep)
        this.SyncSteps()
        this.RaiseCommandsChanged()
    }

    private SyncSteps(): void
    {
        for (const item of this.steps.ToArray())
        {
            item.SetCurrent(item.Step === this.step)
        }
    }

    private SetSubmitting(next: boolean): void
    {
        const old = this.submitting
        if (old === next)
        {
            return
        }
        this.submitting = next
        this.RaisePropertyChanged(ProvisionWizardPageViewModel.IsSubmittingProperty, old, next)
        this.RaiseCommandsChanged()
    }

    private SetProvisionError(next: string): void
    {
        const old = this.ErrorText
        this.provisionError = next
        if (old !== this.ErrorText)
        {
            this.RaisePropertyChanged(ProvisionWizardPageViewModel.WizardErrorTextProperty, old, this.ErrorText)
        }
    }

    private SetSecrets(ownerPassword: string, agentToken: string): void
    {
        const C = ProvisionWizardPageViewModel
        const oldOwner = this.ownerPassword
        const oldAgent = this.agentToken
        this.ownerPassword = ownerPassword
        this.agentToken = agentToken
        if (oldOwner !== ownerPassword)
        {
            this.RaisePropertyChanged(C.OwnerPasswordProperty, oldOwner, ownerPassword)
        }
        if (oldAgent !== agentToken)
        {
            this.RaisePropertyChanged(C.AgentTokenProperty, oldAgent, agentToken)
        }
        this.RaiseCommandsChanged()
    }

    private SetCopyStatus(next: string): void
    {
        const old = this.copyStatus
        if (old === next)
        {
            return
        }
        this.copyStatus = next
        this.RaisePropertyChanged(ProvisionWizardPageViewModel.CopyStatusProperty, old, next)
    }

    private RaiseCommandsChanged(): void
    {
        this.nextCommand.RaiseCanExecuteChanged()
        this.backStepCommand.RaiseCanExecuteChanged()
        this.cancelCommand.RaiseCanExecuteChanged()
        this.submitCommand.RaiseCanExecuteChanged()
        this.finishCommand.RaiseCanExecuteChanged()
        this.copyOwnerPasswordCommand.RaiseCanExecuteChanged()
        this.copyAgentTokenCommand.RaiseCanExecuteChanged()
    }
}
