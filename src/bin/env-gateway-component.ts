import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'
import { ServerOptionDeclarations } from '@pragmatic-tech-ai/pragmatic-env-cluster'

/**
 * The component descriptor of the env gateway image (pragmatic-gatewayd): what `ServerConfigLoader.LoadGateway` reads. A
 * router in front of the workers: TLS and Redis are required, no database of its own.
 */
export class EnvGatewayComponent
{
    public static readonly Name = 'pragmatic-env-gateway'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.0'

    private static readonly Declaration: ComponentDeclaration = {
        name: EnvGatewayComponent.Name,
        version: EnvGatewayComponent.Version,
        options: [
            {
                name: 'core',
                description: 'The gateway process: listener, worker directory and drain (the gateway also requires the tls option).',
                settings: [
                    { name: 'host', type: SettingType.String, source: 'PRAGMATIC_HOST', default: '0.0.0.0', description: 'Address the listener binds.' },
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_PORT', default: 8080, description: 'Port the listener binds.' },
                    { name: 'redisUrl', type: SettingType.Url, source: 'PRAGMATIC_REDIS_URL', required: true, description: 'The Redis URL of the worker directory.' },
                    { name: 'workerServerName', type: SettingType.String, source: 'PRAGMATIC_WORKER_SERVERNAME', description: 'TLS server name of the workers.' },
                    { name: 'drainTimeoutMs', type: SettingType.Integer, source: 'PRAGMATIC_DRAIN_TIMEOUT_MS', default: 25000, description: 'How long shutdown waits for connections to drain, in milliseconds.' },
                    { name: 'healthPort', type: SettingType.Integer, source: 'PRAGMATIC_HEALTH_PORT', description: 'Separate port for /healthz and /readyz (served on the main listener when unset).' },
                ],
            },
            ServerOptionDeclarations.Tls,
            ServerOptionDeclarations.ClientTls,
            ServerOptionDeclarations.Observability,
            {
                name: 'audit',
                description: 'Where access audit records go.',
                settings: [
                    { name: 'sink', type: SettingType.String, source: 'PRAGMATIC_AUDIT_SINK', description: 'none or file (the gateway has no SQL audit store).' },
                    { name: 'file', type: SettingType.String, source: 'PRAGMATIC_AUDIT_FILE', description: 'The audit file (required for sink file).' },
                ],
            },
            ServerOptionDeclarations.RateLimit,
            ServerOptionDeclarations.WebSocket,
        ],
        roles: [],
        postgres: false,
        ports: [{ name: 'http', number: 8080 }],
        health: { port: 'http', path: '/healthz' },
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(EnvGatewayComponent.Declaration)
    }
}
