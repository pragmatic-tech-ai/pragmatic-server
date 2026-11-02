import { HiveBootstrapBundle, type HiveBootstrapDto } from './hive-bootstrap-bundle.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubectlError } from './kubectl.js'
import { HiveBackend, type HiveRecord } from './platform-records.js'
import { UnknownHiveError } from './rollout-errors.js'

/** Where an automatic agent install stands. Values are the wire strings. */
export enum InstallState
{
    Installing = 'installing',
    Connected = 'connected',
    Failed = 'failed',
}

/** The automatic install's steps, in the order they run. Values are the wire strings. */
export enum InstallStep
{
    PreparingCluster = 'preparing-cluster',
    ApplyingAgent = 'applying-agent',
    StoringToken = 'storing-token',
    RestartingAgent = 'restarting-agent',
    WaitingForCheckIn = 'waiting-for-check-in',
}

/** An install's state as the operator sees it. Never carries the agent token. */
export type InstallStatus = {
    state: InstallState
    step: InstallStep
    startedAt: string
    finishedAt?: string
    error?: string
}

/** Finds a hive record; satisfied by PlatformDirectory. */
export interface IInstallHiveLookup
{
    GetHive(id: string): HiveRecord | undefined
}

/** Resolves the orchestrator (and so the kubectl) for a hive; satisfied by HiveOrchestratorFactory. */
export interface IInstallOrchestratorSource
{
    For(hive: HiveRecord): IHiveOrchestrator
}

/** Issues a fresh agent token (keeping only its hash); satisfied by PlatformDeploymentRegistry. */
export interface IAgentTokenIssuer
{
    RegisterHive(hiveId: string): Promise<string>
}

/** The hive's latest check-in; satisfied by HiveObservationRegistry. */
export interface IInstallCheckInSource
{
    LatestRecord(hiveId: string): { reportedAt: string } | undefined
}

/** Time for the installer: injectable so tests run the check-in wait in virtual time. */
export interface IInstallClock
{
    Now(): number
    Delay(ms: number): Promise<void>
}

export type InstallTiming = { pollIntervalMs: number; timeoutMs: number }

/** The real clock: wall time and a timer that does not keep the process alive. */
export class SystemInstallClock implements IInstallClock
{
    public Now(): number
    {
        return Date.now()
    }

    public Delay(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms).unref())
    }
}

/** An automatic install cannot run for this hive (not Local, or the agent channel is off). Maps to 409. */
export class AgentInstallUnavailableError extends Error
{
    private static readonly ErrorName = 'AgentInstallUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = AgentInstallUnavailableError.ErrorName
    }
}

/** An install is already running for the hive. Maps to 409. */
export class AgentInstallInProgressError extends Error
{
    private static readonly ErrorName = 'AgentInstallInProgressError'
    private static readonly MessagePrefix = 'An agent install is already running for hive '

    public constructor(hiveId: string)
    {
        super(AgentInstallInProgressError.MessagePrefix + hiveId)
        this.name = AgentInstallInProgressError.ErrorName
    }
}

/** One install's mutable state; the installer hands out copies only. */
class InstallRun
{
    public state = InstallState.Installing
    public step = InstallStep.PreparingCluster
    public finishedAt: string | undefined
    public error: string | undefined
    public settled: Promise<void> = Promise.resolve()

    public constructor(public readonly hiveId: string, public readonly startedAt: string)
    {
    }

    public Snapshot(): InstallStatus
    {
        const status: InstallStatus = { state: this.state, step: this.step, startedAt: this.startedAt }
        if (this.finishedAt !== undefined)
        {
            status.finishedAt = this.finishedAt
        }
        if (this.error !== undefined)
        {
            status.error = this.error
        }
        return status
    }
}

/**
 * Installs a hive's agent on a cluster the control plane already drives (backend Local), in the background: prepare
 * the cluster, apply the agent's objects, issue a fresh token and put it in the agent's Secret (through kubectl's
 * stdin), restart the agent, then wait for its first check-in. One install per hive at a time; the latest install's
 * status is kept in memory only. The token never leaves this class except on kubectl's stdin: not in arguments, logs,
 * errors or status.
 */
export class HiveAgentInstaller
{
    public static readonly DefaultTiming: InstallTiming = { pollIntervalMs: 2000, timeoutMs: 15 * 60 * 1000 }

    private static readonly NotLocalMessage = 'Automatic install is not available for this hive: the control plane does not manage its cluster. Install the agent manually.'
    private static readonly ChannelOffMessage = 'Automatic install is not available: the agent channel is not configured (start the control plane with PRAGMATIC_AGENT_CHANNEL_PORT).'
    private static readonly TimeoutMessage = 'The agent did not check in in time. Check that its pod is running in the pragmatic-system namespace, then retry.'
    private static readonly StepFailureMessages: Readonly<Record<InstallStep, string>> = {
        [InstallStep.PreparingCluster]: 'Could not prepare the cluster for the agent.',
        [InstallStep.ApplyingAgent]: 'Could not apply the agent to the cluster.',
        [InstallStep.StoringToken]: 'Could not store the agent token in the cluster.',
        [InstallStep.RestartingAgent]: 'Could not restart the agent.',
        [InstallStep.WaitingForCheckIn]: 'Waiting for the agent to check in failed.',
    }
    private static readonly DetailSeparator = ' '
    private static readonly Redacted = '[REDACTED]'
    private static readonly LogPrefix = '[agent-install] hive '
    private static readonly LogStepInfix = ' failed at '
    private static readonly LogErrorInfix = ': '
    private static readonly UnknownErrorName = 'Error'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly TypeKey = 'type'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly StringDataKey = 'stringData'
    private static readonly ApiVersionCore = 'v1'
    private static readonly SecretKind = 'Secret'
    private static readonly OpaqueType = 'Opaque'

    private readonly runs = new Map<string, InstallRun>()

    public constructor(
        private readonly hives: IInstallHiveLookup,
        private readonly orchestrators: IInstallOrchestratorSource,
        private readonly tokens: IAgentTokenIssuer,
        private readonly checkIns: IInstallCheckInSource,
        private readonly agentChannelUrl: string | undefined,
        private readonly clock: IInstallClock = new SystemInstallClock(),
        private readonly timing: InstallTiming = HiveAgentInstaller.DefaultTiming)
    {
    }

    /** Whether an automatic install can run for this hive: its cluster is one the control plane drives, and the agent channel is on. */
    public Supports(hive: HiveRecord): boolean
    {
        return hive.cluster.backend === HiveBackend.Local && this.agentChannelUrl !== undefined
    }

    /** Begins an install in the background and returns its first status. Throws for an unknown, unsupported or busy hive. */
    public Start(hiveId: string): InstallStatus
    {
        const hive = this.hives.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        if (hive.cluster.backend !== HiveBackend.Local)
        {
            throw new AgentInstallUnavailableError(HiveAgentInstaller.NotLocalMessage)
        }
        const channelUrl = this.agentChannelUrl
        if (channelUrl === undefined)
        {
            throw new AgentInstallUnavailableError(HiveAgentInstaller.ChannelOffMessage)
        }
        if (this.runs.get(hiveId)?.state === InstallState.Installing)
        {
            throw new AgentInstallInProgressError(hiveId)
        }
        const run = new InstallRun(hiveId, new Date(this.clock.Now()).toISOString())
        this.runs.set(hiveId, run)
        run.settled = this.Run(run, hive, channelUrl)
        return run.Snapshot()
    }

    /** The latest install's status for the hive; undefined when none has run since the control plane started. */
    public StatusFor(hiveId: string): InstallStatus | undefined
    {
        return this.runs.get(hiveId)?.Snapshot()
    }

    /** Resolves once the hive's latest install has settled (Connected or Failed), with its final status. */
    public async WhenSettled(hiveId: string): Promise<InstallStatus | undefined>
    {
        const run = this.runs.get(hiveId)
        if (run === undefined)
        {
            return undefined
        }
        await run.settled
        return run.Snapshot()
    }

    /** Runs the steps; never rejects: a failure is recorded on the run. */
    private async Run(run: InstallRun, hive: HiveRecord, channelUrl: string): Promise<void>
    {
        // Yield first, so Start returns before any step runs (and any synchronous step failure is still recorded).
        await Promise.resolve()
        let token: string | undefined
        try
        {
            const orchestrator = this.orchestrators.For(hive)
            const bundle = HiveBootstrapBundle.For(hive.id, channelUrl, true)
            run.step = InstallStep.PreparingCluster
            await orchestrator.PrepareAgent(K8sManifestBuilder.AgentImage)
            run.step = InstallStep.ApplyingAgent
            await orchestrator.Kubectl.Apply(bundle.manifest)
            run.step = InstallStep.StoringToken
            token = await this.tokens.RegisterHive(hive.id)
            const issuedAt = this.clock.Now()
            await orchestrator.Kubectl.Apply(HiveAgentInstaller.SecretManifest(bundle, token))
            token = undefined
            run.step = InstallStep.RestartingAgent
            await orchestrator.Kubectl.RolloutRestart(bundle.namespace, bundle.agentName)
            run.step = InstallStep.WaitingForCheckIn
            await this.WaitForCheckIn(run, issuedAt)
        }
        catch (err)
        {
            this.Fail(run, err, token)
        }
    }

    /** Polls the hive's check-ins until one newer than the token's issue arrives (only the new token can report then), or times out. */
    private async WaitForCheckIn(run: InstallRun, issuedAt: number): Promise<void>
    {
        const deadline = this.clock.Now() + this.timing.timeoutMs
        for (;;)
        {
            const latest = this.checkIns.LatestRecord(run.hiveId)
            if (latest !== undefined && Date.parse(latest.reportedAt) > issuedAt)
            {
                run.state = InstallState.Connected
                run.finishedAt = new Date(this.clock.Now()).toISOString()
                return
            }
            if (this.clock.Now() >= deadline)
            {
                run.state = InstallState.Failed
                run.error = HiveAgentInstaller.TimeoutMessage
                run.finishedAt = new Date(this.clock.Now()).toISOString()
                return
            }
            await this.clock.Delay(this.timing.pollIntervalMs)
        }
    }

    /** Records a failed step: the fixed step message, plus kubectl's (already redacted) text with any token occurrence scrubbed too. */
    private Fail(run: InstallRun, err: unknown, token: string | undefined): void
    {
        let message = HiveAgentInstaller.StepFailureMessages[run.step]
        if (err instanceof KubectlError)
        {
            message += HiveAgentInstaller.DetailSeparator + err.message
        }
        if (token !== undefined && token.length > 0)
        {
            message = message.split(token).join(HiveAgentInstaller.Redacted)
        }
        run.state = InstallState.Failed
        run.error = message
        run.finishedAt = new Date(this.clock.Now()).toISOString()
        // The error's name only: a raw message may carry cluster output.
        const name = err instanceof Error ? err.name : HiveAgentInstaller.UnknownErrorName
        console.error(HiveAgentInstaller.LogPrefix + run.hiveId + HiveAgentInstaller.LogStepInfix + run.step + HiveAgentInstaller.LogErrorInfix + name)
    }

    /** The agent token's Secret as a v1 manifest; applied through kubectl's stdin, never written anywhere else. */
    private static SecretManifest(bundle: HiveBootstrapDto, token: string): string
    {
        const C = HiveAgentInstaller
        return JSON.stringify({
            [C.ApiVersionKey]: C.ApiVersionCore,
            [C.KindKey]: C.SecretKind,
            [C.TypeKey]: C.OpaqueType,
            [C.MetadataKey]: { [C.NameKey]: bundle.tokenSecretName, [C.NamespaceKey]: bundle.namespace },
            [C.StringDataKey]: { [bundle.tokenSecretKey]: token },
        })
    }
}
