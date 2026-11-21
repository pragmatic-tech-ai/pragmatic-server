import { HttpMethod, RouteAuth, type RequestContext, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host';
import { AuthorizeRequest } from './authorize-request.js';
import type { IdpRealm } from './idp-realm.js';
import type { IdpRealmSet } from './idp-realm-set.js';
import type { IdpSigningKey } from './idp-signing-key.js';
import { IdpSsoCookie } from './idp-sso-cookie.js';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import type { SqlIdpClientStore } from './sql-idp-client-store.js';
import type { SqlRefreshTokenStore } from './sql-refresh-token-store.js';
import type { SqlSsoSessionStore } from './sql-sso-session-store.js';

/**
 * A realm's published protocol surface: the OIDC discovery document (issuer and authorize / end-session endpoints on
 * the browser origin; token, keys and revocation on the internal origin when one is set; `prompt_values_supported`
 * advertising `create` only where the realm offers sign-up), the key set, and RP-initiated logout (ends the SSO session
 * and every refresh token issued under it, clears the cookie, and returns to a registered post-logout URI).
 */
export class ProtocolEndpoints
{
    private static readonly IssuerField = 'issuer';
    private static readonly AuthorizationEndpointField = 'authorization_endpoint';
    private static readonly TokenEndpointField = 'token_endpoint';
    private static readonly JwksUriField = 'jwks_uri';
    private static readonly RevocationEndpointField = 'revocation_endpoint';
    private static readonly EndSessionEndpointField = 'end_session_endpoint';
    private static readonly ResponseTypesField = 'response_types_supported';
    private static readonly GrantTypesField = 'grant_types_supported';
    private static readonly SubjectTypesField = 'subject_types_supported';
    private static readonly SigningAlgsField = 'id_token_signing_alg_values_supported';
    private static readonly ChallengeMethodsField = 'code_challenge_methods_supported';
    private static readonly TokenAuthMethodsField = 'token_endpoint_auth_methods_supported';
    private static readonly ScopesField = 'scopes_supported';
    private static readonly ClaimsField = 'claims_supported';
    private static readonly PromptValuesField = 'prompt_values_supported';
    private static readonly ResponseTypes = ['code'];
    private static readonly GrantTypes = ['authorization_code', 'refresh_token'];
    private static readonly SubjectTypes = ['public'];
    private static readonly SigningAlgs = ['RS256'];
    private static readonly ChallengeMethods = ['S256'];
    private static readonly TokenAuthMethods = ['client_secret_post', 'client_secret_basic'];
    private static readonly Scopes = ['openid', 'email', 'profile'];
    private static readonly Claims = ['iss', 'sub', 'aud', 'azp', 'iat', 'exp', 'auth_time', 'nonce', 'email', 'email_verified', 'name', 'roles', 'app_roles'];
    private static readonly ClientIdParam = 'client_id';
    private static readonly PostLogoutParam = 'post_logout_redirect_uri';
    private static readonly StateParam = 'state';
    private static readonly IdTokenHintParam = 'id_token_hint';
    private static readonly SignedOutField = 'signedOut';
    private static readonly ErrorField = 'error';
    private static readonly DescriptionField = 'error_description';
    private static readonly InvalidRequest = 'invalid_request';
    private static readonly UnknownRealm = 'unknown_realm';
    private static readonly BadPostLogoutDescription = 'post_logout_redirect_uri is not registered for this client';
    private static readonly CacheControlHeader = 'Cache-Control';
    private static readonly NoStore = 'no-store';
    private static readonly LocationHeader = 'Location';
    private static readonly SetCookieHeader = 'Set-Cookie';
    private static readonly StatusOk = 200;
    private static readonly StatusFound = 302;
    private static readonly StatusBadRequest = 400;
    private static readonly StatusNotFound = 404;
    private static readonly ContentTypeHeader = 'Content-Type';
    private static readonly HtmlType = 'text/html; charset=utf-8';
    private static readonly QueryMark = '?';
    private static readonly NoText = '';
    private static readonly ConfirmPrefix = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign out</title></head><body><form method="post" action="';
    private static readonly ConfirmSuffix = '"><p>Sign out of this account?</p><button type="submit">Sign out</button></form></body></html>';

    public constructor(
        private readonly realms: IdpRealmSet,
        private readonly clients: SqlIdpClientStore,
        private readonly sso: SqlSsoSessionStore,
        private readonly refreshTokens: SqlRefreshTokenStore,
        private readonly signingKey: IdpSigningKey,
        /** The in-cluster origin of the token, key and revocation endpoints; undefined: the issuer's own origin. */
        private readonly internalBaseUrl: string | undefined,
        private readonly secureCookie: boolean)
    {
    }

    public Register(routes: RouteTable): void
    {
        routes.Add({ Method: HttpMethod.Get, Pattern: RealmIssuer.Pattern(RealmIssuer.DiscoveryPath), Auth: RouteAuth.Public, Handler: ctx => this.Discovery(ctx) });
        routes.Add({ Method: HttpMethod.Get, Pattern: RealmIssuer.Pattern(RealmIssuer.CertsPath), Auth: RouteAuth.Public, Handler: ctx => this.Certs(ctx) });
        routes.Add({ Method: HttpMethod.Get, Pattern: RealmIssuer.Pattern(RealmIssuer.LogoutPath), Auth: RouteAuth.Public, Handler: ctx => this.Logout(ctx, false) });
        routes.Add({ Method: HttpMethod.Post, Pattern: RealmIssuer.Pattern(RealmIssuer.LogoutPath), Auth: RouteAuth.Public, Audited: false, Handler: ctx => this.Logout(ctx, true) });
    }

    /** The realm's discovery document. */
    public DiscoveryOf(realm: IdpRealm): Record<string, unknown>
    {
        const P = ProtocolEndpoints;
        const issuer = realm.Issuer;
        const internal = this.internalBaseUrl === undefined ? issuer : RealmIssuer.Of(this.internalBaseUrl, realm.Id);
        const prompts = [AuthorizeRequest.PromptNone, AuthorizeRequest.PromptLogin];
        if (realm.Settings.OffersSignUp)
        {
            prompts.push(AuthorizeRequest.PromptCreate);
        }
        return {
            [P.IssuerField]: issuer,
            [P.AuthorizationEndpointField]: issuer + RealmIssuer.AuthorizePath,
            [P.TokenEndpointField]: internal + RealmIssuer.TokenPath,
            [P.JwksUriField]: internal + RealmIssuer.CertsPath,
            [P.RevocationEndpointField]: internal + RealmIssuer.RevocationPath,
            [P.EndSessionEndpointField]: issuer + RealmIssuer.LogoutPath,
            [P.ResponseTypesField]: P.ResponseTypes,
            [P.GrantTypesField]: P.GrantTypes,
            [P.SubjectTypesField]: P.SubjectTypes,
            [P.SigningAlgsField]: P.SigningAlgs,
            [P.ChallengeMethodsField]: P.ChallengeMethods,
            [P.TokenAuthMethodsField]: P.TokenAuthMethods,
            [P.ScopesField]: P.Scopes,
            [P.ClaimsField]: P.Claims,
            [P.PromptValuesField]: prompts,
        };
    }

    private async Discovery(ctx: RequestContext): Promise<void>
    {
        const realm = this.realms.For(ctx.Param(RealmIssuer.RealmParam));
        if (realm === undefined)
        {
            ctx.WriteJson(ProtocolEndpoints.StatusNotFound, { [ProtocolEndpoints.ErrorField]: ProtocolEndpoints.UnknownRealm });
            return;
        }
        ctx.WriteJson(ProtocolEndpoints.StatusOk, this.DiscoveryOf(realm));
    }

    private async Certs(ctx: RequestContext): Promise<void>
    {
        if (this.realms.For(ctx.Param(RealmIssuer.RealmParam)) === undefined)
        {
            ctx.WriteJson(ProtocolEndpoints.StatusNotFound, { [ProtocolEndpoints.ErrorField]: ProtocolEndpoints.UnknownRealm });
            return;
        }
        ctx.WriteJson(ProtocolEndpoints.StatusOk, this.signingKey.PublicJwks());
    }

    /**
     * RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0). A GET carrying an `id_token_hint` this realm signed
     * for the session's account ends the session at once; any other GET with a live session answers a confirmation page
     * whose button POSTs back here (the Origin guard covers the POST), so another site cannot sign a person out with a
     * plain link or image. Ending a session ends every refresh token issued under it and clears the cookie; the browser
     * then returns to `post_logout_redirect_uri` when it is registered for the client (`client_id`, else the hint's
     * audience), with `state`.
     */
    private async Logout(ctx: RequestContext, confirmed: boolean): Promise<void>
    {
        const P = ProtocolEndpoints;
        const realm = this.realms.For(ctx.Param(RealmIssuer.RealmParam));
        if (realm === undefined)
        {
            ctx.WriteJson(P.StatusNotFound, { [P.ErrorField]: P.UnknownRealm });
            return;
        }
        const target = ctx.Query.get(P.PostLogoutParam);
        const hint = ctx.Query.get(P.IdTokenHintParam);
        const verified = hint === null ? undefined : await this.signingKey.VerifyOwn(hint, realm.Issuer);
        const hintAudience = typeof verified?.aud === 'string' ? verified.aud : undefined;
        const clientId = ctx.Query.get(P.ClientIdParam) ?? hintAudience;
        const client = target === null || clientId === undefined ? undefined : await this.clients.Find(realm.Id, clientId);
        if (target !== null && (client === undefined || !client.PostLogoutAllowed(target)))
        {
            ctx.WriteJson(P.StatusBadRequest, { [P.ErrorField]: P.InvalidRequest, [P.DescriptionField]: P.BadPostLogoutDescription });
            return;
        }
        const id = IdpSsoCookie.Read(ctx.Request.headers.cookie);
        const session = id === undefined ? undefined : await this.sso.Validate(id, realm.Id);
        ctx.Response.setHeader(P.CacheControlHeader, P.NoStore);
        if (session !== undefined)
        {
            if (!confirmed && verified?.sub !== session.SignIn.AccountId)
            {
                ctx.Response.writeHead(P.StatusOk, { [P.ContentTypeHeader]: P.HtmlType });
                ctx.Response.end(P.ConfirmPage(ctx.Path + (ctx.Query.size > 0 ? P.QueryMark + ctx.Query.toString() : P.NoText)));
                return;
            }
            await this.sso.Revoke(session.IdHash);
            await this.refreshTokens.RevokeSso(session.IdHash);
        }
        ctx.Response.setHeader(P.SetCookieHeader, IdpSsoCookie.Clear(realm.Id, this.secureCookie));
        if (target === null)
        {
            ctx.WriteJson(P.StatusOk, { [P.SignedOutField]: true });
            return;
        }
        const location = new URL(target);
        const state = ctx.Query.get(P.StateParam);
        if (state !== null)
        {
            location.searchParams.set(P.StateParam, state);
        }
        ctx.Response.writeHead(P.StatusFound, { [P.LocationHeader]: location.toString() });
        ctx.Response.end();
    }

    /** The sign-out confirmation: one button posting back to `action` (escaped; no script, no inline style). */
    private static ConfirmPage(action: string): string
    {
        const P = ProtocolEndpoints;
        return P.ConfirmPrefix + P.EscapeAttribute(action) + P.ConfirmSuffix;
    }

    private static EscapeAttribute(text: string): string
    {
        return text.replace(HtmlAttributeEscapes.Pattern, match => HtmlAttributeEscapes.Map.get(match) ?? match);
    }
}

/** HTML attribute escaping for the confirmation page's form action. */
class HtmlAttributeEscapes
{
    public static readonly Pattern = /[&"<>']/g;
    public static readonly Map: ReadonlyMap<string, string> = new Map([['&', '&amp;'], ['"', '&quot;'], ['<', '&lt;'], ['>', '&gt;'], ["'", '&#39;']]);
}
