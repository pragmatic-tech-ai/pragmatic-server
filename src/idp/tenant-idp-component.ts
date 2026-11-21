import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration, type OptionDeclaration } from '@pragmatic-tech-ai/pragmatic-component';
import { RealmSourceKind, TenantIdpOptions as O } from './tenant-idp-options.js';

/**
 * The component descriptor of the realm sign-in service image (`pragmatic-tenant-idp`). `core` is what `IdpMain` reads
 * from its environment (the container); the other options are a realm's configuration document (one per realm, read
 * at start from its applied configuration file): token lifetimes and the realm's identity sources, every secret a
 * `SecretReference`. It stores in its own Postgres (A5).
 */
export class TenantIdpComponent
{
    public static readonly Name = 'pragmatic-tenant-idp';
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.0';

    private static readonly Core: OptionDeclaration = {
        name: O.Core,
        description: 'The container: where it listens, its secret files and its database.',
        settings: [
            { name: 'baseUrl', type: SettingType.Url, source: 'PRAGMATIC_IDP_BASE_URL', required: true, description: 'The browser-facing https origin; a realm\'s issuer is <baseUrl>/realms/<realm>.' },
            { name: 'internalUrl', type: SettingType.Url, source: 'PRAGMATIC_IDP_INTERNAL_URL', description: 'The in-cluster https origin of the token, key and revocation endpoints, when it differs from baseUrl.' },
            { name: 'host', type: SettingType.String, source: 'PRAGMATIC_IDP_HOST', default: '127.0.0.1', description: 'Address the listener binds.' },
            { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_IDP_PORT', default: 7100, description: 'Port the listener binds.' },
            { name: 'tls', type: SettingType.Boolean, source: 'PRAGMATIC_IDP_TLS', default: true, description: 'Whether the service terminates TLS itself (false behind a TLS-terminating proxy).' },
            { name: 'trustedProxy', type: SettingType.Boolean, source: 'PRAGMATIC_IDP_TRUSTED_PROXY', default: false, description: 'Whether to honour the last x-forwarded-for / x-forwarded-proto hop (behind a reverse proxy).' },
            { name: 'dataDir', type: SettingType.String, source: 'PRAGMATIC_IDP_DATA', description: 'The secret files folder (signing key, master key, TLS, admin tokens; pre-A5 data to import); defaults to data beside the code.' },
            { name: 'databaseUrl', type: SettingType.String, source: 'PRAGMATIC_IDP_DATABASE_URL_FILE', required: true, secret: true, description: 'The URL of the service\'s own Postgres database, where every record lives (a mounted secret file).' },
            { name: 'secureCookie', type: SettingType.Boolean, source: 'PRAGMATIC_IDP_SECURE_COOKIE', default: true, description: 'Whether session cookies are Secure (false or 0 turns it off).' },
            { name: 'adminToken', type: SettingType.String, source: 'PRAGMATIC_IDP_ADMIN_TOKEN_REF', secret: true, description: 'The admin API tokens (PRAGMATIC_IDP_ADMIN_TOKEN_REF names their file under the data folder secrets).' },
            { name: 'loginDir', type: SettingType.String, source: 'PRAGMATIC_IDP_LOGIN_DIR', description: 'Folder of the built sign-in app (defaults to idp-login/dist beside the code).' },
            { name: 'configurationDir', type: SettingType.String, source: 'PRAGMATIC_IDP_CONFIGURATION_DIR', default: '/etc/pragmatic/configuration', description: 'Folder of the realms\' applied configuration files (one per realm).' },
            { name: 'bootstrapRealm', type: SettingType.String, source: 'PRAGMATIC_IDP_BOOTSTRAP_REALM_FILE', description: 'A realm configuration mounted by the deploy ({ realm, displayName, configuration }), validated at start.' },
            { name: 'secretsDir', type: SettingType.String, source: 'PRAGMATIC_IDP_SECRETS_DIR', description: 'Folder of secret files a realm\'s configuration names as secret:file/<name>.' },
            { name: 'applicationsDir', type: SettingType.String, source: 'PRAGMATIC_IDP_APPLICATIONS_DIR', description: 'Folder of component descriptors whose application roles every realm offers for mapping.' },
        ],
    };

    private static readonly Tokens: OptionDeclaration = {
        name: O.Tokens,
        description: 'Token and session lifetimes of the realm.',
        settings: [
            { name: O.IdTokenLifetime, type: SettingType.Duration, default: O.DefaultIdTokenLifetime, description: 'How long an ID token (and its access token) is valid.' },
            { name: O.RefreshTokenIdleLifetime, type: SettingType.Duration, default: O.DefaultRefreshTokenIdleLifetime, description: 'How long a refresh token is valid unused (each refresh rotates it).' },
            { name: O.RefreshTokenMaxLifetime, type: SettingType.Duration, default: O.DefaultRefreshTokenMaxLifetime, description: 'How long refreshing can go on after the sign-in.' },
            { name: O.SsoSessionLifetime, type: SettingType.Duration, default: O.DefaultSsoSessionLifetime, description: 'How long the login domain\'s single sign-on session re-authenticates silently.' },
        ],
    };

    private static readonly Local: OptionDeclaration = {
        name: RealmSourceKind.Local,
        description: 'Local accounts of the realm (email and password, provisioned by the tenant admin).',
        settings: [
            { name: O.MaxAttempts, type: SettingType.Integer, default: O.DefaultMaxAttempts, description: 'Failed sign-ins of one account from one address before it locks.' },
            { name: O.Lockout, type: SettingType.Duration, default: O.DefaultLockout, description: 'How long a locked sign-in stays locked.' },
        ],
    };

    private static readonly Google: OptionDeclaration = {
        name: RealmSourceKind.Google,
        description: 'Sign in with Google (an OAuth client of the tenant\'s Google Cloud project).',
        settings: [
            { name: O.ClientId, type: SettingType.String, required: true, description: 'The OAuth client id.' },
            { name: O.ClientSecret, type: SettingType.String, required: true, secret: true, description: 'The OAuth client secret.' },
            { name: O.HostedDomain, type: SettingType.String, description: 'Only accounts of this Google Workspace domain sign in (the hd claim).' },
        ],
    };

    private static readonly Entra: OptionDeclaration = {
        name: RealmSourceKind.Entra,
        description: 'Sign in with Microsoft Entra ID (an app registration of the tenant\'s directory).',
        settings: [
            { name: O.TenantId, type: SettingType.String, required: true, description: 'The directory (tenant) id.' },
            { name: O.ClientId, type: SettingType.String, required: true, description: 'The application (client) id.' },
            { name: O.ClientSecret, type: SettingType.String, required: true, secret: true, description: 'The client secret.' },
        ],
    };

    private static readonly Oidc: OptionDeclaration = {
        name: RealmSourceKind.Oidc,
        description: 'Sign in with any OpenID Connect provider.',
        settings: [
            { name: O.Issuer, type: SettingType.Url, required: true, description: 'The provider\'s issuer.' },
            { name: O.DiscoveryUrl, type: SettingType.Url, description: 'The discovery document (default <issuer>/.well-known/openid-configuration).' },
            { name: O.ClientId, type: SettingType.String, required: true, description: 'The client id.' },
            { name: O.ClientSecret, type: SettingType.String, required: true, secret: true, description: 'The client secret.' },
            { name: O.Scopes, type: SettingType.List, default: [...O.DefaultOidcScopes], description: 'The scopes asked for.' },
            { name: O.GroupsClaim, type: SettingType.String, default: O.DefaultGroupsClaim, description: 'The ID token claim listing the person\'s groups.' },
            { name: O.Label, type: SettingType.String, description: 'The sign-in button\'s text.' },
            { name: O.CaBundleFile, type: SettingType.String, description: 'A PEM CA bundle file trusted besides the public roots (a provider on a private CA).' },
        ],
    };

    private static readonly Pragmatic: OptionDeclaration = {
        name: RealmSourceKind.Pragmatic,
        description: 'Sign in with Pragmatic (the central login as an OpenID Connect upstream).',
        settings: [
            { name: O.ClientId, type: SettingType.String, required: true, description: 'The client id registered at the central login.' },
            { name: O.ClientSecret, type: SettingType.String, required: true, secret: true, description: 'The client secret.' },
            { name: O.Issuer, type: SettingType.Url, description: 'The central realm\'s issuer (default https://login.pragmatic-tech.ai/realms/central).' },
            { name: O.CaBundleFile, type: SettingType.String, description: 'A PEM CA bundle file trusted besides the public roots (a development central login).' },
        ],
    };

    private static readonly IdentityPlatform: OptionDeclaration = {
        name: RealmSourceKind.IdentityPlatform,
        description: 'Google Identity Platform accounts (the central realm): email and password with sign-up and a verified email, Google accounts.',
        settings: [
            { name: O.ProjectId, type: SettingType.String, required: true, description: 'The Google Cloud project.' },
            { name: O.ApiKey, type: SettingType.String, required: true, secret: true, description: 'The browser API key the login page uses (public by design, restricted by referrer and API).' },
            { name: O.Providers, type: SettingType.List, default: [...O.DefaultProviders], description: 'The Identity Platform providers accepted: password, google.com.' },
            { name: O.TenantId, type: SettingType.String, description: 'The Identity Platform tenant, when the project uses multi-tenancy.' },
            { name: O.MaxAuthAge, type: SettingType.Duration, default: O.DefaultMaxAuthAge, description: 'How old an Identity Platform sign-in may be when the page posts its token.' },
            { name: O.AuthDomain, type: SettingType.String, description: 'The Identity Platform auth domain (default <projectId>.firebaseapp.com).' },
        ],
    };

    private static readonly Declaration: ComponentDeclaration = {
        name: TenantIdpComponent.Name,
        version: TenantIdpComponent.Version,
        options: [
            TenantIdpComponent.Core,
            TenantIdpComponent.Tokens,
            TenantIdpComponent.Local,
            TenantIdpComponent.Google,
            TenantIdpComponent.Entra,
            TenantIdpComponent.Oidc,
            TenantIdpComponent.Pragmatic,
            TenantIdpComponent.IdentityPlatform,
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
