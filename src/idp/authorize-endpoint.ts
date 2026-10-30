import { AuthorizationCodeBinding } from './authorization-code-store.js';
import type { IAuthorizationCodeStore } from './authorization-code-store.js';
import type { IdpClientStore } from './idp-client-store.js';
import type { IdpLoginThrottle } from './idp-login-throttle.js';
import type { IdpRealmSet } from './idp-host.js';
import { IdpSsoCookie } from './idp-sso-session.js';
import type { IdpSsoSessionStore } from './idp-sso-session.js';

export type AuthorizeResult =
    | { kind: 'redirect'; location: string; setCookie?: string }
    | { kind: 'loginPage'; html: string }
    | { kind: 'error'; status: number; body: object; retryAfterSeconds?: number };

/** The validated, trusted OIDC request parameters. */
class AuthorizeRequest
{
    public constructor(
        public readonly ClientId: string,
        public readonly RedirectUri: string,
        public readonly CodeChallenge: string,
        public readonly State: string,
        public readonly Nonce: string)
    {
    }
}

/** `/authorize`: fail-closed request validation, login form, SSO cookie, PKCE-bound code issue. */
export class AuthorizeEndpoint
{
    public static readonly CodeTtlMs = 60 * 1000;
    private static readonly ResponseType = 'response_type';
    private static readonly ResponseTypeCode = 'code';
    private static readonly ClientIdParam = 'client_id';
    private static readonly RedirectUriParam = 'redirect_uri';
    private static readonly CodeChallengeParam = 'code_challenge';
    private static readonly CodeChallengeMethodParam = 'code_challenge_method';
    private static readonly MethodS256 = 'S256';
    private static readonly StateParam = 'state';
    private static readonly NonceParam = 'nonce';
    private static readonly CodeParam = 'code';
    private static readonly EmailField = 'email';
    private static readonly PasswordField = 'password';
    private static readonly StatusBadRequest = 400;
    private static readonly StatusNotFound = 404;
    private static readonly StatusTooManyRequests = 429;
    private static readonly MillisPerSecond = 1000;
    private static readonly TooManyAttemptsCode = 'too_many_attempts';
    private static readonly TooManyAttemptsDescription = 'Too many failed attempts. Try again later.';
    private static readonly ErrorField = 'error';
    private static readonly DescriptionField = 'error_description';
    private static readonly InvalidRequest = 'invalid_request';
    private static readonly InvalidClient = 'invalid_client';
    private static readonly UnsupportedResponseType = 'unsupported_response_type';
    private static readonly UnknownTenantDescription = 'unknown tenant';
    private static readonly BadResponseTypeDescription = 'response_type must be code';
    private static readonly UnknownClientDescription = 'unknown client';
    private static readonly BadRedirectDescription = 'redirect_uri is not registered for this client';
    private static readonly BadChallengeDescription = 'PKCE code_challenge with method S256 is required';
    private static readonly MissingStateNonceDescription = 'state and nonce are required';
    private static readonly LoginErrorMessage = 'Invalid email or password.';
    private static readonly ErrorPlaceholder = '{{error}}';
    private static readonly ActionPlaceholder = '{{action}}';
    private static readonly MessagePlaceholder = '{{message}}';
    private static readonly ErrorTemplate = '<p role="alert">{{message}}</p>';
    private static readonly LoginTemplate =
        '<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body>'
        + '{{error}}<form method="post" action="{{action}}">'
        + '<label>Email <input type="email" name="email" autocomplete="username" required></label>'
        + '<label>Password <input type="password" name="password" autocomplete="current-password" required></label>'
        + '<button type="submit">Sign in</button></form></body></html>';
    private static readonly ActionPrefix = '?';
    private static readonly EmptyText = '';

    public constructor(
        private readonly realms: IdpRealmSet,
        private readonly clients: IdpClientStore,
        private readonly codes: IAuthorizationCodeStore,
        private readonly sso: IdpSsoSessionStore,
        private readonly secureCookie: boolean,
        private readonly throttle: IdpLoginThrottle,
        private readonly now: () => Date = () => new Date())
    {
    }

    public async HandleGet(tenantId: string, query: URLSearchParams, cookieHeader: string | undefined): Promise<AuthorizeResult>
    {
        const request = this.Validate(tenantId, query);
        if (!(request instanceof AuthorizeRequest))
        {
            return request;
        }
        const id = IdpSsoCookie.Read(cookieHeader);
        const session = id === undefined ? null : this.sso.Validate(id, tenantId);
        if (session === null)
        {
            return this.LoginPage(query, false);
        }
        return this.RedirectWithCode(tenantId, request, session.PrincipalId, undefined);
    }

    public async HandlePost(tenantId: string, query: URLSearchParams, cookieHeader: string | undefined, form: URLSearchParams, clientIp: string): Promise<AuthorizeResult>
    {
        const request = this.Validate(tenantId, query);
        if (!(request instanceof AuthorizeRequest))
        {
            return request;
        }
        const realm = this.realms.For(tenantId);
        const email = form.get(AuthorizeEndpoint.EmailField);
        const password = form.get(AuthorizeEndpoint.PasswordField);
        if (realm === undefined || !email || !password)
        {
            return this.LoginPage(query, true);
        }
        const decision = this.throttle.CheckAllowed(tenantId, email, clientIp);
        if (!decision.allowed)
        {
            return {
                kind: 'error',
                status: AuthorizeEndpoint.StatusTooManyRequests,
                body: { [AuthorizeEndpoint.ErrorField]: AuthorizeEndpoint.TooManyAttemptsCode, [AuthorizeEndpoint.DescriptionField]: AuthorizeEndpoint.TooManyAttemptsDescription },
                retryAfterSeconds: Math.ceil(decision.retryAfterMs / AuthorizeEndpoint.MillisPerSecond)
            };
        }
        const result = await realm.Authenticate(email, password);
        if (result === null)
        {
            this.throttle.RecordFailure(tenantId, email, clientIp);
            return this.LoginPage(query, true);
        }
        this.throttle.Clear(tenantId, email, clientIp);
        const issued = this.sso.Issue(result.Principal.Id, tenantId);
        const cookie = IdpSsoCookie.Build(issued.Id, issued.session.ExpiresAt, this.secureCookie);
        return this.RedirectWithCode(tenantId, request, result.Principal.Id, cookie);
    }

    private Validate(tenantId: string, query: URLSearchParams): AuthorizeRequest | AuthorizeResult
    {
        if (this.realms.For(tenantId) === undefined)
        {
            return this.Error(AuthorizeEndpoint.StatusNotFound, AuthorizeEndpoint.InvalidRequest, AuthorizeEndpoint.UnknownTenantDescription);
        }
        if (query.get(AuthorizeEndpoint.ResponseType) !== AuthorizeEndpoint.ResponseTypeCode)
        {
            return this.Error(AuthorizeEndpoint.StatusBadRequest, AuthorizeEndpoint.UnsupportedResponseType, AuthorizeEndpoint.BadResponseTypeDescription);
        }
        const clientId = query.get(AuthorizeEndpoint.ClientIdParam);
        if (!clientId || this.clients.Find(tenantId, clientId) === undefined)
        {
            return this.Error(AuthorizeEndpoint.StatusBadRequest, AuthorizeEndpoint.InvalidClient, AuthorizeEndpoint.UnknownClientDescription);
        }
        const redirectUri = query.get(AuthorizeEndpoint.RedirectUriParam);
        if (!redirectUri || !this.clients.RedirectAllowed(tenantId, clientId, redirectUri))
        {
            return this.Error(AuthorizeEndpoint.StatusBadRequest, AuthorizeEndpoint.InvalidRequest, AuthorizeEndpoint.BadRedirectDescription);
        }
        const challenge = query.get(AuthorizeEndpoint.CodeChallengeParam);
        if (!challenge || query.get(AuthorizeEndpoint.CodeChallengeMethodParam) !== AuthorizeEndpoint.MethodS256)
        {
            return this.Error(AuthorizeEndpoint.StatusBadRequest, AuthorizeEndpoint.InvalidRequest, AuthorizeEndpoint.BadChallengeDescription);
        }
        const state = query.get(AuthorizeEndpoint.StateParam);
        const nonce = query.get(AuthorizeEndpoint.NonceParam);
        if (!state || !nonce)
        {
            return this.Error(AuthorizeEndpoint.StatusBadRequest, AuthorizeEndpoint.InvalidRequest, AuthorizeEndpoint.MissingStateNonceDescription);
        }
        return new AuthorizeRequest(clientId, redirectUri, challenge, state, nonce);
    }

    private async RedirectWithCode(tenantId: string, request: AuthorizeRequest, sub: string, setCookie: string | undefined): Promise<AuthorizeResult>
    {
        const expiresAt = new Date(this.now().getTime() + AuthorizeEndpoint.CodeTtlMs);
        const profile = await this.realms.For(tenantId)?.LookupProfile(sub);
        const code = await this.codes.Issue(new AuthorizationCodeBinding(
            sub, tenantId, request.ClientId, request.RedirectUri, request.Nonce, request.CodeChallenge, expiresAt,
            profile?.email ?? AuthorizeEndpoint.EmptyText, profile?.name ?? AuthorizeEndpoint.EmptyText));
        const target = new URL(request.RedirectUri);
        target.searchParams.set(AuthorizeEndpoint.CodeParam, code);
        target.searchParams.set(AuthorizeEndpoint.StateParam, request.State);
        return setCookie === undefined
            ? { kind: 'redirect', location: target.toString() }
            : { kind: 'redirect', location: target.toString(), setCookie };
    }

    private LoginPage(query: URLSearchParams, failed: boolean): AuthorizeResult
    {
        const error = failed
            ? AuthorizeEndpoint.ErrorTemplate.replace(AuthorizeEndpoint.MessagePlaceholder, AuthorizeEndpoint.LoginErrorMessage)
            : AuthorizeEndpoint.EmptyText;
        const action = AuthorizeEndpoint.EscapeHtml(AuthorizeEndpoint.ActionPrefix + query.toString());
        const html = AuthorizeEndpoint.LoginTemplate
            .replace(AuthorizeEndpoint.ErrorPlaceholder, () => error)
            .replace(AuthorizeEndpoint.ActionPlaceholder, () => action);
        return { kind: 'loginPage', html };
    }

    private Error(status: number, error: string, description: string): AuthorizeResult
    {
        return { kind: 'error', status, body: { [AuthorizeEndpoint.ErrorField]: error, [AuthorizeEndpoint.DescriptionField]: description } };
    }

    private static EscapeHtml(value: string): string
    {
        return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
}
