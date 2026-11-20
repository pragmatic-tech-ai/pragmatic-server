import { AuthorizationGrant, type SqlAuthorizationCodeStore } from './sql-authorization-code-store.js';
import type { SqlSsoSessionStore, SsoSession } from './sql-sso-session-store.js';
import type { SqlRefreshTokenStore } from './sql-refresh-token-store.js';
import type { AuthorizeRequest } from './authorize-request.js';
import type { IdpRealm } from './idp-realm.js';
import { IdpSsoCookie } from './idp-sso-cookie.js';
import type { RealmSignIn } from './realm-sign-in.js';

/** Where the browser goes next, and the SSO cookie to set on the way (a new session only). */
export class SignInRedirect
{
    public constructor(public readonly Location: string, public readonly SetCookie: string | undefined)
    {
        Object.freeze(this);
    }
}

/**
 * The end of every sign-in (password, Identity Platform, an upstream source, or a silent one from the SSO session):
 * opens an SSO session unless one answered the request, issues a single-use authorization code bound to the request
 * (client, redirect URI, PKCE challenge, nonce) and the sign-in, and redirects to the client with code and state.
 */
export class SignInCompletion
{
    private static readonly CodeParam = 'code';
    private static readonly StateParam = 'state';
    private static readonly ErrorParam = 'error';

    public constructor(
        private readonly codes: SqlAuthorizationCodeStore,
        private readonly sso: SqlSsoSessionStore,
        private readonly refreshTokens: SqlRefreshTokenStore,
        private readonly secureCookie: boolean)
    {
    }

    /**
     * `session`: the SSO session that answered the request (none: a new one is opened). `replacedCookie`: the cookie the
     * browser still carried when it signed in again (e.g. `prompt=login`); that session and the refresh tokens issued
     * under it end, so a later logout cannot miss them.
     */
    public async Complete(realm: IdpRealm, request: AuthorizeRequest, signIn: RealmSignIn, session?: SsoSession, replacedCookie?: string): Promise<SignInRedirect>
    {
        let setCookie: string | undefined;
        let ssoIdHash = session?.IdHash;
        if (session === undefined)
        {
            const replaced = replacedCookie === undefined ? undefined : await this.sso.Validate(replacedCookie, realm.Id);
            if (replaced !== undefined)
            {
                await this.sso.Revoke(replaced.IdHash);
                await this.refreshTokens.RevokeSso(replaced.IdHash);
            }
            const issued = await this.sso.Issue(realm.Id, signIn, realm.Settings.Tokens.SsoSessionMs);
            setCookie = IdpSsoCookie.Build(realm.Id, issued.Id, issued.Session.ExpiresAt, this.secureCookie);
            ssoIdHash = issued.Session.IdHash;
        }
        const code = await this.codes.Issue(new AuthorizationGrant(realm.Id, request.ClientId, request.RedirectUri, request.Nonce, request.CodeChallenge, signIn, ssoIdHash));
        const target = new URL(request.RedirectUri);
        target.searchParams.set(SignInCompletion.CodeParam, code);
        target.searchParams.set(SignInCompletion.StateParam, request.State);
        return new SignInRedirect(target.toString(), setCookie);
    }

    /** An OAuth error answered to the client (its redirect URI is registered): e.g. `login_required` for prompt=none. */
    public static ErrorRedirect(request: AuthorizeRequest, error: string): string
    {
        const target = new URL(request.RedirectUri);
        target.searchParams.set(SignInCompletion.ErrorParam, error);
        target.searchParams.set(SignInCompletion.StateParam, request.State);
        return target.toString();
    }
}
