import { IdentityConfig, DelegationDepth } from '@pragmatic-tech-ai/todl-identity'
import type { ISecretStore } from '@pragmatic-tech-ai/todl-identity'
import { OidcAuthenticator, OidcResolvedConfig, OidcDiscovery, JwksCache, FetchHttpClient, InMemoryOidcFlowStateStore, ClaimsMapper, ClaimArrayGroupStrategy } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { IHttpClient, IOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { OidcServerOptions } from '../pragmatic-server.js'

/** Builds an OidcAuthenticator from server OIDC options. HTTP client and flow-state store are
 *  injectable so tests can substitute the cloud package's offline doubles. */
export class OidcAuthenticatorBuilder
{
    private static readonly EmailClaim = 'email'
    private static readonly GroupsClaim = 'groups'
    private static readonly ClientSecretParam = 'client_secret'
    private static readonly Scopes: readonly string[] = ['openid', 'email', 'profile']

    public static Build(
        options: OidcServerOptions,
        secrets: ISecretStore,
        http: IHttpClient = new FetchHttpClient(),
        flowStates: IOidcFlowStateStore = new InMemoryOidcFlowStateStore()): OidcAuthenticator
    {
        const resolved = new OidcResolvedConfig(options.discoveryUrl, options.issuer, options.clientId, options.redirectUri, [...OidcAuthenticatorBuilder.Scopes], options.clientSecretRef, OidcAuthenticatorBuilder.ClientSecretParam)
        return new OidcAuthenticator({
            Http: http,
            Discovery: new OidcDiscovery(http),
            Jwks: new JwksCache(http),
            FlowStates: flowStates,
            Secrets: secrets,
            Claims: new ClaimsMapper(new Map([[OidcAuthenticatorBuilder.EmailClaim, OidcAuthenticatorBuilder.EmailClaim]]), new ClaimArrayGroupStrategy(OidcAuthenticatorBuilder.GroupsClaim)),
            Config: new IdentityConfig(options.provider, DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map()),
            Resolved: resolved,
        })
    }
}
