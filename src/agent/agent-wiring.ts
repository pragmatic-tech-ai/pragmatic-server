import type { IServerDeployment } from './k8s-api.js'
import type { IEnvironmentState } from './rollout-agent.js'

/** Pure, cluster-free helpers for the per-hive agent wiring (kept apart from agent-main so they are importable without starting the loop). */
export class AgentWiring
{
    private static readonly HiveLabel = 'pragmatic/hive'
    private static readonly SelectorOperator = '='
    private static readonly NamespacePrefix = 'pragmatic-env-'
    private static readonly TargetPathTemplate = '/agent/hives/{hive}/target'
    private static readonly SnapshotPathTemplate = '/agent/hives/{hive}/snapshot'
    private static readonly HiveToken = '{hive}'
    private static readonly MissingEnvPrefix = 'missing required environment variable '
    private static readonly Empty = ''

    private constructor()
    {
    }

    public static LabelSelector(hiveId: string): string
    {
        return AgentWiring.HiveLabel + AgentWiring.SelectorOperator + hiveId
    }

    public static TargetUrl(baseUrl: string, hiveId: string): string
    {
        return baseUrl + AgentWiring.PathOf(AgentWiring.TargetPathTemplate, hiveId)
    }

    public static SnapshotUrl(baseUrl: string, hiveId: string): string
    {
        return baseUrl + AgentWiring.PathOf(AgentWiring.SnapshotPathTemplate, hiveId)
    }

    public static EnvironmentName(namespace: string): string
    {
        return namespace.startsWith(AgentWiring.NamespacePrefix) ? namespace.slice(AgentWiring.NamespacePrefix.length) : namespace
    }

    public static ToEnvironmentState(item: IServerDeployment): IEnvironmentState
    {
        return {
            environmentName: AgentWiring.EnvironmentName(item.namespace),
            namespace: item.namespace,
            deployment: item.deployment,
            container: item.container,
            runningImage: item.runningImage,
            ready: item.ready,
        }
    }

    public static Required(key: string): string
    {
        const value = process.env[key]
        if (value === undefined || value === AgentWiring.Empty)
        {
            throw new Error(AgentWiring.MissingEnvPrefix + key)
        }
        return value
    }

    private static PathOf(template: string, hiveId: string): string
    {
        return template.replace(AgentWiring.HiveToken, encodeURIComponent(hiveId))
    }
}
