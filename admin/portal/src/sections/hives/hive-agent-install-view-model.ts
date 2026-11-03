import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../../api-client.js'
import { AgentInstallState, AgentInstallStep, type AgentInstallStatusDto } from '../../portal-types.js'
import { TimerPollScheduler, type IPollScheduler } from '../../shell/poll-scheduler.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'

// Where one install step stands, as the step list shows it.
export enum AgentInstallStepState
{
    Pending,
    Running,
    Done,
    Failed,
}

// Where the automatic install stands, as the panel shows it. Idle: none has
// run (or the control plane forgot it on a restart); Starting: the start
// request is in flight.
export enum AgentInstallPhase
{
    Idle,
    Starting,
    Installing,
    Connected,
    Failed,
}

// One row of the install's step list: its label and whether it is pending,
// running, done or failed. Every row is a real step the control plane runs.
export class AgentInstallStepViewModel extends Observable
{
    private static readonly RunningLabel = 'In progress'
    private static readonly DoneLabel = 'Done'
    private static readonly FailedLabel = 'Failed'
    private static readonly PendingLabel = ''
    private static readonly StateProperty = 'State'
    private static readonly StatusLabelProperty = 'StatusLabel'
    private static readonly IsRunningProperty = 'IsRunning'
    private static readonly IsDoneProperty = 'IsDone'
    private static readonly IsFailedProperty = 'IsFailed'
    private static readonly IsPendingProperty = 'IsPending'
    private static readonly IsReachedProperty = 'IsReached'

    private state = AgentInstallStepState.Pending

    public constructor(public readonly Step: AgentInstallStep, public readonly Label: string)
    {
        super()
    }

    public get State(): AgentInstallStepState
    {
        return this.state
    }

    public get StatusLabel(): string
    {
        switch (this.state)
        {
            case AgentInstallStepState.Running:
                return AgentInstallStepViewModel.RunningLabel
            case AgentInstallStepState.Done:
                return AgentInstallStepViewModel.DoneLabel
            case AgentInstallStepState.Failed:
                return AgentInstallStepViewModel.FailedLabel
            default:
                return AgentInstallStepViewModel.PendingLabel
        }
    }

    public get IsPending(): boolean
    {
        return this.state === AgentInstallStepState.Pending
    }

    // Whether the install has reached this step (running, done or failed).
    public get IsReached(): boolean
    {
        return this.state !== AgentInstallStepState.Pending
    }

    public get IsRunning(): boolean
    {
        return this.state === AgentInstallStepState.Running
    }

    public get IsDone(): boolean
    {
        return this.state === AgentInstallStepState.Done
    }

    public get IsFailed(): boolean
    {
        return this.state === AgentInstallStepState.Failed
    }

    public SetState(next: AgentInstallStepState): void
    {
        const old = this.state
        if (old === next)
        {
            return
        }
        const C = AgentInstallStepViewModel
        const was = [this.StatusLabel, this.IsPending, this.IsRunning, this.IsDone, this.IsFailed] as const
        this.state = next
        this.RaisePropertyChanged(C.StateProperty, old, next)
        this.RaisePropertyChanged(C.StatusLabelProperty, was[0], this.StatusLabel)
        this.RaisePropertyChanged(C.IsPendingProperty, was[1], this.IsPending)
        this.RaisePropertyChanged(C.IsReachedProperty, !was[1], this.IsReached)
        this.RaisePropertyChanged(C.IsRunningProperty, was[2], this.IsRunning)
        this.RaisePropertyChanged(C.IsDoneProperty, was[3], this.IsDone)
        this.RaisePropertyChanged(C.IsFailedProperty, was[4], this.IsFailed)
    }
}

// The automatic agent install of one Local hive: Install agent (and Retry)
// start it on the control plane, which runs every step itself; the panel then
// polls its status every 2 seconds until the agent checks in (Connected) or a
// step fails (the error and Retry). The agent token never reaches the
// browser on this path. Polling runs only while the owning page is showing:
// the page calls Resume when shown and Stop when left.
export class HiveAgentInstallViewModel extends Observable
{
    public static readonly PollIntervalMs = 2000

    private static readonly StepLabels: ReadonlyArray<readonly [AgentInstallStep, string]> = [
        [AgentInstallStep.PreparingCluster, 'Prepare the cluster'],
        [AgentInstallStep.ApplyingAgent, 'Apply the agent'],
        [AgentInstallStep.StoringToken, 'Store the agent token in the cluster'],
        [AgentInstallStep.RestartingAgent, 'Restart the agent'],
        [AgentInstallStep.WaitingForCheckIn, 'Wait for the agent to check in'],
    ]
    private static readonly StartingText = 'Starting the install...'
    private static readonly InstallingText = 'Installing the agent. On a fresh cluster the first start can take several minutes while the agent image loads.'
    private static readonly ConnectedText = 'Connected. The agent checked in.'
    private static readonly FailedText = 'The install stopped.'
    private static readonly NoText = ''
    private static readonly PhaseProperty = 'Phase'
    private static readonly IsIdleProperty = 'IsIdle'
    private static readonly IsInstallingProperty = 'IsInstalling'
    private static readonly IsConnectedProperty = 'IsConnected'
    private static readonly IsFailedProperty = 'IsFailed'
    private static readonly HasProgressProperty = 'HasProgress'
    private static readonly StatusTextProperty = 'StatusText'
    private static readonly ErrorTextProperty = 'ErrorText'
    // The bound names a page watches to react to the install connecting or failing.
    public static readonly ConnectedProperty = HiveAgentInstallViewModel.IsConnectedProperty
    public static readonly FailedProperty = HiveAgentInstallViewModel.IsFailedProperty
    public static readonly InstallingProperty = HiveAgentInstallViewModel.IsInstallingProperty
    public static readonly PhaseChangedProperty = HiveAgentInstallViewModel.PhaseProperty

    private readonly steps = new ObservableCollection<AgentInstallStepViewModel>()
    private readonly startCommand: RelayCommand
    private readonly retryCommand: RelayCommand
    private phase = AgentInstallPhase.Idle
    private errorText = HiveAgentInstallViewModel.NoText
    // Bumped by Stop (and by each Start / Resume): a reply for an older
    // generation is dropped, so a left page never resumes polling.
    private generation = 0
    private pending: IDisposable | undefined

    public constructor(
        private readonly session: PortalSessionService,
        public readonly HiveId: string,
        private readonly scheduler: IPollScheduler = new TimerPollScheduler(),
        private readonly intervalMs: number = HiveAgentInstallViewModel.PollIntervalMs)
    {
        super()
        for (const [step, label] of HiveAgentInstallViewModel.StepLabels)
        {
            this.steps.Add(new AgentInstallStepViewModel(step, label))
        }
        this.startCommand = new RelayCommand(() => { void this.Start() }, () => this.CanStart)
        this.retryCommand = new RelayCommand(() => { void this.Start() }, () => this.CanStart && this.IsFailed)
    }

    public get Steps(): ObservableCollection<AgentInstallStepViewModel>
    {
        return this.steps
    }

    public get Phase(): AgentInstallPhase
    {
        return this.phase
    }

    public get IsIdle(): boolean
    {
        return this.phase === AgentInstallPhase.Idle
    }

    public get IsInstalling(): boolean
    {
        return this.phase === AgentInstallPhase.Starting || this.phase === AgentInstallPhase.Installing
    }

    public get IsConnected(): boolean
    {
        return this.phase === AgentInstallPhase.Connected
    }

    public get IsFailed(): boolean
    {
        return this.phase === AgentInstallPhase.Failed
    }

    // Whether there is an install to show (running or finished).
    public get HasProgress(): boolean
    {
        return this.phase !== AgentInstallPhase.Idle
    }

    public get StatusText(): string
    {
        const C = HiveAgentInstallViewModel
        switch (this.phase)
        {
            case AgentInstallPhase.Starting:
                return C.StartingText
            case AgentInstallPhase.Installing:
                return C.InstallingText
            case AgentInstallPhase.Connected:
                return C.ConnectedText
            case AgentInstallPhase.Failed:
                return C.FailedText
            default:
                return C.NoText
        }
    }

    // Why the install failed; '' otherwise.
    public get ErrorText(): string
    {
        return this.errorText
    }

    // Whether an install may start now: the operator may mutate and none is running.
    public get CanStart(): boolean
    {
        return this.session.CanMutate && !this.IsInstalling
    }

    // Install agent: issues a fresh token on the control plane and (re)installs the agent with it.
    public get StartCommand(): RelayCommand
    {
        return this.startCommand
    }

    // Retry after a failure: a fresh run from the first step.
    public get RetryCommand(): RelayCommand
    {
        return this.retryCommand
    }

    // Starts an install and polls it. Never throws: a refusal shows as Failed
    // with its message, unless an install is already running for the hive, in
    // which case the panel follows that one. A 401 expires the session.
    public async Start(): Promise<void>
    {
        if (!this.CanStart)
        {
            return
        }
        const generation = this.Restart()
        this.Apply(AgentInstallPhase.Starting, undefined, HiveAgentInstallViewModel.NoText)
        let status: AgentInstallStatusDto
        try
        {
            status = await this.session.Client.StartAgentInstall(this.HiveId)
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

    // Reads the hive's latest install (a page was shown); polls it while it
    // runs. Never throws.
    public async Resume(): Promise<void>
    {
        const generation = this.Restart()
        await this.Read(generation)
    }

    // Stops polling (the page was left). A reply already in flight is dropped.
    public Stop(): void
    {
        this.generation++
        this.CancelPending()
    }

    private Restart(): number
    {
        this.Stop()
        return this.generation
    }

    private async Read(generation: number): Promise<void>
    {
        let status: AgentInstallStatusDto | null
        try
        {
            status = await this.session.Client.GetAgentInstall(this.HiveId)
        }
        catch (e)
        {
            if (generation !== this.generation)
            {
                return
            }
            if (this.Expired(e))
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
            this.Apply(AgentInstallPhase.Idle, undefined, HiveAgentInstallViewModel.NoText)
            return
        }
        this.Follow(generation, status)
    }

    // A refused start: follow the hive's running install when there is one
    // (another operator started it), else show the refusal.
    private async Refused(generation: number, e: unknown): Promise<void>
    {
        if (this.Expired(e))
        {
            return
        }
        const message = e instanceof Error ? e.message : String(e)
        let current: AgentInstallStatusDto | null = null
        try
        {
            current = await this.session.Client.GetAgentInstall(this.HiveId)
        }
        catch
        {
            current = null
        }
        if (generation !== this.generation)
        {
            return
        }
        if (current !== null && current.state === AgentInstallState.Installing)
        {
            this.Follow(generation, current)
            return
        }
        this.ResetSteps()
        this.Apply(AgentInstallPhase.Failed, undefined, message)
    }

    private Follow(generation: number, status: AgentInstallStatusDto): void
    {
        if (generation !== this.generation)
        {
            return
        }
        const phase = HiveAgentInstallViewModel.PhaseOf(status.state)
        this.Apply(phase, status, status.error ?? HiveAgentInstallViewModel.NoText)
        if (phase === AgentInstallPhase.Installing)
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

    private static PhaseOf(state: AgentInstallState): AgentInstallPhase
    {
        switch (state)
        {
            case AgentInstallState.Connected:
                return AgentInstallPhase.Connected
            case AgentInstallState.Failed:
                return AgentInstallPhase.Failed
            default:
                return AgentInstallPhase.Installing
        }
    }

    // Sets the phase and error, and the step list from a status when given.
    private Apply(phase: AgentInstallPhase, status: AgentInstallStatusDto | undefined, error: string): void
    {
        const C = HiveAgentInstallViewModel
        const before = [this.phase, this.IsIdle, this.IsInstalling, this.IsConnected, this.IsFailed, this.HasProgress, this.StatusText, this.errorText] as const
        if (status !== undefined)
        {
            this.SetSteps(status)
        }
        else if (phase === AgentInstallPhase.Starting || phase === AgentInstallPhase.Idle)
        {
            this.ResetSteps()
        }
        this.phase = phase
        this.errorText = error
        this.RaiseIfChanged(C.PhaseProperty, before[0], this.phase)
        this.RaiseIfChanged(C.IsIdleProperty, before[1], this.IsIdle)
        this.RaiseIfChanged(C.IsInstallingProperty, before[2], this.IsInstalling)
        this.RaiseIfChanged(C.IsConnectedProperty, before[3], this.IsConnected)
        this.RaiseIfChanged(C.IsFailedProperty, before[4], this.IsFailed)
        this.RaiseIfChanged(C.HasProgressProperty, before[5], this.HasProgress)
        this.RaiseIfChanged(C.StatusTextProperty, before[6], this.StatusText)
        this.RaiseIfChanged(C.ErrorTextProperty, before[7], this.errorText)
        this.startCommand.RaiseCanExecuteChanged()
        this.retryCommand.RaiseCanExecuteChanged()
    }

    // Steps before the status's step are done; its step is running, failed or
    // (once connected) done; later steps are pending.
    private SetSteps(status: AgentInstallStatusDto): void
    {
        const at = this.IndexOf(status.step)
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
                row.SetState(HiveAgentInstallViewModel.StateAt(status.state))
            }
        }
    }

    private static StateAt(state: AgentInstallState): AgentInstallStepState
    {
        switch (state)
        {
            case AgentInstallState.Connected:
                return AgentInstallStepState.Done
            case AgentInstallState.Failed:
                return AgentInstallStepState.Failed
            default:
                return AgentInstallStepState.Running
        }
    }

    private IndexOf(step: AgentInstallStep): number
    {
        for (let i = 0; i < this.steps.Count; i++)
        {
            if (this.steps.Get(i)?.Step === step)
            {
                return i
            }
        }
        return 0
    }

    private ResetSteps(): void
    {
        for (let i = 0; i < this.steps.Count; i++)
        {
            this.steps.Get(i)?.SetState(AgentInstallStepState.Pending)
        }
    }

    private RaiseIfChanged<T>(name: string, old: T, now: T): void
    {
        if (old !== now)
        {
            this.RaisePropertyChanged(name, old, now)
        }
    }
}
