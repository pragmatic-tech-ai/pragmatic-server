import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../../api-client.js'
import { ConsoleInstallState, ConsoleInstallStep, IngressTlsSource, type ConsoleInstallStatusDto, type HiveConsoleSpecDto, type HiveDto } from '../../portal-types.js'
import type { OptionViewModel } from '../../shell/option-view-model.js'
import { TimerPollScheduler, type IPollScheduler } from '../../shell/poll-scheduler.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { AgentInstallStepState, AgentInstallStepViewModel } from './hive-agent-install-view-model.js'
import { HiveOptions } from './hive-options.js'

// Where the console install stands, as the panel shows it. Idle: none has run
// (or the control plane forgot it on a restart); Starting: the start request
// is in flight; Deployed: the console runs, its first report is still to come.
export enum ConsoleInstallPhase
{
    Idle,
    Starting,
    Installing,
    Deployed,
    Failed,
}

// The tenant console of one hive: where it is served (base domain, optional
// host, TLS source) and Save / Remove for those settings; Install console
// (and Retry), which the control plane runs itself while the panel polls its
// status every 2 seconds; and, once deployed, a fresh Owner password for the
// console's identity provider, shown once and cleared when the page is left.
// Polling runs only while the owning page is showing: the page calls Resume
// when shown and Stop when left.
export class HiveConsoleViewModel extends Observable
{
    public static readonly PollIntervalMs = 2000

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
    private static readonly NoText = ''
    private static readonly HostPrefix = 'console-'
    private static readonly HostSeparator = '.'
    private static readonly BaseDomainHint = '<base domain>'
    private static readonly TrustCommandPrefix = 'powershell -NoProfile -ExecutionPolicy Bypass -File admin\\control-plane\\dev\\dev-ca-trust.ps1 -Install -CaFile "'
    private static readonly TrustCommandSuffix = '"'
    // Every bound value a change can move, raised when it did.
    private static readonly BoundProperties: readonly string[] = [
        'BaseDomain', 'Host', 'HostPlaceholder', 'SelectedTls', 'SecretName', 'ClusterIssuer',
        'IsExistingSecret', 'IsCertManager', 'IsDevelopment', 'IsConfigured', 'IsNotConfigured',
        'Phase', 'IsIdle', 'IsInstalling', 'IsDeployed', 'IsFailed', 'HasProgress', 'StatusText',
        'ConsoleUrl', 'HasConsoleUrl', 'DevTrustCommand', 'HasDevTrustCommand',
        'OwnerEmail', 'OwnerPassword', 'HasOwnerPassword', 'ErrorText', 'IsBusy', 'IsConfirmingRemove',
    ]

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
    private tenantId = ''
    private saved: HiveConsoleSpecDto | undefined
    private baseDomain = ''
    private host = ''
    private selectedTls: OptionViewModel<IngressTlsSource> | undefined
    private secretName = ''
    private clusterIssuer = ''
    private phase = ConsoleInstallPhase.Idle
    private consoleUrl = ''
    private devCaFile = ''
    private errorText = ''
    // The Owner password reset's reply, held only for display until Stop.
    private ownerEmail = ''
    private ownerPassword = ''
    // A settings write, removal or password reset in flight.
    private busy = false
    private confirmingRemove = false
    // Bumped by Stop (and by each Install / Resume): a reply for an older
    // generation is dropped, so a left page never resumes polling.
    private generation = 0
    private pending: IDisposable | undefined

    public constructor(
        private readonly session: PortalSessionService,
        public readonly HiveId: string,
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
    }

    // Takes the hive's record as the control plane holds it: its tenant and its saved console settings, which the fields show.
    public Load(hive: HiveDto): void
    {
        this.Change(() =>
        {
            this.tenantId = hive.tenantId
            this.ShowSettings(hive.console)
        })
    }

    public get BaseDomain(): string
    {
        return this.baseDomain
    }

    public set BaseDomain(value: string)
    {
        this.Change(() => { this.baseDomain = value })
    }

    // The console's browser host; empty uses HostPlaceholder.
    public get Host(): string
    {
        return this.host
    }

    public set Host(value: string)
    {
        this.Change(() => { this.host = value })
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
        this.Change(() => { this.selectedTls = value })
    }

    // The existing kubernetes.io/tls Secret in pragmatic-system (existing-secret only).
    public get SecretName(): string
    {
        return this.secretName
    }

    public set SecretName(value: string)
    {
        this.Change(() => { this.secretName = value })
    }

    // The cert-manager ClusterIssuer (cert-manager only).
    public get ClusterIssuer(): string
    {
        return this.clusterIssuer
    }

    public set ClusterIssuer(value: string)
    {
        this.Change(() => { this.clusterIssuer = value })
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

    public get IsDeployed(): boolean
    {
        return this.phase === ConsoleInstallPhase.Deployed
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
            case ConsoleInstallPhase.Failed:
                return C.FailedText
            default:
                return C.NoText
        }
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

    // Why the last action (or the install) failed; '' otherwise.
    public get ErrorText(): string
    {
        return this.errorText
    }

    public get IsBusy(): boolean
    {
        return this.busy
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

    private get CanSetOwnerPassword(): boolean
    {
        return this.session.CanMutate && !this.busy && this.IsConfigured && this.IsDeployed
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
            const hive = await this.session.Client.RemoveHiveConsole(this.HiveId)
            this.Stop()
            this.Change(() =>
            {
                this.ShowSettings(hive.console)
                this.SetPhase(ConsoleInstallPhase.Idle, undefined)
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
                await this.Refused(generation, e)
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
        const generation = this.generation
        await this.Request(async () =>
        {
            const reset = await this.session.Client.ResetInHiveOwnerPassword(this.HiveId)
            // A page left meanwhile never shows it.
            if (generation !== this.generation)
            {
                return
            }
            this.Change(() =>
            {
                this.ownerEmail = reset.ownerEmail
                this.ownerPassword = reset.ownerPassword
            })
        })
    }

    // Reads the hive's latest install (a page was shown); polls it while it runs. Never throws.
    public async Resume(): Promise<void>
    {
        const generation = this.Restart()
        await this.Read(generation)
    }

    // Stops polling and forgets the shown Owner password (the page was left). A reply already in flight is dropped.
    public Stop(): void
    {
        this.generation++
        this.CancelPending()
        if (this.ownerPassword.length > 0 || this.ownerEmail.length > 0 || this.confirmingRemove)
        {
            this.Change(() =>
            {
                this.ownerEmail = HiveConsoleViewModel.NoText
                this.ownerPassword = HiveConsoleViewModel.NoText
                this.confirmingRemove = false
            })
        }
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
        return spec
    }

    // Shows saved settings in the fields (no settings: the fields stay as typed).
    private ShowSettings(spec: HiveConsoleSpecDto | undefined): void
    {
        this.saved = spec
        if (spec === undefined)
        {
            return
        }
        this.baseDomain = spec.baseDomain
        this.host = spec.host ?? HiveConsoleViewModel.NoText
        this.selectedTls = this.tlsOptions.ToArray().find(o => o.Value === spec.tls.source) ?? this.selectedTls
        this.secretName = spec.tls.secretName ?? HiveConsoleViewModel.NoText
        this.clusterIssuer = spec.tls.clusterIssuer ?? HiveConsoleViewModel.NoText
    }

    // Runs one settings or password request: busy while it runs, its refusal in ErrorText, a 401 expires the session.
    private async Request(action: () => Promise<void>): Promise<void>
    {
        this.Change(() =>
        {
            this.busy = true
            this.errorText = HiveConsoleViewModel.NoText
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
            // A transient read failure: keep following a running install.
            if (this.IsInstalling)
            {
                this.Schedule(generation)
            }
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

    // A refused start: follow the hive's running install when there is one, else show the refusal.
    private async Refused(generation: number, e: unknown): Promise<void>
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
            this.SetPhase(ConsoleInstallPhase.Failed, undefined)
            this.errorText = HiveConsoleViewModel.MessageOf(e)
        })
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
        if (phase === ConsoleInstallPhase.Installing)
        {
            this.Schedule(generation)
        }
    }

    private Schedule(generation: number): void
    {
        this.CancelPending()
        this.pending = this.scheduler.Schedule(this.intervalMs, () =>
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
    // (once deployed) done; later steps are pending.
    private SetSteps(status: ConsoleInstallStatusDto): void
    {
        const at = Math.max(0, this.steps.ToArray().findIndex(s => s.Step === status.step))
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
                this.RaisePropertyChanged(name, before[i], after[i])
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
