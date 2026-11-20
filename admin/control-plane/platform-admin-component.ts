import { SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDeclarations, type ComponentDeclaration } from '../../src/component/component-declaration.js'

/**
 * The component descriptor of the platform admin image (ControlPlaneServer in the admin role): what `ControlPlaneServer.Main`
 * and the readers it composes (operator options, key stores, infrastructure target, internal API, release catalogue, the
 * co-hosted tenant plane) read. Declares the platform admin console's operator roles (`OperatorRole`). Stores in Postgres (A5).
 */
export class PlatformAdminComponent
{
    public static readonly Name = 'pragmatic-platform-admin'

    private static readonly Declaration: ComponentDeclaration = {
        name: PlatformAdminComponent.Name,
        options: [
            {
                name: 'core',
                description: 'The operator listener, state folder, operator bootstrap, keys and infrastructure target.',
                settings: [
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_ADMIN_PORT', default: 7000, description: 'Port of the operator listener.' },
                    { name: 'bind', type: SettingType.String, source: 'PRAGMATIC_ADMIN_BIND', default: '127.0.0.1', description: 'Address of the operator listener (an IP address or localhost).' },
                    { name: 'dataRoot', type: SettingType.String, source: 'PRAGMATIC_ADMIN_DATA_ROOT', description: 'The state folder (defaults to data beside the control plane).' },
                    { name: 'allowedHosts', type: SettingType.List, source: 'PRAGMATIC_ADMIN_ALLOWED_HOSTS', description: 'Host names the operator listener answers (comma-separated).' },
                    { name: 'secureCookie', type: SettingType.Boolean, source: 'PRAGMATIC_ADMIN_SECURE_COOKIE', default: false, description: 'Whether operator session cookies are Secure.' },
                    { name: 'trustedProxy', type: SettingType.Boolean, source: 'PRAGMATIC_ADMIN_TRUSTED_PROXY', default: false, description: 'Whether the operator listener sits behind a trusted proxy (x-forwarded-for is then the client).' },
                    { name: 'operatorEmail', type: SettingType.String, source: 'PRAGMATIC_ADMIN_OPERATOR_EMAIL', default: 'admin@control-plane.test', description: 'Email of the first operator, created on a fresh start.' },
                    { name: 'operatorPassword', type: SettingType.String, source: 'PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE', secret: true, description: 'Password of the first operator (a mounted secret file; PRAGMATIC_ADMIN_OPERATOR_PASSWORD may hold it instead, never both).' },
                    { name: 'masterKey', type: SettingType.String, source: 'PRAGMATIC_ADMIN_MASTER_KEY_FILE', secret: true, description: 'The 32-byte master key of the operator identity store (a mounted secret file; defaults to master.key in the state folder).' },
                    { name: 'signingKeyRef', type: SettingType.String, source: 'PRAGMATIC_ADMIN_SIGNING_KEY_REF', description: 'The platform image signing key reference (the generated platform key when unset).' },
                    { name: 'signingKey', type: SettingType.String, source: 'PRAGMATIC_ADMIN_SIGNING_KEY_FILE', secret: true, description: 'The platform signing key (a mounted secret file; the key store in the state folder when unset).' },
                    { name: 'infraTarget', type: SettingType.String, source: 'PRAGMATIC_ADMIN_INFRA_TARGET', default: 'local', description: 'local (this host\'s Docker and kind), none, or hosted (registered clusters over the mesh).' },
                    { name: 'kubeconfig', type: SettingType.String, source: 'PRAGMATIC_ADMIN_KUBECONFIG_FILE', secret: true, description: 'The kubeconfig of the hosted clusters (a mounted secret file).' },
                    { name: 'agentChannelUrl', type: SettingType.Url, source: 'PRAGMATIC_AGENT_CHANNEL_URL', description: 'Public URL of the agent channel that hive install bundles point at.' },
                    { name: 'desktopTenantPlaneUrl', type: SettingType.Url, source: 'PRAGMATIC_DESKTOP_TENANT_PLANE_URL', description: 'Where the desktop app finds the tenant plane (derived from the tenant plane settings when unset).' },
                ],
            },
            {
                name: 'internalApi',
                description: 'The internal API the platform edge calls (off unless enabled).',
                settings: [
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_ADMIN_INTERNAL_PORT', required: true, description: 'Port of the internal API listener.' },
                    { name: 'bind', type: SettingType.String, source: 'PRAGMATIC_ADMIN_INTERNAL_BIND', default: '127.0.0.1', description: 'Address of the internal API listener (an IP address or localhost).' },
                    { name: 'secret', type: SettingType.String, source: 'PRAGMATIC_INTERNAL_API_SECRET_FILE', required: true, secret: true, description: 'The shared secret the edge authenticates with (a mounted secret file).' },
                ],
            },
            {
                name: 'releases',
                description: 'The release catalogue: signed release descriptors read from an OCI registry and imported on a poll.',
                settings: [
                    { name: 'registry', type: SettingType.Url, source: 'PRAGMATIC_RELEASE_REGISTRY', default: 'https://ghcr.io', description: 'The registry (https; http only for a loopback registry).' },
                    { name: 'namespace', type: SettingType.String, source: 'PRAGMATIC_RELEASE_NAMESPACE', default: 'pragmatic-tech-ai', description: 'The registry namespace of the release repositories.' },
                    { name: 'trustDir', type: SettingType.String, source: 'PRAGMATIC_RELEASE_TRUST_DIR', description: 'Folder of trusted release public keys (defaults to the shipped release-keys).' },
                    { name: 'pollSeconds', type: SettingType.Integer, source: 'PRAGMATIC_RELEASE_POLL_SECONDS', default: 300, description: 'Seconds between two catalogue refreshes (0 turns the poll off).' },
                    { name: 'credential', type: SettingType.String, source: 'PRAGMATIC_RELEASE_CREDENTIAL_FILE', secret: true, description: 'The registry read credential, JSON with username and token (a mounted secret file).' },
                ],
            },
            {
                name: 'tenantPlane',
                description: 'The tenant plane co-hosted with the operator listener (on when port and baseDomain are set).',
                settings: [
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_PORT', required: true, description: 'Port of the tenant listener.' },
                    { name: 'baseDomain', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN', required: true, description: 'Tenants are served at <tenant>.<baseDomain>.' },
                    { name: 'bind', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_BIND', default: '127.0.0.1', description: 'Address of the tenant listener.' },
                    { name: 'externalScheme', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME', default: 'https', description: 'Scheme browsers use for tenant origins.' },
                    { name: 'externalPort', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT', description: 'Port browsers use for tenant origins, when not the scheme default.' },
                    { name: 'trustedProxy', type: SettingType.Boolean, source: 'PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY', default: false, description: 'Whether the tenant listener sits behind a trusted proxy.' },
                    { name: 'secretTtlHours', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS', default: 168, description: 'Lifetime of issued tenant secrets, in hours.' },
                    { name: 'healthProbeMs', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS', default: 30000, description: 'Interval of environment health probes, in milliseconds.' },
                    { name: 'healthProbeTimeoutMs', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_TIMEOUT_MS', default: 60000, description: 'Timeout of one environment health probe, in milliseconds.' },
                ],
            },
        ],
        roles: [
            { name: 'operator.full', description: 'A platform operator who may change the platform (Owner grant on the control-plane realm).' },
            { name: 'operator.read-only', description: 'A platform operator who may only observe (Viewer grant, or no Owner grant).' },
        ],
        postgres: true,
        ports: [{ name: 'http', number: 7000 }, { name: 'internal', number: 7001 }],
        health: { port: 'http', path: '/healthz' },
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(PlatformAdminComponent.Declaration)
    }
}
