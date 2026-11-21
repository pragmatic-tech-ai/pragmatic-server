import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'

/**
 * The component descriptor of the platform edge image (ControlPlaneServer in the edge role): what `EdgeComposition.Compose`
 * reads. The keyless public process: agent channel and desktop discovery, answered by admin over its internal API.
 */
export class PlatformEdgeComponent
{
    public static readonly Name = 'pragmatic-platform-edge'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.0'

    private static readonly Declaration: ComponentDeclaration = {
        name: PlatformEdgeComponent.Name,
        version: PlatformEdgeComponent.Version,
        options: [
            {
                name: 'core',
                description: 'The public agent channel and the internal API of admin it relays to.',
                settings: [
                    { name: 'agentChannelPort', type: SettingType.Integer, source: 'PRAGMATIC_AGENT_CHANNEL_PORT', default: 7100, description: 'Port of the public agent channel (the image sets 7100).' },
                    { name: 'agentChannelBind', type: SettingType.String, source: 'PRAGMATIC_AGENT_CHANNEL_BIND', default: '0.0.0.0', description: 'Address of the public agent channel (an IP address).' },
                    { name: 'adminUrl', type: SettingType.Url, source: 'PRAGMATIC_EDGE_ADMIN_URL', required: true, description: 'The http(s) URL of the internal API of admin.' },
                    { name: 'internalApiSecret', type: SettingType.String, source: 'PRAGMATIC_INTERNAL_API_SECRET_FILE', required: true, secret: true, description: 'The shared secret for the internal API of admin (a mounted secret file).' },
                    { name: 'trustedProxy', type: SettingType.Boolean, source: 'PRAGMATIC_EDGE_TRUSTED_PROXY', default: false, description: 'Whether the edge sits behind a trusted proxy (x-forwarded-for is then the client).' },
                ],
            },
        ],
        roles: [],
        postgres: false,
        ports: [{ name: 'agent-channel', number: 7100 }],
        health: { port: 'agent-channel', path: '/healthz' },
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(PlatformEdgeComponent.Declaration)
    }
}
