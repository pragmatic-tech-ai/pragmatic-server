import { InClusterK8sApi } from './k8s-api.js'
import { RolloutAgent } from './rollout-agent.js'
import type { IRolloutTarget } from './rollout-agent.js'
import { StructuredLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'

class AgentMain
{
    private static readonly RegistryUrlEnv = 'PRAGMATIC_AGENT_REGISTRY_URL'
    private static readonly HiveIdEnv = 'PRAGMATIC_AGENT_HIVE_ID'
    private static readonly EnvNameEnv = 'PRAGMATIC_AGENT_ENV_NAME'
    private static readonly TokenEnv = 'PRAGMATIC_AGENT_TOKEN'
    private static readonly PollIntervalEnv = 'PRAGMATIC_AGENT_POLL_INTERVAL_MS'
    private static readonly MaxBackoffEnv = 'PRAGMATIC_AGENT_MAX_BACKOFF_MS'
    private static readonly DefaultPollIntervalMs = 30000
    private static readonly DefaultMaxBackoffMs = 300000
    private static readonly BackoffFactor = 2
    private static readonly RequestTimeoutMs = 10000

    private static readonly NamespacePrefix = 'pragmatic-env-'
    private static readonly ServerDeploymentSuffix = '-server'
    private static readonly ServerContainer = 'server'

    private static readonly TargetPathTemplate = '/api/hives/{hive}/agent/target'
    private static readonly ReportPathTemplate = '/api/hives/{hive}/agent/report'
    private static readonly HiveToken = '{hive}'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly PostMethod = 'POST'
    private static readonly NotFound = 404
    private static readonly TrailingSlash = /\/+$/
    private static readonly Empty = ''

    private static readonly MissingEnvPrefix = 'missing required environment variable '
    private static readonly RegistryFailurePrefix = 'registry request failed with status '
    private static readonly TickFailedPrefix = 'rollout tick failed: '
    private static readonly StartFailedPrefix = 'pragmatic-agentd failed to start: '
    private static readonly StartedLine = 'pragmatic-agentd started'
    private static readonly UnknownError = 'unknown error'
    private static readonly EventKey = 'event'
    private static readonly TickFailedEvent = 'tick-failed'
    private static readonly StartupEvent = 'startup'
    private static readonly StartFailedEvent = 'start-failed'
    private static readonly HiveKey = 'hiveId'
    private static readonly BackoffKey = 'backoffMs'

    private constructor()
    {
    }

    public static async Run(): Promise<void>
    {
        const logger = StructuredLogger.ToStdout()
        const registryUrl = AgentMain.Required(AgentMain.RegistryUrlEnv).replace(AgentMain.TrailingSlash, AgentMain.Empty)
        const hiveId = AgentMain.Required(AgentMain.HiveIdEnv)
        const envName = AgentMain.Required(AgentMain.EnvNameEnv)
        const token = AgentMain.Required(AgentMain.TokenEnv)
        const pollMs = AgentMain.PositiveInt(AgentMain.PollIntervalEnv, AgentMain.DefaultPollIntervalMs)
        const maxBackoffMs = AgentMain.PositiveInt(AgentMain.MaxBackoffEnv, AgentMain.DefaultMaxBackoffMs)

        const k8s = new InClusterK8sApi()
        const namespace = AgentMain.NamespacePrefix + envName
        const deployment = namespace + AgentMain.ServerDeploymentSuffix
        const targetUrl = registryUrl + AgentMain.PathOf(AgentMain.TargetPathTemplate, hiveId)
        const reportUrl = registryUrl + AgentMain.PathOf(AgentMain.ReportPathTemplate, hiveId)
        const agent = new RolloutAgent({
            fetchTarget: () => AgentMain.FetchTarget(targetUrl, token),
            readRunningImage: () => k8s.ReadDeploymentImage(namespace, deployment, AgentMain.ServerContainer),
            patchImage: image => k8s.PatchDeploymentImage(namespace, deployment, AgentMain.ServerContainer, image),
            report: (runningImage, ready) => AgentMain.Report(reportUrl, token, envName, runningImage, ready),
        })
        logger.Info(AgentMain.StartedLine, { [AgentMain.EventKey]: AgentMain.StartupEvent, [AgentMain.HiveKey]: hiveId })
        void AgentMain.Loop(agent, logger, pollMs, maxBackoffMs)
    }

    public static Fail(error: unknown): void
    {
        StructuredLogger.ToStdout().Error(AgentMain.StartFailedPrefix + (error instanceof Error ? error.message : AgentMain.UnknownError), { [AgentMain.EventKey]: AgentMain.StartFailedEvent })
        process.exit(1)
    }

    private static async Loop(agent: RolloutAgent, logger: ILogger, pollMs: number, maxBackoffMs: number): Promise<void>
    {
        let delay = pollMs
        for (;;)
        {
            try
            {
                await agent.Tick()
                delay = pollMs
            }
            catch (error)
            {
                // message only: never the token, headers or request bodies
                delay = Math.min(delay * AgentMain.BackoffFactor, maxBackoffMs)
                logger.Error(AgentMain.TickFailedPrefix + (error instanceof Error ? error.message : AgentMain.UnknownError), { [AgentMain.EventKey]: AgentMain.TickFailedEvent, [AgentMain.BackoffKey]: delay })
            }
            await new Promise<void>(resolve => setTimeout(resolve, delay))
        }
    }

    private static async FetchTarget(url: string, token: string): Promise<IRolloutTarget | undefined>
    {
        const response = await AgentMain.TimedFetch(url, { headers: { [AgentMain.AuthorizationHeader]: AgentMain.BearerPrefix + token } })
        if (response.status === AgentMain.NotFound)
        {
            return undefined
        }
        if (!response.ok)
        {
            throw new Error(AgentMain.RegistryFailurePrefix + response.status)
        }
        return await response.json() as IRolloutTarget
    }

    private static async Report(url: string, token: string, environmentName: string, runningImage: string, ready: boolean): Promise<void>
    {
        const response = await AgentMain.TimedFetch(url, {
            method: AgentMain.PostMethod,
            headers: { [AgentMain.AuthorizationHeader]: AgentMain.BearerPrefix + token, [AgentMain.ContentTypeHeader]: AgentMain.JsonType },
            body: JSON.stringify({ environmentName, runningImage, ready }),
        })
        if (!response.ok)
        {
            throw new Error(AgentMain.RegistryFailurePrefix + response.status)
        }
    }

    /** fetch bounded by RequestTimeoutMs: an abort rejects (the loop's catch backs off) instead of hanging the single-threaded loop. */
    private static async TimedFetch(url: string, init: RequestInit): Promise<Response>
    {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), AgentMain.RequestTimeoutMs)
        try
        {
            return await fetch(url, { ...init, signal: controller.signal })
        }
        finally
        {
            clearTimeout(timer)
        }
    }

    private static PathOf(template: string, hiveId: string): string
    {
        return template.replace(AgentMain.HiveToken, encodeURIComponent(hiveId))
    }

    private static Required(key: string): string
    {
        const value = process.env[key]
        if (value === undefined || value === AgentMain.Empty)
        {
            throw new Error(AgentMain.MissingEnvPrefix + key)
        }
        return value
    }

    private static PositiveInt(key: string, fallback: number): number
    {
        const parsed = Number(process.env[key])
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    }
}

AgentMain.Run().catch(AgentMain.Fail)
