import { SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDeclarations, type ComponentDeclaration } from '../../src/component/component-declaration.js'

/**
 * The component descriptor of the tenant admin image (pragmatic-tenant-admind, the console that ships into a client hive):
 * the `TenantAdminEnv` contract as `TenantAdminServer`, `InjectedIdpService` and `IngressTlsPolicy` read it. Stores in
 * Postgres (A5). Its port is configuration with no default; 7100 is the port the console installer gives it in a hive.
 */
export class TenantAdminComponent
{
    public static readonly Name = 'pragmatic-tenant-admin'

    private static readonly Declaration: ComponentDeclaration = {
        name: TenantAdminComponent.Name,
        options: [
            {
                name: 'core',
                description: 'The tenant console: listener, state folder and tenant origins.',
                settings: [
                    { name: 'dataRoot', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_DATA_ROOT', required: true, description: 'The state folder (its master.key decrypts the data).' },
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_PORT', required: true, description: 'Port of the tenant listener.' },
                    { name: 'baseDomain', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN', required: true, description: 'Tenants are served at <tenant>.<baseDomain>.' },
                    { name: 'bind', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_BIND', default: '127.0.0.1', description: 'Address of the tenant listener.' },
                    { name: 'externalScheme', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME', default: 'https', description: 'Scheme browsers use for tenant origins.' },
                    { name: 'externalPort', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT', description: 'Port browsers use for tenant origins, when not the scheme default.' },
                    { name: 'secureCookie', type: SettingType.Boolean, source: 'PRAGMATIC_TENANT_ADMIN_SECURE_COOKIE', default: false, description: 'Whether session cookies are Secure.' },
                    { name: 'trustedProxy', type: SettingType.Boolean, source: 'PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY', default: false, description: 'Whether the tenant listener sits behind a trusted proxy.' },
                    { name: 'secretTtlHours', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS', default: 168, description: 'Lifetime of issued tenant secrets, in hours.' },
                    { name: 'healthProbeMs', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS', default: 30000, description: 'Interval of environment health probes, in milliseconds.' },
                    { name: 'healthProbeTimeoutMs', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_TIMEOUT_MS', default: 60000, description: 'Timeout of one environment health probe, in milliseconds.' },
                    { name: 'consoleHost', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST', description: 'Browser host the console is served on through its Ingress.' },
                    { name: 'fingerprintKey', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE', secret: true, description: 'The account-email fingerprint key (a mounted secret file).' },
                ],
            },
            {
                name: 'rollout',
                description: 'The HTTP rollout client to the platform agent channel (in-process rollout when off).',
                settings: [
                    { name: 'url', type: SettingType.Url, source: 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL', required: true, description: 'Base URL of the platform agent channel.' },
                    { name: 'token', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN', required: true, secret: true, description: 'The bearer token of the hive on the agent channel.' },
                    { name: 'hiveId', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID', required: true, description: 'The hive the rollout client is bound to.' },
                ],
            },
            {
                name: 'idp',
                description: 'The injected tenant IdP the console connects to (a local IdP is used when off).',
                settings: [
                    { name: 'browserBaseUrl', type: SettingType.Url, source: 'PRAGMATIC_IDP_BROWSER_BASE_URL', required: true, description: 'The browser-facing IdP origin (the issuer).' },
                    { name: 'baseUrl', type: SettingType.Url, source: 'PRAGMATIC_IDP_BASE_URL', description: 'The in-cluster IdP origin for token, jwks and admin calls (defaults to browserBaseUrl).' },
                    { name: 'caFile', type: SettingType.String, source: 'PRAGMATIC_IDP_CA_FILE', required: true, description: 'Path of the IdP CA certificate.' },
                    { name: 'adminToken', type: SettingType.String, source: 'PRAGMATIC_IDP_ADMIN_TOKEN_FILE', required: true, secret: true, description: 'The IdP admin token (a mounted secret file, never an inline value).' },
                ],
            },
            {
                name: 'ingressTls',
                description: 'TLS of the environment and IdP Ingresses this console renders.',
                settings: [
                    { name: 'source', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SOURCE', required: true, description: 'existing-secret, cert-manager or development.' },
                    { name: 'secretName', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SECRET', description: 'The TLS Secret (for existing-secret).' },
                    { name: 'clusterIssuer', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_ISSUER', description: 'The cert-manager ClusterIssuer (for cert-manager).' },
                ],
            },
        ],
        roles: [],
        postgres: true,
        ports: [{ name: 'http', number: 7100 }],
        health: { port: 'http', path: '/healthz' },
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(TenantAdminComponent.Declaration)
    }
}
