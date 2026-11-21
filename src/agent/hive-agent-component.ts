import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'

/**
 * The component descriptor of the hive agent image (pragmatic-agentd): what `AgentMain` reads. It polls the platform's
 * agent channel and patches the hive's deployments; it listens on no port and stores nothing.
 */
export class HiveAgentComponent
{
    public static readonly Name = 'pragmatic-hive-agent'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.0'

    private static readonly Declaration: ComponentDeclaration = {
        name: HiveAgentComponent.Name,
        version: HiveAgentComponent.Version,
        options: [
            {
                name: 'core',
                description: 'The rollout agent of one hive.',
                settings: [
                    { name: 'registryUrl', type: SettingType.Url, source: 'PRAGMATIC_AGENT_REGISTRY_URL', required: true, description: 'Base URL of the platform agent channel.' },
                    { name: 'hiveId', type: SettingType.String, source: 'PRAGMATIC_AGENT_HIVE_ID', required: true, description: 'The hive this agent serves.' },
                    { name: 'token', type: SettingType.String, source: 'PRAGMATIC_AGENT_TOKEN', required: true, secret: true, description: 'The bearer token of this hive on the agent channel.' },
                    { name: 'pollIntervalMs', type: SettingType.Integer, source: 'PRAGMATIC_AGENT_POLL_INTERVAL_MS', default: 30000, description: 'Interval between two rollout ticks, in milliseconds.' },
                    { name: 'maxBackoffMs', type: SettingType.Integer, source: 'PRAGMATIC_AGENT_MAX_BACKOFF_MS', default: 300000, description: 'Longest wait after failed ticks, in milliseconds.' },
                ],
            },
        ],
        roles: [],
        postgres: false,
        ports: [],
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(HiveAgentComponent.Declaration)
    }
}
