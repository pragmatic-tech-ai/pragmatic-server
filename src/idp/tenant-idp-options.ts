/** The kinds of identity source a realm can have; each is one option of the realm's configuration, and its option name
 *  is the source id role mappings name (`RoleMember.Source`). */
export enum RealmSourceKind
{
    Local = 'local',
    Google = 'google',
    Entra = 'entra',
    Oidc = 'oidc',
    Pragmatic = 'pragmatic',
    IdentityPlatform = 'identityPlatform',
}

/**
 * The names of the realm options of `pragmatic-tenant-idp` and their settings: the one home shared by the component
 * descriptor (TenantIdpComponent) and the code reading a realm's configuration (RealmSettings).
 */
export class TenantIdpOptions
{
    /** The container's own settings (environment variables), never part of a realm's document. */
    public static readonly Core = 'core';
    /** Token and session lifetimes of the realm. */
    public static readonly Tokens = 'tokens';

    public static readonly IdTokenLifetime = 'idTokenLifetime';
    public static readonly RefreshTokenIdleLifetime = 'refreshTokenIdleLifetime';
    public static readonly RefreshTokenMaxLifetime = 'refreshTokenMaxLifetime';
    public static readonly SsoSessionLifetime = 'ssoSessionLifetime';

    public static readonly MaxAttempts = 'maxAttempts';
    public static readonly Lockout = 'lockout';

    public static readonly ClientId = 'clientId';
    public static readonly ClientSecret = 'clientSecret';
    public static readonly HostedDomain = 'hostedDomain';
    public static readonly TenantId = 'tenantId';
    public static readonly Issuer = 'issuer';
    public static readonly DiscoveryUrl = 'discoveryUrl';
    public static readonly Scopes = 'scopes';
    public static readonly GroupsClaim = 'groupsClaim';
    public static readonly Label = 'label';
    public static readonly CaBundleFile = 'caBundleFile';

    public static readonly ProjectId = 'projectId';
    public static readonly ApiKey = 'apiKey';
    public static readonly Providers = 'providers';
    public static readonly MaxAuthAge = 'maxAuthAge';
    public static readonly AuthDomain = 'authDomain';

    public static readonly DefaultIdTokenLifetime = '5m';
    public static readonly DefaultRefreshTokenIdleLifetime = '7d';
    public static readonly DefaultRefreshTokenMaxLifetime = '30d';
    public static readonly DefaultSsoSessionLifetime = '12h';
    public static readonly DefaultMaxAttempts = 5;
    public static readonly DefaultLockout = '15m';
    public static readonly DefaultGroupsClaim = 'groups';
    public static readonly DefaultMaxAuthAge = '10m';
    public static readonly DefaultProviders: readonly string[] = ['password'];
    public static readonly DefaultOidcScopes: readonly string[] = ['openid', 'email', 'profile'];
}
