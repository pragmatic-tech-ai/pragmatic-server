import { SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import { ComponentDeclarations, type ComponentDeclaration } from '../component/component-declaration.js';

/**
 * The component descriptor of the tenant IdP image (pragmatic-idpd): what `IdpMain` reads. It serves HTTPS only and will
 * store in Postgres (A5).
 */
export class TenantIdpComponent
{
    public static readonly Name = 'pragmatic-tenant-idp';

    private static readonly Declaration: ComponentDeclaration = {
        name: TenantIdpComponent.Name,
        options: [
            {
                name: 'core',
                description: 'The realm sign-in service of a tenant.',
                settings: [
                    { name: 'baseUrl', type: SettingType.Url, source: 'PRAGMATIC_IDP_BASE_URL', required: true, description: 'The browser-facing https origin (the issuer).' },
                    { name: 'internalUrl', type: SettingType.Url, source: 'PRAGMATIC_IDP_INTERNAL_URL', description: 'The in-cluster https origin, when it differs from baseUrl.' },
                    { name: 'host', type: SettingType.String, source: 'PRAGMATIC_IDP_HOST', default: '127.0.0.1', description: 'Address the listener binds.' },
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_IDP_PORT', default: 7100, description: 'Port the HTTPS listener binds.' },
                    { name: 'dataDir', type: SettingType.String, source: 'PRAGMATIC_IDP_DATA', description: 'The state folder (signing key, master key, realms, clients, TLS); defaults to data beside the code.' },
                    { name: 'secureCookie', type: SettingType.Boolean, source: 'PRAGMATIC_IDP_SECURE_COOKIE', default: true, description: 'Whether session cookies are Secure (false or 0 turns it off).' },
                    { name: 'tenants', type: SettingType.List, source: 'PRAGMATIC_IDP_TENANTS', description: 'Tenants whose realms are opened at start (comma-separated ids).' },
                    { name: 'adminToken', type: SettingType.String, source: 'PRAGMATIC_IDP_ADMIN_TOKEN_REF', secret: true, description: 'The admin API token (PRAGMATIC_IDP_ADMIN_TOKEN_REF names its file under the data folder secrets).' },
                    { name: 'loginDir', type: SettingType.String, source: 'PRAGMATIC_IDP_LOGIN_DIR', description: 'Folder of the built sign-in app (defaults to idp-login/dist beside the code).' },
                ],
            },
        ],
        roles: [],
        postgres: true,
        ports: [{ name: 'https', number: 7100 }],
        health: { port: 'https', path: '/healthz' },
    };

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(TenantIdpComponent.Declaration);
    }
}
