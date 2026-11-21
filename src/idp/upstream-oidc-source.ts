import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret, Realm, RealmKind, type ISecretStore, type Principal, RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import { ClaimArrayGroupStrategy, ClaimsMapper, GenericOidcProfile, JwksCache, OidcAuthenticator, OidcDiscovery, OidcHttpClients, OidcResolvedConfig, OidcSettingKeys, type IHttpClient, type IOidcFlowStateStore, type OidcProviderProfile } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc';
import { GoogleIdentityProfile } from '@pragmatic-tech-ai/pragmatic-identity-source-google';
import { MicrosoftEntraProfile } from '@pragmatic-tech-ai/pragmatic-identity-source-entra';
import { PragmaticIdentityProfile } from '@pragmatic-tech-ai/pragmatic-identity-source-pragmatic';
import type { UpstreamSourceSettings } from './realm-settings.js';
import { RealmSourceKind, TenantIdpOptions } from './tenant-idp-options.js';

/** The one secret an upstream exchange needs (the client secret), as the authenticator reads it. */
class UpstreamClientSecret implements ISecretStore
{
    public static readonly Reference = 'upstream-client-secret';
    private static readonly ReadOnlyMessage = 'the upstream client secret is read-only';

    public constructor(private readonly secret: string)
    {
    }

    public async Get(reference: string): Promise<string | null>
    {
        return reference === UpstreamClientSecret.Reference ? this.secret : null;
    }

    public async Put(): Promise<void>
    {
        throw new Error(UpstreamClientSecret.ReadOnlyMessage);
    }

    public async Delete(): Promise<void>
    {
        throw new Error(UpstreamClientSecret.ReadOnlyMessage);
    }
}

/** An upstream sign-in that completed: the upstream principal and the realm's authorize request it was begun for. */
export class UpstreamSignIn
{
    public constructor(public readonly Principal: Principal, public readonly AuthorizeRequest: string)
    {
        Object.freeze(this);
    }

    public get Email(): string
    {
        return this.Principal.Claims.get(UpstreamSignIn.EmailClaim) ?? UpstreamSignIn.NoValue;
    }

    public get Name(): string
    {
        return this.Principal.Claims.get(UpstreamSignIn.NameClaim) ?? UpstreamSignIn.NoValue;
    }

    public static readonly EmailClaim = 'email';
    public static readonly NameClaim = 'name';
    private static readonly NoValue = '';
}

/**
 * One upstream OpenID Connect source of a realm (Google, Microsoft Entra, any OIDC provider, Sign in with Pragmatic):
 * the realm sign-in service as the upstream's relying party. `Begin` sends the person to the upstream with PKCE, state
 * and nonce, the realm's own authorize request carried in the flow state (the service's Postgres, so the callback may
 * land on another replica); `Complete` exchanges the code, verifies the ID token and hands back the upstream principal
 * (subject, email, name, groups by the source's group strategy) with that request. The callback is
 * `<issuer>/broker/<source>/callback`. A Google source with a hosted domain admits only that Workspace domain.
 *
 * Built on `OidcAuthenticator` with the source packs' profiles rather than the packs themselves: the packs'
 * `BeginAuthorization` takes no begin options (gap G3 in the plan's Ledger).
 */
export class UpstreamOidcSource
{
    private static readonly PackId = 'tenant-idp-upstream';
    private static readonly ClientSecretParam = 'client_secret';
    private static readonly DefaultLabels: ReadonlyMap<RealmSourceKind, string> = new Map([
        [RealmSourceKind.Google, 'Google'],
        [RealmSourceKind.Entra, 'Microsoft'],
        [RealmSourceKind.Oidc, 'Single sign-on'],
        [RealmSourceKind.Pragmatic, 'Pragmatic'],
    ]);
    private static readonly WellKnownSuffix = '/.well-known/openid-configuration';
    private static readonly NoLabel = '';

    private readonly authenticator: OidcAuthenticator;
    private readonly realm: Realm;

    private constructor(
        public readonly Settings: UpstreamSourceSettings,
        profile: OidcProviderProfile,
        providerSettings: ReadonlyMap<string, string>,
        realmId: string,
        issuer: string,
        flowStates: IOidcFlowStateStore,
        http: IHttpClient,
        now: (() => Date) | undefined)
    {
        const U = UpstreamOidcSource;
        this.realm = new Realm(realmId, RealmKind.SelfHosted, realmId);
        const scopes = profile.DefaultScopes;
        const resolved = new OidcResolvedConfig(
            profile.ResolveDiscoveryUrl(providerSettings),
            profile.ResolveIssuer(providerSettings),
            Settings.ClientId,
            RealmIssuer.BrokerCallbackOf(issuer, Settings.Id),
            scopes,
            UpstreamClientSecret.Reference,
            profile.ClientSecretParam);
        this.authenticator = new OidcAuthenticator({
            Http: http,
            Discovery: new OidcDiscovery(http, now),
            Jwks: new JwksCache(http),
            FlowStates: flowStates,
            Secrets: new UpstreamClientSecret(Settings.ClientSecret),
            Claims: new ClaimsMapper(profile),
            Config: new IdentityConfig(U.PackId, DelegationDepth.AuthnDirectory, providerSettings, new Map(), new Map()),
            Resolved: resolved,
            now,
        });
    }

    /** The source a realm's settings describe; `http` overrides the client (tests), else one trusting its CA bundle. */
    public static For(settings: UpstreamSourceSettings, realmId: string, issuer: string, flowStates: IOidcFlowStateStore, http?: IHttpClient, now?: () => Date): UpstreamOidcSource
    {
        const client = http ?? OidcHttpClients.Create(settings.CaBundleFile);
        return new UpstreamOidcSource(settings, UpstreamOidcSource.ProfileOf(settings), UpstreamOidcSource.ProviderSettingsOf(settings), realmId, issuer, flowStates, client, now);
    }

    public get Id(): string
    {
        return this.Settings.Id;
    }

    /** The sign-in button's text. */
    public get Label(): string
    {
        return this.Settings.Label ?? UpstreamOidcSource.DefaultLabels.get(this.Settings.Kind) ?? UpstreamOidcSource.NoLabel;
    }

    /** The upstream authorize URL; the realm's authorize request (its query) travels in the flow state. */
    public async Begin(authorizeRequest: string): Promise<string>
    {
        return (await this.authenticator.BeginAuthorization(this.realm, { ReturnPath: authorizeRequest })).Url;
    }

    /** The upstream principal of a callback; undefined for any refusal (bad state, code, token, or another domain). */
    public async Complete(code: string, state: string): Promise<UpstreamSignIn | undefined>
    {
        const presented = new PresentedSecret(code);
        try
        {
            const outcome = await this.authenticator.AuthenticateWithTokens(new Credential(AuthMethod.Oidc, state), presented, this.realm);
            if (!(outcome.Result instanceof AuthenticatedResult) || outcome.ReturnPath === null || !this.Admits(outcome.Result.Principal))
            {
                return undefined;
            }
            return new UpstreamSignIn(outcome.Result.Principal, outcome.ReturnPath);
        }
        finally
        {
            presented.Clear();
        }
    }

    /** A Google source with a hosted domain admits only accounts of it (the profile turns `hd` into the one group). */
    private Admits(principal: Principal): boolean
    {
        const domain = this.Settings.HostedDomain;
        return domain === undefined || principal.Groups.includes(domain);
    }

    private static ProfileOf(settings: UpstreamSourceSettings): OidcProviderProfile
    {
        const U = UpstreamOidcSource;
        switch (settings.Kind)
        {
            case RealmSourceKind.Google:
                return new GoogleIdentityProfile();
            case RealmSourceKind.Entra:
                return new MicrosoftEntraProfile();
            case RealmSourceKind.Pragmatic:
                return new PragmaticIdentityProfile();
            default:
            {
                const issuer = RealmIssuer.Trim(settings.Issuer ?? U.NoLabel);
                return new GenericOidcProfile(
                    issuer,
                    settings.DiscoveryUrl ?? issuer + U.WellKnownSuffix,
                    settings.Scopes ?? TenantIdpOptions.DefaultOidcScopes,
                    new Map([[UpstreamSignIn.EmailClaim, UpstreamSignIn.EmailClaim], [UpstreamSignIn.NameClaim, UpstreamSignIn.NameClaim]]),
                    new ClaimArrayGroupStrategy(settings.GroupsClaim ?? TenantIdpOptions.DefaultGroupsClaim),
                    U.ClientSecretParam);
            }
        }
    }

    /** The provider settings the profiles resolve issuers from (Entra's tenant, Pragmatic's issuer override). */
    private static ProviderSettingsOf(settings: UpstreamSourceSettings): ReadonlyMap<string, string>
    {
        const map = new Map<string, string>();
        if (settings.EntraTenantId !== undefined)
        {
            map.set(OidcSettingKeys.AadTenantId, settings.EntraTenantId);
        }
        if (settings.Issuer !== undefined)
        {
            map.set(OidcSettingKeys.Issuer, settings.Issuer);
        }
        return map;
    }
}
