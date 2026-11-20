/**
 * The one home of the realm sign-in service's URL forms: a realm's issuer is `<base>/realms/<realm>`, its OIDC protocol
 * endpoints sit under `<issuer>/protocol/openid-connect/`, its discovery document at
 * `<issuer>/.well-known/openid-configuration`, the login page's API at `<issuer>/login` and the upstream sources at
 * `<issuer>/broker/<source>/`. Relying parties (the control plane, the tenant console) build their issuer here too.
 */
export class RealmIssuer
{
    public static readonly RealmsSegment = 'realms';
    public static readonly DiscoveryPath = '/.well-known/openid-configuration';
    public static readonly AuthorizePath = '/protocol/openid-connect/auth';
    public static readonly TokenPath = '/protocol/openid-connect/token';
    public static readonly CertsPath = '/protocol/openid-connect/certs';
    public static readonly RevocationPath = '/protocol/openid-connect/revoke';
    public static readonly LogoutPath = '/protocol/openid-connect/logout';
    public static readonly LoginPath = '/login';
    public static readonly LoginConfigPath = '/login/config';
    public static readonly LoginContinuePath = '/login/continue';
    public static readonly BrokerSegment = '/broker/';
    public static readonly BrokerLoginSuffix = '/login';
    public static readonly BrokerCallbackSuffix = '/callback';
    /** The route-pattern prefix of every realm path (`:realm` is the realm id). */
    public static readonly RealmPattern = '/realms/:realm';
    public static readonly RealmParam = 'realm';

    private static readonly Separator = '/';
    private static readonly TrailingSlashes = /\/+$/;

    /** `<base>/realms/<realm>` (the base without trailing slashes). */
    public static Of(baseUrl: string, realm: string): string
    {
        return RealmIssuer.Trim(baseUrl) + RealmIssuer.Separator + RealmIssuer.RealmsSegment + RealmIssuer.Separator + encodeURIComponent(realm);
    }

    /** The realm's discovery document URL on `baseUrl` (which may be an internal origin). */
    public static DiscoveryOf(baseUrl: string, realm: string): string
    {
        return RealmIssuer.Of(baseUrl, realm) + RealmIssuer.DiscoveryPath;
    }

    /** The upstream source's callback (registered at the upstream as the redirect URI). */
    public static BrokerCallbackOf(issuer: string, source: string): string
    {
        return issuer + RealmIssuer.BrokerSegment + encodeURIComponent(source) + RealmIssuer.BrokerCallbackSuffix;
    }

    /** A route pattern under the realm: `/realms/:realm<path>`. */
    public static Pattern(path: string): string
    {
        return RealmIssuer.RealmPattern + path;
    }

    public static Trim(baseUrl: string): string
    {
        return baseUrl.replace(RealmIssuer.TrailingSlashes, '');
    }
}
