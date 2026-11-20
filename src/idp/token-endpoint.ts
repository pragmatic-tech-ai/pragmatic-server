import { createHash } from 'node:crypto';
import type { IdpRealmSet } from './idp-realm-set.js';
import type { IdpRealm } from './idp-realm.js';
import { RealmSignIn } from './realm-sign-in.js';
import type { RealmTokenIssuer } from './realm-token-issuer.js';
import type { OidcClient, SqlIdpClientStore } from './sql-idp-client-store.js';
import type { SqlAuthorizationCodeStore } from './sql-authorization-code-store.js';
import { RefreshOutcome, type SqlRefreshTokenStore } from './sql-refresh-token-store.js';
import type { SqlSsoSessionStore } from './sql-sso-session-store.js';
import { RealmSourceKind } from './tenant-idp-options.js';

/** The answer of a form-bodied protocol endpoint (token, revocation): a status and a JSON body. */
export class ProtocolReply
{
    public constructor(public readonly Status: number, public readonly Body: Record<string, unknown>)
    {
        Object.freeze(this);
    }
}

/** A confidential client's credentials: `client_secret_post` fields, or `client_secret_basic` (RFC 6749 §2.3.1). */
export class ClientCredentials
{
    private static readonly ClientIdField = 'client_id';
    private static readonly ClientSecretField = 'client_secret';
    private static readonly BasicPrefix = 'basic ';
    private static readonly Base64 = 'base64';
    private static readonly Utf8 = 'utf8';
    private static readonly Colon = ':';
    private static readonly NoValue = '';
    private static readonly Plus = /\+/g;
    private static readonly Space = ' ';

    private constructor(public readonly ClientId: string, public readonly Secret: string)
    {
    }

    public static From(form: URLSearchParams, authorization: string | undefined): ClientCredentials
    {
        const C = ClientCredentials;
        if (authorization !== undefined && authorization.toLowerCase().startsWith(C.BasicPrefix))
        {
            const decoded = Buffer.from(authorization.slice(C.BasicPrefix.length).trim(), C.Base64).toString(C.Utf8);
            const colon = decoded.indexOf(C.Colon);
            if (colon > 0)
            {
                return new ClientCredentials(C.FormDecode(decoded.slice(0, colon)), C.FormDecode(decoded.slice(colon + 1)));
            }
        }
        return new ClientCredentials(form.get(C.ClientIdField) ?? C.NoValue, form.get(C.ClientSecretField) ?? C.NoValue);
    }

    /** RFC 6749 §2.3.1: the Basic user and password are form-urlencoded. */
    private static FormDecode(value: string): string
    {
        try
        {
            return decodeURIComponent(value.replace(ClientCredentials.Plus, ClientCredentials.Space));
        }
        catch
        {
            return ClientCredentials.NoValue;
        }
    }
}

/**
 * `POST <issuer>/protocol/openid-connect/token` (form-encoded, RFC 6749 §3.2): the authorization code grant (single-use
 * code, PKCE S256, the client's secret, the same redirect URI; the account still active and its credentials unchanged
 * since the sign-in) and the refresh token grant (a rotating token of the client: a refresh uses it up and answers the
 * next one; a reused token revokes its family; the account checked again and the roles resolved again). Every refusal
 * is `invalid_grant` / `invalid_client` / `unsupported_grant_type`, nothing more.
 */
export class TokenEndpoint
{
    private static readonly GrantTypeField = 'grant_type';
    private static readonly AuthorizationCodeGrant = 'authorization_code';
    private static readonly RefreshTokenGrant = 'refresh_token';
    private static readonly CodeField = 'code';
    private static readonly VerifierField = 'code_verifier';
    private static readonly RedirectField = 'redirect_uri';
    private static readonly RefreshTokenField = 'refresh_token';
    private static readonly ErrorField = 'error';
    private static readonly InvalidGrant = 'invalid_grant';
    private static readonly InvalidClient = 'invalid_client';
    private static readonly UnsupportedGrantType = 'unsupported_grant_type';
    private static readonly InvalidRequest = 'invalid_request';
    private static readonly IdTokenField = 'id_token';
    private static readonly AccessTokenField = 'access_token';
    private static readonly TokenTypeField = 'token_type';
    private static readonly ExpiresInField = 'expires_in';
    private static readonly BearerType = 'Bearer';
    private static readonly HashAlgorithm = 'sha256';
    private static readonly Base64Url = 'base64url';
    private static readonly StatusOk = 200;
    private static readonly StatusBadRequest = 400;
    private static readonly StatusUnauthorized = 401;
    private static readonly NoValue = '';

    public constructor(
        private readonly realms: IdpRealmSet,
        private readonly clients: SqlIdpClientStore,
        private readonly codes: SqlAuthorizationCodeStore,
        private readonly refreshTokens: SqlRefreshTokenStore,
        private readonly sso: SqlSsoSessionStore,
        private readonly issuer: RealmTokenIssuer)
    {
    }

    public async Handle(realmId: string, form: URLSearchParams, authorization: string | undefined): Promise<ProtocolReply>
    {
        const T = TokenEndpoint;
        const realm = this.realms.For(realmId);
        if (realm === undefined)
        {
            return T.Fail(T.StatusBadRequest, T.InvalidRequest);
        }
        const grantType = form.get(T.GrantTypeField);
        if (grantType !== T.AuthorizationCodeGrant && grantType !== T.RefreshTokenGrant)
        {
            return T.Fail(T.StatusBadRequest, T.UnsupportedGrantType);
        }
        const credentials = ClientCredentials.From(form, authorization);
        const client = await this.clients.Authenticate(realm.Id, credentials.ClientId, credentials.Secret);
        if (client === undefined)
        {
            return T.Fail(T.StatusUnauthorized, T.InvalidClient);
        }
        return grantType === T.AuthorizationCodeGrant ? await this.ExchangeCode(realm, client, form) : await this.Refresh(realm, client, form);
    }

    private async ExchangeCode(realm: IdpRealm, client: OidcClient, form: URLSearchParams): Promise<ProtocolReply>
    {
        const T = TokenEndpoint;
        const verifier = form.get(T.VerifierField) ?? T.NoValue;
        const code = form.get(T.CodeField) ?? T.NoValue;
        const redemption = await this.codes.Take(code);
        if (redemption.Replayed && redemption.ReplayedFamily !== undefined)
        {
            // RFC 6749 §4.1.2: a code used twice revokes what its first use issued.
            await this.refreshTokens.RevokeFamily(redemption.ReplayedFamily);
        }
        const grant = redemption.Grant;
        if (grant === undefined
            || grant.RealmId !== realm.Id
            || grant.ClientId !== client.ClientId
            || grant.RedirectUri !== (form.get(T.RedirectField) ?? T.NoValue)
            || verifier === T.NoValue
            || createHash(T.HashAlgorithm).update(verifier).digest(T.Base64Url) !== grant.CodeChallenge
            || !(await this.StillValid(realm, grant.SignIn))
            || (grant.SsoIdHash !== undefined && !(await this.sso.Exists(grant.SsoIdHash))))
        {
            return T.Fail(T.StatusBadRequest, T.InvalidGrant);
        }
        const tokens = await this.issuer.Issue(realm, client.ClientId, grant.SignIn, grant.Nonce);
        const refresh = await this.refreshTokens.IssueFamily(realm.Id, client.ClientId, grant.SignIn, grant.SsoIdHash, realm.Settings.Tokens, T.FamilyLifetimeOf(realm, grant.SignIn));
        await this.codes.RecordFamily(code, refresh.FamilyId);
        return T.Tokens(tokens.IdToken, tokens.AccessToken, tokens.ExpiresIn, refresh.Token);
    }

    /**
     * How long a sign-in's refresh family may live. A local account is checked at every refresh, so it gets the realm's
     * maximum; an upstream account is checked by its source only when the person signs in there again, so its family
     * ends with the SSO session lifetime (a person removed upstream loses access within it).
     */
    private static FamilyLifetimeOf(realm: IdpRealm, signIn: RealmSignIn): number
    {
        const tokens = realm.Settings.Tokens;
        return signIn.Source === RealmSourceKind.Local ? tokens.RefreshMaxMs : Math.min(tokens.RefreshMaxMs, tokens.SsoSessionMs);
    }

    private async Refresh(realm: IdpRealm, client: OidcClient, form: URLSearchParams): Promise<ProtocolReply>
    {
        const T = TokenEndpoint;
        const redeemed = await this.refreshTokens.Redeem(form.get(T.RefreshTokenField) ?? T.NoValue, realm.Id, client.ClientId);
        const grant = redeemed.Grant;
        if (redeemed.Outcome !== RefreshOutcome.Redeemed || grant === undefined)
        {
            return T.Fail(T.StatusBadRequest, T.InvalidGrant);
        }
        const profile = await realm.Profile(grant.SignIn.AccountId);
        if (profile === undefined || !profile.Active || await realm.IsStale(grant.SignIn.AccountId, grant.SignIn.AuthenticatedAt))
        {
            await this.refreshTokens.RevokeFamily(grant.FamilyId);
            return T.Fail(T.StatusBadRequest, T.InvalidGrant);
        }
        const old = grant.SignIn;
        const signIn = new RealmSignIn(old.AccountId, old.Source, old.Subject, old.Groups, profile.Email, profile.Name, old.EmailVerified, old.AuthenticatedAt);
        const tokens = await this.issuer.Issue(realm, client.ClientId, signIn, undefined);
        const next = await this.refreshTokens.Rotate(grant, signIn, realm.Settings.Tokens);
        if (next === undefined)
        {
            return T.Fail(T.StatusBadRequest, T.InvalidGrant);
        }
        return T.Tokens(tokens.IdToken, tokens.AccessToken, tokens.ExpiresIn, next);
    }

    /** The account still exists, is active, and its credentials did not change since the sign-in. */
    private async StillValid(realm: IdpRealm, signIn: RealmSignIn): Promise<boolean>
    {
        const profile = await realm.Profile(signIn.AccountId);
        return profile !== undefined && profile.Active && !(await realm.IsStale(signIn.AccountId, signIn.AuthenticatedAt));
    }

    private static Tokens(idToken: string, accessToken: string, expiresIn: number, refreshToken: string): ProtocolReply
    {
        const T = TokenEndpoint;
        return new ProtocolReply(T.StatusOk, {
            [T.IdTokenField]: idToken,
            [T.AccessTokenField]: accessToken,
            [T.TokenTypeField]: T.BearerType,
            [T.ExpiresInField]: expiresIn,
            [T.RefreshTokenField]: refreshToken,
        });
    }

    private static Fail(status: number, error: string): ProtocolReply
    {
        return new ProtocolReply(status, { [TokenEndpoint.ErrorField]: error });
    }
}

/**
 * `POST <issuer>/protocol/openid-connect/revoke` (form-encoded, RFC 7009): the client revokes one of its refresh
 * tokens, which ends the token's family. The answer is 200 whether or not the token was known; a bad client is 401.
 */
export class RevocationEndpoint
{
    private static readonly TokenField = 'token';
    private static readonly ErrorField = 'error';
    private static readonly InvalidClient = 'invalid_client';
    private static readonly InvalidRequest = 'invalid_request';
    private static readonly StatusOk = 200;
    private static readonly StatusBadRequest = 400;
    private static readonly StatusUnauthorized = 401;
    private static readonly NoValue = '';

    public constructor(
        private readonly realms: IdpRealmSet,
        private readonly clients: SqlIdpClientStore,
        private readonly refreshTokens: SqlRefreshTokenStore)
    {
    }

    public async Handle(realmId: string, form: URLSearchParams, authorization: string | undefined): Promise<ProtocolReply>
    {
        const R = RevocationEndpoint;
        const realm = this.realms.For(realmId);
        if (realm === undefined)
        {
            return new ProtocolReply(R.StatusBadRequest, { [R.ErrorField]: R.InvalidRequest });
        }
        const credentials = ClientCredentials.From(form, authorization);
        const client = await this.clients.Authenticate(realm.Id, credentials.ClientId, credentials.Secret);
        if (client === undefined)
        {
            return new ProtocolReply(R.StatusUnauthorized, { [R.ErrorField]: R.InvalidClient });
        }
        await this.refreshTokens.RevokeToken(form.get(R.TokenField) ?? R.NoValue, realm.Id, client.ClientId);
        return new ProtocolReply(R.StatusOk, {});
    }
}
