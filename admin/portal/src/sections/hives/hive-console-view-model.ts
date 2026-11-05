import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../../api-client.js'
import { PortalDates } from '../../portal-dates.js'
import { ConsoleInstallState, ConsoleInstallStep, IngressTlsSource, type ConsoleInstallStatusDto, type HiveConsoleSpecDto, type HiveDto } from '../../portal-types.js'
import type { IClipboardSource } from '../../shell/one-time-secret-page-view-model.js'
import type { OptionViewModel } from '../../shell/option-view-model.js'
import { TimerPollScheduler, type IPollScheduler } from '../../shell/poll-scheduler.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { AgentInstallStepState, AgentInstallStepViewModel } from './hive-agent-install-view-model.js'
import { HiveOptions } from './hive-options.js'

// Where the console install stands, as the panel shows it. Idle: none has run
// (or the control plane forgot it on a restart); Starting: the start request
// is in flight; Deployed: the console runs, its first report is still to come;
// Reported: the running console has reported to the control plane.
export enum ConsoleInstallPhase
{
    Idle,
    Starting,
    Installing,
    Deployed,
    Failed,
    Reported,
}

// The tenant console of one hive: where it is served (base domain, optional
// host, TLS source) and Save / Remove for those settings; Install console
// (and Retry), which the control plane runs itself while the panel polls its
// status every 2 seconds, then, once deployed, every 15 seconds until the
// console reports; and, once deployed, a fresh Owner password for the
// console's identity provider, shown once (with Copy) and cleared when the
// page is left after it was shown.
// Polling runs only while the owning page is showing: the page calls Resume
// when shown and Stop when left.
export class HiveConsoleViewModel extends Observable
{
    public static readonly PollIntervalMs = 2000
    // How often a deployed console's status is read until the console reports.
    public static readonly ReportPollIntervalMs = 15000

    private static readonly StepLabels: ReadonlyArray<readonly [ConsoleInstallStep, string]> = [
        [ConsoleInstallStep.CheckingAgent, 'Check the hive agent'],
        [ConsoleInstallStep.PreparingCertificates, 'Prepare certificates'],
        [ConsoleInstallStep.ApplyingConsole, 'Apply the console'],
        [ConsoleInstallStep.StoringSecrets, 'Store its secrets'],
        [ConsoleInstallStep.WaitingForRollout, 'Wait for it to start'],
        [ConsoleInstallStep.SeedingOwner, 'Create the Owner account'],
    ]
    private static readonly StartingText = 'Starting the console install...'
    private static readonly InstallingText = 'Installing the console. On a fresh cluster the first start can take several minutes while its images load.'
    private static readonly DeployedText = 'Deployed. Waiting for the console to report.'
    private static readonly FailedText = 'The console install stopped.'
    private static readonly ReportedPrefix = 'Reported by the console at '
    private static readonly ReportedSuffix = '.'
    private static readonly StalePrefix = 'Last reported at '
    private static readonly StaleSuffix = ', more than a day ago.'
    private static readonly NoText = ''
    private static readonly HostPrefix = 'console-'
    private static readonly HostSeparator = '.'
    private static readonly BaseDomainHint = '<base domain>'
    private static readonly TrustCommandPrefix = 'powershell -NoProfile -ExecutionPolicy Bypass -File admin\\control-plane\\dev\\dev-ca-trust.ps1 -Install -CaFile "'
    private static readonly TrustCommandSuffix = '"'
    private static readonly DefaultIngressNamespace = 'ingress-nginx'
    private static readonly RemovedText = 'The console was removed.'
    private static readonly KeptPrefix = ' Kept in the cluster: '
    private static readonly KeptSeparator = ', '
    private static readonly KeptSuffix = '. Kept environments keep running unmanaged until the console is reinstalled; they are removed with the hive.'
    private static readonly CopiedText = 'Copied.'
    private static readonly CopyFailedText = 'Could not copy. Select the value and copy it by hand.'
    private static readonly OwnerPasswordProperty = 'OwnerPassword'
    // Every bound value a change can move, raised when it did.
    private static readonly BoundProperties: readonly string[] = [
        'BaseDomain', 'Host', 'HostPlaceholder', 'SelectedTls', 'SecretName', 'ClusterIssuer', 'IngressNamespace',
        'IsExistingSecret', 'IsCertManager', 'IsDevelopment', 'IsConfigured', 'IsNotConfigured',
        'Phase', 'IsIdle', 'IsInstalling', 'IsDeployed', 'IsReported', 'IsFailed', 'HasProgress', 'StatusText',
        'ConsoleUrl', 'HasConsoleUrl', 'DevTrustCommand', 'HasDevTrustCommand', 'TrustCopyStatus',
        'OwnerEmail', HiveConsoleViewModel.OwnerPasswordProperty, 'HasOwnerPassword', 'PasswordCopyStatus',
        'ErrorText', 'IsBusy', 'IsConfirmingRemove', 'RemovalNote',
    ]
    // Bound values whose change notification never carries the old value (it would be the password).
    private static readonly SecretProperties: ReadonlySet<string> = new Set([HiveConsoleViewModel.OwnerPasswordProperty])

    private readonly tlsOptions = new ObservableCollection<OptionViewModel<IngressTlsSource>>()
    private readonly steps = new ObservableCollection<AgentInstallStepViewModel>()
    private readonly commands: RelayCommand[] = []
    private readonly saveCommand: RelayCommand
    private readonly removeCommand: RelayCommand
    private readonly confirmRemoveCommand: RelayCommand
    private readonly cancelRemoveCommand: RelayCommand
    private readonly installCommand: RelayCommand
    private readonly retryCommand: RelayCommand
    private readonly setOwnerPasswordCommand: RelayCommand
    private readonly copyPasswordCommand: RelayCommand
    private readonly copyTrustCommandCommand: RelayCommand
    private tenantId = ''
    private saved: HiveConsoleSpecDto | undefined
    // True once the operator edited a field since the settings were last shown: a reload then keeps the edits.
    private dirty = false
    private baseDomain = ''
    private host = ''
    private selectedTls: OptionViewModel<IngressTlsSource> | undefined
    private secretName = ''
    private clusterIssuer = ''
    private ingressNamespace = ''
    private phase = ConsoleInstallPhase.Idle
    // The install status the panel shows (undefined: none), so a refused start can go back to it.
    private lastStatus: ConsoleInstallStatusDto | undefined
    private consoleUrl = ''
    private devCaFile = ''
    private errorText = ''
    // The Owner password reset's reply, held only for display. It is cleared by the first Stop after it was shown:
    // a reply that lands while the page is hidden is kept until the page shows again (the server already rotated the
    // password, so the reply is the only copy).
    private ownerEmail = ''
    private ownerPassword = ''
    private passwordShown = false
    private passwordCopyStatus = ''
    private trustCopyStatus = ''
    // Whether the owning page shows (between Resume and Stop).
    private showing = false
    // A settings write, removal or password reset in flight.
    private busy = false
    private confirmingRemove = false
    private removalNote = ''
    // Bumped by Stop (and by each Install / Resume): an install status for an
    // older generation is dropped, so a left page never resumes polling.
    private generation = 0
    private pending: IDisposable | undefined

    public constructor(
        private readonly session: PortalSessionService,
        public readonly HiveId: string,
        private readonly clipboardSource: IClipboardSource,
        private readonly scheduler: IPollScheduler = new TimerPollScheduler(),
        private readonly intervalMs: number = HiveConsoleViewModel.PollIntervalMs)
    {
        super()
        HiveOptions.TlsSources().forEach(o => this.tlsOptions.Add(o))
        this.selectedTls = this.tlsOptions.Get(0)
        for (const [step, label] of HiveConsoleViewModel.StepLabels)
        {
            this.steps.Add(new AgentInstallStepViewModel(step, label))
        }
        this.saveCommand = this.Command(() => this.Save(), () => this.CanSave)
        this.removeCommand = this.Command(async () => { this.AskRemove() }, () => this.CanChangeSettings && this.IsConfigured && !this.confirmingRemove)
        this.confirmRemoveCommand = this.Command(() => this.ConfirmRemove(), () => this.session.CanMutate && this.confirmingRemove && !this.busy)
        this.cancelRemoveCommand = this.Command(async () => { this.CancelRemove() }, () => this.confirmingRemove && !this.busy)
        this.installCommand = this.Command(() => this.Install(), () => this.CanInstall)
        this.retryCommand = this.Command(() => this.Install(), () => this.CanInstall && this.IsFailed)
        this.setOwnerPasswordCommand = this.Command(() => this.SetOwnerPassword(), () => this.CanSetOwnerPassword)
        this.copyPasswordCommand = this.Command(() => this.CopyPassword(), () => this.HasOwnerPassword)
        this.copyTrustCommandCommand = this.Command(() => this.CopyTrustCommand(), () => this.HasDevTrustCommand)
    }

    // Takes the hive's record as the control plane holds it: its tenant and its saved console settings, which the
    // fields show unless the operator has unsaved edits in them.
    public Load(hive: HiveDto): void
    {
        this.Change(() =>
        {
            this.tenantId = hive.tenantId
            if (this.dirty)
            {
                this.saved = hive.console
                return
            }
            this.ShowSettings(hive.console)
        })
    }

    public get BaseDomain(): string
    {
        return this.baseDomain
    }

    public set BaseDomain(value: string)
    {
        this.Edit(this.baseDomain, value, () => { this.baseDomain = value })
    }

    // The console's browser host; empty uses HostPlaceholder.
    public get Host(): string
    {
        return this.host
    }

    public set Host(value: string)
    {
        this.Edit(this.host, value, () => { this.host = value })
    }

    // The host the console gets when Host is empty: console-<tenant>.<base domain>.
    public get HostPlaceholder(): string
    {
        const C = HiveConsoleViewModel
        const domain = this.baseDomain.trim()
        return C.HostPrefix + this.tenantId + C.HostSeparator + (domain.length > 0 ? domain : C.BaseDomainHint)
    }

    public get TlsOptions(): ObservableCollection<OptionViewModel<IngressTlsSource>>
    {
        return this.tlsOptions
    }

    public get SelectedTls(): OptionViewModel<IngressTlsSource> | undefined
    {
        return this.selectedTls
    }

    public set SelectedTls(value: OptionViewModel<IngressTlsSource> | undefined)
    {
        this.Edit(this.selectedTls, value, () => { this.selectedTls = value })
    }

    // The existing kubernetes.io/tls Secret in pragmatic-system (existing-secret only).
    public get SecretName(): string
    {
        return this.secretName
    }

    public set SecretName(value: string)
    {
        this.Edit(this.secretName, value, () => { this.secretName = value })
    }

    // The namespace the ingress controller runs in; empty means ingress-nginx (the only namespace that may reach the console).
    public get IngressNamespace(): string
    {
        return this.ingressNamespace
    }

    public set IngressNamespace(value: string)
    {
        this.Edit(this.ingressNamespace, value, () => { this.ingressNamespace = value })
    }

    public get IngressNamespacePlaceholder(): string
    {
        return HiveConsoleViewModel.DefaultIngressNamespace
    }

    // The cert-manager ClusterIssuer (cert-manager only).
    public get ClusterIssuer(): string
    {
        return this.clusterIssuer
    }

    public set ClusterIssuer(value: string)
    {
        this.Edit(this.clusterIssuer, value, () => { this.clusterIssuer = value })
    }

    public get IsExistingSecret(): boolean
    {
        return this.selectedTls?.Value === IngressTlsSource.ExistingSecret
    }

    public get IsCertManager(): boolean
    {
        return this.selectedTls?.Value === IngressTlsSource.CertManager
    }

    public get IsDevelopment(): boolean
    {
        return this.selectedTls?.Value === IngressTlsSource.Development
    }

    // Whether the control plane holds console settings for the hive.
    public get IsConfigured(): boolean
    {
        return this.saved !== undefined
    }

    public get IsNotConfigured(): boolean
    {
        return !this.IsConfigured
    }

    public get Steps(): ObservableCollection<AgentInstallStepViewModel>
    {
        return this.steps
    }

    public get Phase(): ConsoleInstallPhase
    {
        return this.phase
    }

    public get IsIdle(): boolean
    {
        return this.phase === ConsoleInstallPhase.Idle
    }

    public get IsInstalling(): boolean
    {
        return this.phase === ConsoleInstallPhase.Starting || this.phase === ConsoleInstallPhase.Installing
    }

    // True once the console runs, whether or not it has reported yet (Reinstall stays offered).
    public get IsDeployed(): boolean
    {
        return this.phase === ConsoleInstallPhase.Deployed || this.phase === ConsoleInstallPhase.Reported
    }

    // True once the running console has reported to the control plane.
    public get IsReported(): boolean
    {
        return this.phase === ConsoleInstallPhase.Reported
    }

    public get IsFailed(): boolean
    {
        return this.phase === ConsoleInstallPhase.Failed
    }

    // Whether there is an install to show (running or finished).
    public get HasProgress(): boolean
    {
        return this.phase !== ConsoleInstallPhase.Idle
    }

    public get StatusText(): string
    {
        const C = HiveConsoleViewModel
        switch (this.phase)
        {
            case ConsoleInstallPhase.Starting:
                return C.StartingText
            case ConsoleInstallPhase.Installing:
                return C.InstallingText
            case ConsoleInstallPhase.Deployed:
                return C.DeployedText
            case ConsoleInstallPhase.Reported:
                return this.ReportedText()
            case ConsoleInstallPhase.Failed:
                return C.FailedText
            default:
                return C.NoText
        }
    }

    // When the console last reported, and whether that was more than a day ago.
    private ReportedText(): string
    {
        const C = HiveConsoleViewModel
        const at = PortalDates.DateTimeLabel(this.lastStatus?.reportedAt)
        return this.lastStatus?.stale === true ? C.StalePrefix + at + C.StaleSuffix : C.ReportedPrefix + at + C.ReportedSuffix
    }

    // Where the console is served, once the install says; '' before.
    public get ConsoleUrl(): string
    {
        return this.consoleUrl
    }

    public get HasConsoleUrl(): boolean
    {
        return this.consoleUrl.length > 0
    }

    // The command that trusts the development CA on this machine (development TLS only); '' otherwise.
    public get DevTrustCommand(): string
    {
        const C = HiveConsoleViewModel
        return this.devCaFile.length === 0 ? C.NoText : C.TrustCommandPrefix + this.devCaFile + C.TrustCommandSuffix
    }

    public get HasDevTrustCommand(): boolean
    {
        return this.devCaFile.length > 0
    }

    // The Owner's sign-in email after a password reset; '' otherwise.
    public get OwnerEmail(): string
    {
        return this.ownerEmail
    }

    // The fresh Owner password, shown once: cleared when the page is left.
    public get OwnerPassword(): string
    {
        return this.ownerPassword
    }

    public get HasOwnerPassword(): boolean
    {
        return this.ownerPassword.length > 0
    }

    // How the last Copy of the Owner password went ('Copied.' or how to copy by hand); never the password.
    public get PasswordCopyStatus(): string
    {
        return this.passwordCopyStatus
    }

    // How the last Copy of the trust command went.
    public get TrustCopyStatus(): string
    {
        return this.trustCopyStatus
    }

    public get CopyPasswordCommand(): RelayCommand
    {
        return this.copyPasswordCommand
    }

    public get CopyTrustCommandCommand(): RelayCommand
    {
        return this.copyTrustCommandCommand
    }

    // Why the last action (or the install) failed; '' otherwise.
    public get ErrorText(): string
    {
        return this.errorText
    }

    public get IsBusy(): boolean
    {
        return this.busy
    }

    // After a removal: what stayed in the cluster ('' otherwise).
    public get RemovalNote(): string
    {
        return this.removalNote
    }

    // True while Remove console waits for its confirmation.
    public get IsConfirmingRemove(): boolean
    {
        return this.confirmingRemove
    }

    public get SaveCommand(): RelayCommand
    {
        return this.saveCommand
    }

    // Asks to confirm the removal (ConfirmRemoveCommand removes, CancelRemoveCommand keeps it).
    public get RemoveCommand(): RelayCommand
    {
        return this.removeCommand
    }

    public get ConfirmRemoveCommand(): RelayCommand
    {
        return this.confirmRemoveCommand
    }

    public get CancelRemoveCommand(): RelayCommand
    {
        return this.cancelRemoveCommand
    }

    public get InstallCommand(): RelayCommand
    {
        return this.installCommand
    }

    // Retry after a failure: a fresh run from the first step.
    public get RetryCommand(): RelayCommand
    {
        return this.retryCommand
    }

    public get SetOwnerPasswordCommand(): RelayCommand
    {
        return this.setOwnerPasswordCommand
    }

    // Whether the settings may change now: the operator may mutate, nothing is in flight and no install runs.
    private get CanChangeSettings(): boolean
    {
        return this.session.CanMutate && !this.busy && !this.IsInstalling
    }

    private get CanSave(): boolean
    {
        return this.CanChangeSettings && this.baseDomain.trim().length > 0 && this.selectedTls !== undefined && this.RequiredTlsFieldSet()
    }

    private get CanInstall(): boolean
    {
        return this.CanChangeSettings && this.IsConfigured && !this.confirmingRemove
    }

    // The server resets the Owner password for any configured hive with no console install running (it refuses with a
    // sentence when the console's identity provider cannot be reached), so the panel does not wait for an install
    // status: after a control-plane restart there is none.
    private get CanSetOwnerPassword(): boolean
    {
        return this.session.CanMutate && !this.busy && this.IsConfigured && !this.IsInstalling
    }

    // Stores the settings as typed. Never throws: a refusal shows its sentence in ErrorText.
    public async Save(): Promise<void>
    {
        if (!this.CanSave)
        {
            return
        }
        const spec = this.SpecFromFields()
        await this.Request(async () =>
        {
            const hive = await this.session.Client.SetHiveConsole(this.HiveId, spec)
            this.Change(() => { this.ShowSettings(hive.console) })
        })
    }

    // Removes the console from the cluster and clears its settings. Never throws.
    public async ConfirmRemove(): Promise<void>
    {
        if (!this.confirmRemoveCommand.CanExecute())
        {
            return
        }
        this.CancelRemove()
        await this.Request(async () =>
        {
            const removal = await this.session.Client.RemoveHiveConsole(this.HiveId)
            // No install to follow any more (the page still shows: not a Stop).
            this.Restart()
            this.Change(() =>
            {
                this.ShowSettings(removal.hive.console)
                this.SetPhase(ConsoleInstallPhase.Idle, undefined)
                this.removalNote = removal.notice ?? HiveConsoleViewModel.RemovalNoteOf(removal.retained)
            })
        })
    }

    // Starts an install and polls it. Never throws: a refusal shows its reason,
    // unless an install is already running for the hive, which the panel then follows.
    public async Install(): Promise<void>
    {
        if (!this.CanInstall)
        {
            return
        }
        const generation = this.Restart()
        const before: InstallView = { phase: this.phase, status: this.lastStatus }
        this.Change(() =>
        {
            this.errorText = HiveConsoleViewModel.NoText
            this.SetPhase(ConsoleInstallPhase.Starting, undefined)
        })
        let status: ConsoleInstallStatusDto
        try
        {
            status = await this.session.Client.StartConsoleInstall(this.HiveId)
        }
        catch (e)
        {
            if (generation === this.generation)
            {
                await this.Refused(generation, e, before)
            }
            return
        }
        this.Follow(generation, status)
    }

    // Sets a fresh Owner password in the console's identity provider and shows it once. Never throws.
    public async SetOwnerPassword(): Promise<void>
    {
        if (!this.CanSetOwnerPassword)
        {
            return
        }
        await this.Request(async () =>
        {
            const reset = await this.session.Client.ResetInHiveOwnerPassword(this.HiveId)
            // Never dropped: the server already rotated the password and this reply is its only copy. A reply landing
            // while the page is hidden waits for the page to show again; Stop clears it only once it was shown.
            this.Change(() =>
            {
                this.ownerEmail = reset.ownerEmail
                this.ownerPassword = reset.ownerPassword
                this.passwordShown = this.showing
                this.passwordCopyStatus = HiveConsoleViewModel.NoText
            })
        })
    }

    // Reads the hive's latest install (a page was shown); polls it while it runs. Never throws.
    public async Resume(): Promise<void>
    {
        this.showing = true
        if (this.HasOwnerPassword)
        {
            this.passwordShown = true
        }
        const generation = this.Restart()
        await this.Read(generation)
    }

    // Stops polling (the page was left): an install status in flight is dropped, and an Owner password that was
    // shown is forgotten. One that has not been shown yet (its reply landed while hidden) is kept for the next showing.
    public Stop(): void
    {
        this.showing = false
        this.generation++
        this.CancelPending()
        this.Change(() =>
        {
            if (this.passwordShown)
            {
                this.ownerEmail = HiveConsoleViewModel.NoText
                this.ownerPassword = HiveConsoleViewModel.NoText
                this.passwordShown = false
            }
            this.passwordCopyStatus = HiveConsoleViewModel.NoText
            this.trustCopyStatus = HiveConsoleViewModel.NoText
            this.confirmingRemove = false
            this.removalNote = HiveConsoleViewModel.NoText
        })
    }

    // What a removal tells the operator: that it happened and, when it kept anything, what and why.
    private static RemovalNoteOf(retained: readonly string[]): string
    {
        const C = HiveConsoleViewModel
        if (retained.length === 0)
        {
            return C.RemovedText
        }
        return C.RemovedText + C.KeptPrefix + retained.join(C.KeptSeparator) + C.KeptSuffix
    }

    private async CopyPassword(): Promise<void>
    {
        const status = await this.Copy(this.ownerPassword)
        this.Change(() => { this.passwordCopyStatus = status })
    }

    private async CopyTrustCommand(): Promise<void>
    {
        const status = await this.Copy(this.DevTrustCommand)
        this.Change(() => { this.trustCopyStatus = status })
    }

    // Copies one value; the outcome as a status sentence (never the value).
    private async Copy(value: string): Promise<string>
    {
        const C = HiveConsoleViewModel
        const clipboard = this.clipboardSource.Clipboard
        if (clipboard === undefined || value.length === 0)
        {
            return C.CopyFailedText
        }
        try
        {
            await clipboard.WriteText(value)
            return C.CopiedText
        }
        catch
        {
            return C.CopyFailedText
        }
    }

    // A field the operator typed into: marks the settings edited when the value changed.
    private Edit<T>(old: T, value: T, apply: () => void): void
    {
        if (old === value)
        {
            return
        }
        this.Change(() =>
        {
            apply()
            this.dirty = true
        })
    }

    private AskRemove(): void
    {
        this.Change(() => { this.confirmingRemove = true })
    }

    private CancelRemove(): void
    {
        this.Change(() => { this.confirmingRemove = false })
    }

    private RequiredTlsFieldSet(): boolean
    {
        if (this.IsExistingSecret)
        {
            return this.secretName.trim().length > 0
        }
        if (this.IsCertManager)
        {
            return this.clusterIssuer.trim().length > 0
        }
        return true
    }

    // The settings as typed: no host key when Host is empty; only the TLS field the source uses.
    private SpecFromFields(): HiveConsoleSpecDto
    {
        const source = (this.selectedTls as OptionViewModel<IngressTlsSource>).Value
        const tls: HiveConsoleSpecDto['tls'] = { source }
        if (source === IngressTlsSource.ExistingSecret)
        {
            tls.secretName = this.secretName.trim()
        }
        else if (source === IngressTlsSource.CertManager)
        {
            tls.clusterIssuer = this.clusterIssuer.trim()
        }
        const spec: HiveConsoleSpecDto = { baseDomain: this.baseDomain.trim(), tls }
        const host = this.host.trim()
        if (host.length > 0)
        {
            spec.host = host
        }
        const ingressNamespace = this.ingressNamespace.trim()
        if (ingressNamespace.length > 0)
        {
            spec.ingressNamespace = ingressNamespace
        }
        return spec
    }

    // Shows saved settings in the fields (no settings: the fields stay as typed); the fields are then unedited.
    private ShowSettings(spec: HiveConsoleSpecDto | undefined): void
    {
        this.saved = spec
        this.dirty = false
        if (spec === undefined)
        {
            return
        }
        this.baseDomain = spec.baseDomain
        this.host = spec.host ?? HiveConsoleViewModel.NoText
        this.selectedTls = this.tlsOptions.ToArray().find(o => o.Value === spec.tls.source) ?? this.selectedTls
        this.secretName = spec.tls.secretName ?? HiveConsoleViewModel.NoText
        this.clusterIssuer = spec.tls.clusterIssuer ?? HiveConsoleViewModel.NoText
        this.ingressNamespace = spec.ingressNamespace ?? HiveConsoleViewModel.NoText
    }

    // Runs one settings or password request: busy while it runs, its refusal in ErrorText, a 401 expires the session.
    private async Request(action: () => Promise<void>): Promise<void>
    {
        this.Change(() =>
        {
            this.busy = true
            this.errorText = HiveConsoleViewModel.NoText
            this.removalNote = HiveConsoleViewModel.NoText
        })
        try
        {
            await action()
        }
        catch (e)
        {
            if (!this.Expired(e))
            {
                this.Change(() => { this.errorText = HiveConsoleViewModel.MessageOf(e) })
            }
        }
        finally
        {
            this.Change(() => { this.busy = false })
        }
    }

    private Restart(): number
    {
        this.generation++
        this.CancelPending()
        return this.generation
    }

    private async Read(generation: number): Promise<void>
    {
        let status: ConsoleInstallStatusDto | null
        try
        {
            status = await this.session.Client.GetConsoleInstall(this.HiveId)
        }
        catch (e)
        {
            if (generation !== this.generation || this.Expired(e))
            {
                return
            }
            // A transient read failure: keep following a running install, or waiting for the console's report.
            this.ScheduleFor(generation, this.phase)
            return
        }
        if (generation !== this.generation)
        {
            return
        }
        if (status === null)
        {
            this.Change(() => { this.SetPhase(ConsoleInstallPhase.Idle, undefined) })
            return
        }
        this.Follow(generation, status)
    }

    // A refused start: follow the hive's running install when there is one; else no install ran, so the panel goes
    // back to what it showed before the start and only the refusal's sentence shows (Failed is for a failed run).
    private async Refused(generation: number, e: unknown, before: InstallView): Promise<void>
    {
        if (this.Expired(e))
        {
            return
        }
        let current: ConsoleInstallStatusDto | null = null
        try
        {
            current = await this.session.Client.GetConsoleInstall(this.HiveId)
        }
        catch
        {
            current = null
        }
        if (generation !== this.generation)
        {
            return
        }
        if (current !== null && current.state === ConsoleInstallState.Installing)
        {
            this.Follow(generation, current)
            return
        }
        this.Change(() =>
        {
            this.SetPhase(before.phase, before.status)
            this.errorText = HiveConsoleViewModel.MessageOf(e)
        })
        // The start cancelled the wait for a deployed console's report; it goes on.
        this.ScheduleFor(generation, before.phase)
    }

    private Follow(generation: number, status: ConsoleInstallStatusDto): void
    {
        if (generation !== this.generation)
        {
            return
        }
        const phase = HiveConsoleViewModel.PhaseOf(status.state)
        this.Change(() =>
        {
            this.SetPhase(phase, status)
            this.errorText = status.error ?? HiveConsoleViewModel.NoText
        })
        this.ScheduleFor(generation, phase)
    }

    // The next read for a phase: soon while installing, slower while a deployed console has yet to report, none otherwise.
    private ScheduleFor(generation: number, phase: ConsoleInstallPhase): void
    {
        if (phase === ConsoleInstallPhase.Starting || phase === ConsoleInstallPhase.Installing)
        {
            this.Schedule(generation, this.intervalMs)
        }
        else if (phase === ConsoleInstallPhase.Deployed)
        {
            this.Schedule(generation, HiveConsoleViewModel.ReportPollIntervalMs)
        }
    }

    private Schedule(generation: number, delayMs: number): void
    {
        this.CancelPending()
        this.pending = this.scheduler.Schedule(delayMs, () =>
        {
            this.pending = undefined
            if (generation === this.generation)
            {
                void this.Read(generation)
            }
        })
    }

    private CancelPending(): void
    {
        this.pending?.dispose()
        this.pending = undefined
    }

    private Expired(e: unknown): boolean
    {
        if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
        {
            this.Stop()
            this.session.Expire()
            return true
        }
        return false
    }

    private static MessageOf(e: unknown): string
    {
        return e instanceof Error ? e.message : String(e)
    }

    private static PhaseOf(state: ConsoleInstallState): ConsoleInstallPhase
    {
        switch (state)
        {
            case ConsoleInstallState.Deployed:
                return ConsoleInstallPhase.Deployed
            case ConsoleInstallState.Reported:
                return ConsoleInstallPhase.Reported
            case ConsoleInstallState.Failed:
                return ConsoleInstallPhase.Failed
            default:
                return ConsoleInstallPhase.Installing
        }
    }

    // Sets the phase, and the step list, URL and CA path from a status when given (none: the steps reset).
    private SetPhase(phase: ConsoleInstallPhase, status: ConsoleInstallStatusDto | undefined): void
    {
        this.phase = phase
        this.lastStatus = status
        this.consoleUrl = status?.consoleUrl ?? HiveConsoleViewModel.NoText
        this.devCaFile = status?.devCaFile ?? HiveConsoleViewModel.NoText
        if (status === undefined)
        {
            this.ResetSteps()
            return
        }
        this.SetSteps(status)
    }

    // Steps before the status's step are done; its step is running, failed or
    // (once deployed) done; later steps are pending. Once the console reported, every step is done.
    private SetSteps(status: ConsoleInstallStatusDto): void
    {
        const at = status.state === ConsoleInstallState.Reported
            ? this.steps.Count - 1
            : Math.max(0, this.steps.ToArray().findIndex(s => s.Step === status.step))
        for (let i = 0; i < this.steps.Count; i++)
        {
            const row = this.steps.Get(i)
            if (row === undefined)
            {
                continue
            }
            if (i < at)
            {
                row.SetState(AgentInstallStepState.Done)
            }
            else if (i > at)
            {
                row.SetState(AgentInstallStepState.Pending)
            }
            else
            {
                row.SetState(HiveConsoleViewModel.StateAt(status.state))
            }
        }
    }

    private static StateAt(state: ConsoleInstallState): AgentInstallStepState
    {
        switch (state)
        {
            case ConsoleInstallState.Deployed:
            case ConsoleInstallState.Reported:
                return AgentInstallStepState.Done
            case ConsoleInstallState.Failed:
                return AgentInstallStepState.Failed
            default:
                return AgentInstallStepState.Running
        }
    }

    private ResetSteps(): void
    {
        for (let i = 0; i < this.steps.Count; i++)
        {
            this.steps.Get(i)?.SetState(AgentInstallStepState.Pending)
        }
    }

    // A command whose enabled state follows every change (Change re-raises CanExecute on each).
    private Command(execute: () => Promise<void>, canExecute: () => boolean): RelayCommand
    {
        const command = new RelayCommand(() => { void execute() }, canExecute)
        this.commands.push(command)
        return command
    }

    // Applies a change, then raises each bound value it moved and re-evaluates every command.
    private Change(apply: () => void): void
    {
        const before = this.BoundValues()
        apply()
        const after = this.BoundValues()
        HiveConsoleViewModel.BoundProperties.forEach((name, i) =>
        {
            if (before[i] !== after[i])
            {
                // A secret's old value never rides the notification: its listeners get a neutral one.
                const old = HiveConsoleViewModel.SecretProperties.has(name) ? HiveConsoleViewModel.NoText : before[i]
                this.RaisePropertyChanged(name, old, after[i])
            }
        })
        for (const command of this.commands)
        {
            command.RaiseCanExecuteChanged()
        }
    }

    private BoundValues(): unknown[]
    {
        return HiveConsoleViewModel.BoundProperties.map(name => Reflect.get(this, name) as unknown)
    }
}

// What the install part of the panel showed: its phase and the status behind it.
interface InstallView
{
    readonly phase: ConsoleInstallPhase
    readonly status: ConsoleInstallStatusDto | undefined
}
