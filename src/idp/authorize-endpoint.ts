import { BadRequestProblem, HttpMethod, RouteAuth, type RequestContext, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host';
import { AuthorizeRefusal, AuthorizeRequest } from './authorize-request.js';
import { IdentityPlatformOutcome } from './identity-platform-source.js';
import type { IdpLoginPage } from './idp-login-page.js';
import type { IdpLoginThrottles } from './idp-login-throttles.js';
import type { IdpRealm } from './idp-realm.js';
import type { IdpRealmSet } from './idp-realm-set.js';
import { IdpSsoCookie } from './idp-sso-cookie.js';
import { IdpBrokerBinding } from './idp-broker-binding.js';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import { RealmSignIn } from './realm-sign-in.js';
import { SignInCompletion, type SignInRedirect } from './sign-in-completion.js';
import type { SqlIdpClientStore } from './sql-idp-client-store.js';
import type { SqlSsoSessionStore, SsoSession } from './sql-sso-session-store.js';
import { RealmSourceKind } from './tenant-idp-options.js';

/** The ways the login page signs a person in (the `method` of its JSON post). */
export enum LoginMethod
{
    Password = 'password',
    IdentityPlatform = 'identityPlatform',
}

/**
 * The browser side of a realm's sign-in:
 * - `GET <issuer>/protocol/openid-connect/auth`: validates the request; a live SSO session answers it silently (unless
 *   `prompt=login` or `prompt=create`); `prompt=none` without one answers `login_required` to the client; otherwise the
 *   login page (the sign-in app; it reads `prompt` and `login_hint` from the query itself).
 * - `POST <issuer>/login` (JSON, from the login page): `{ request, method, email, password }` or `{ request, method,
 *   idToken }`; answers `{ redirect }` and sets the SSO cookie, or an error the page shows.
 * - `GET <issuer>/login/config`: what the page offers (local accounts, upstream buttons, the Identity Platform config,
 *   sign-up).
 * - `GET <issuer>/broker/<source>/login?<request>` and `.../callback`: an upstream source's round trip.
 */
export class SignInEndpoints
{
    private static readonly RequestField = 'request';
    private static readonly MethodField = 'method';
    private static readonly EmailField = 'email';
    private static readonly PasswordField = 'password';
    private static readonly IdTokenField = 'idToken';
    private static readonly RedirectField = 'redirect';
    private static readonly ErrorField = 'error';
    private static readonly SourceParam = 'source';
    private static readonly CodeParam = 'code';
    private static readonly StateParam = 'state';
    private static readonly QueryMark = '?';
    private static readonly InvalidCredentials = 'invalid_credentials';
    private static readonly EmailNotVerified = 'email_not_verified';
    private static readonly TooManyAttempts = 'too_many_attempts';
    private static readonly LoginRequired = 'login_required';
    private static readonly UpstreamFailed = 'upstream_sign_in_failed';
    private static readonly UnknownSource = 'unknown_source';
    private static readonly UnknownRealm = 'unknown_realm';
    private static readonly ParamPrefix = ':';
    /**
     * Where Google (through Identity Platform) returns the browser: one path for the whole login domain, the redirect
     * URI the central login's OAuth client has registered (G4 ruling). It serves the login page and validates nothing:
     * the page takes its realm and authorize request from its round-trip storage and the answer from its fragment.
     */
    public static readonly FederatedHandlerPath = '/__/auth/handler';
    private static readonly MissingFieldsMessage = 'request, method and its credentials are required';
    private static readonly UnknownMethodMessage = 'unknown sign-in method';
    private static readonly HtmlType = 'text/html; charset=utf-8';
    private static readonly ContentTypeHeader = 'Content-Type';
    private static readonly CacheControlHeader = 'Cache-Control';
    private static readonly NoStore = 'no-store';
    private static readonly LocationHeader = 'Location';
    private static readonly SetCookieHeader = 'Set-Cookie';
    private static readonly RetryAfterHeader = 'Retry-After';
    private static readonly StatusOk = 200;
    private static readonly StatusFound = 302;
    private static readonly StatusUnauthorized = 401;
    private static readonly StatusNotFound = 404;
    private static readonly StatusTooMany = 429;
    private static readonly LoginBodyLimit = 32 * 1024;
    private static readonly NoName = '';

    public constructor(
        private readonly realms: IdpRealmSet,
        private readonly clients: SqlIdpClientStore,
        private readonly sso: SqlSsoSessionStore,
        private readonly completion: SignInCompletion,
        private readonly loginPage: IdpLoginPage,
        private readonly throttles: IdpLoginThrottles,
        private readonly secureCookie: boolean,
        private readonly now: () => Date = () => new Date())
    {
    }

    public Register(routes: RouteTable): void
    {
        const S = SignInEndpoints;
        routes.Add({ Method: HttpMethod.Get, Pattern: RealmIssuer.Pattern(RealmIssuer.AuthorizePath), Auth: RouteAuth.Public, Handler: ctx => this.Authorize(ctx) });
        routes.Add({ Method: HttpMethod.Post, Pattern: RealmIssuer.Pattern(RealmIssuer.LoginPath), Auth: RouteAuth.Public, Audited: false, BodyLimit: S.LoginBodyLimit, Handler: ctx => this.Login(ctx) });
        routes.Add({ Method: HttpMethod.Get, Pattern: RealmIssuer.Pattern(RealmIssuer.LoginConfigPath), Auth: RouteAuth.Public, Handler: ctx => this.LoginConfig(ctx) });
        routes.Add({ Method: HttpMethod.Get, Pattern: S.FederatedHandlerPath, Auth: RouteAuth.Public, Handler: async ctx => this.WritePage(ctx, false) });
        routes.Add({ Method: HttpMethod.Get, Pattern: RealmIssuer.Pattern(RealmIssuer.BrokerSegment + S.ParamPrefix + S.SourceParam + RealmIssuer.BrokerLoginSuffix), Auth: RouteAuth.Public, Handler: ctx => this.BrokerLogin(ctx) });
        routes.Add({ Method: HttpMethod.Get, Pattern: RealmIssuer.Pattern(RealmIssuer.BrokerSegment + S.ParamPrefix + S.SourceParam + RealmIssuer.BrokerCallbackSuffix), Auth: RouteAuth.Public, Handler: ctx => this.BrokerCallback(ctx) });
    }

    private async Authorize(ctx: RequestContext): Promise<void>
    {
        const realm = this.RealmOf(ctx);
        const request = await AuthorizeRequest.Validate(realm, this.clients, ctx.Query.toString());
        if (request instanceof AuthorizeRefusal || realm === undefined)
        {
            this.Refuse(ctx, request as AuthorizeRefusal);
            return;
        }
        if (!request.BypassesSession)
        {
            const session = await this.Session(ctx, realm);
            if (session !== undefined)
            {
                this.Redirect(ctx, await this.completion.Complete(realm, request, session.SignIn, session));
                return;
            }
        }
        if (request.Silent)
        {
            this.RedirectTo(ctx, SignInCompletion.ErrorRedirect(request, SignInEndpoints.LoginRequired));
            return;
        }
        this.WritePage(ctx, false);
    }

    private async Login(ctx: RequestContext): Promise<void>
    {
        const S = SignInEndpoints;
        const body = await ctx.ReadJsonObject();
        const query = body[S.RequestField];
        const method = body[S.MethodField];
        if (typeof query !== 'string' || typeof method !== 'string')
        {
            throw new BadRequestProblem(S.MissingFieldsMessage);
        }
        const realm = this.RealmOf(ctx);
        const request = await AuthorizeRequest.Validate(realm, this.clients, query);
        if (request instanceof AuthorizeRefusal || realm === undefined)
        {
            this.Refuse(ctx, request as AuthorizeRefusal);
            return;
        }
        if (method === LoginMethod.Password)
        {
            await this.PasswordLogin(ctx, realm, request, body);
            return;
        }
        if (method === LoginMethod.IdentityPlatform)
        {
            await this.IdentityPlatformLogin(ctx, realm, request, body);
            return;
        }
        throw new BadRequestProblem(S.UnknownMethodMessage);
    }

    private async PasswordLogin(ctx: RequestContext, realm: IdpRealm, request: AuthorizeRequest, body: Record<string, unknown>): Promise<void>
    {
        const S = SignInEndpoints;
        const email = body[S.EmailField];
        const password = body[S.PasswordField];
        if (typeof email !== 'string' || typeof password !== 'string' || email.trim() === '' || password === '')
        {
            throw new BadRequestProblem(S.MissingFieldsMessage);
        }
        const throttle = this.throttles.For(realm);
        const decision = await throttle.Attempt(email, ctx.ClientAddress);
        if (!decision.Allowed)
        {
            ctx.Response.setHeader(S.RetryAfterHeader, String(decision.RetryAfterSeconds()));
            ctx.WriteJson(S.StatusTooMany, { [S.ErrorField]: S.TooManyAttempts });
            return;
        }
        const signIn = await realm.AuthenticatePassword(email.trim(), password);
        if (signIn === undefined)
        {
            ctx.WriteJson(S.StatusUnauthorized, { [S.ErrorField]: S.InvalidCredentials });
            return;
        }
        await throttle.Succeeded(email, ctx.ClientAddress);
        await this.AnswerSignIn(ctx, realm, request, signIn);
    }

    private async IdentityPlatformLogin(ctx: RequestContext, realm: IdpRealm, request: AuthorizeRequest, body: Record<string, unknown>): Promise<void>
    {
        const S = SignInEndpoints;
        const idToken = body[S.IdTokenField];
        if (typeof idToken !== 'string' || idToken === '')
        {
            throw new BadRequestProblem(S.MissingFieldsMessage);
        }
        const source = realm.IdentityPlatform;
        const verified = source === undefined ? undefined : await source.Verify(idToken);
        if (verified?.Outcome === IdentityPlatformOutcome.EmailNotVerified)
        {
            ctx.WriteJson(S.StatusUnauthorized, { [S.ErrorField]: S.EmailNotVerified });
            return;
        }
        const token = verified?.Token;
        if (token === undefined)
        {
            ctx.WriteJson(S.StatusUnauthorized, { [S.ErrorField]: S.InvalidCredentials });
            return;
        }
        const email = token.Email ?? S.NoName;
        const name = token.DisplayName ?? S.NoName;
        const accountId = await realm.LinkUpstream(RealmSourceKind.IdentityPlatform, token.Uid, email, name);
        if (!(await realm.IsActive(accountId)))
        {
            ctx.WriteJson(S.StatusUnauthorized, { [S.ErrorField]: S.InvalidCredentials });
            return;
        }
        const signIn = new RealmSignIn(accountId, RealmSourceKind.IdentityPlatform, token.Uid, [], email, name, token.EmailVerified, this.now());
        await this.AnswerSignIn(ctx, realm, request, signIn);
    }

    private async AnswerSignIn(ctx: RequestContext, realm: IdpRealm, request: AuthorizeRequest, signIn: RealmSignIn): Promise<void>
    {
        const S = SignInEndpoints;
        const redirect = await this.completion.Complete(realm, request, signIn, undefined, IdpSsoCookie.Read(ctx.Request.headers.cookie));
        if (redirect.SetCookie !== undefined)
        {
            ctx.Response.setHeader(S.SetCookieHeader, redirect.SetCookie);
        }
        ctx.Response.setHeader(S.CacheControlHeader, S.NoStore);
        ctx.WriteJson(S.StatusOk, { [S.RedirectField]: redirect.Location });
    }

    private async LoginConfig(ctx: RequestContext): Promise<void>
    {
        const realm = this.RealmOf(ctx);
        if (realm === undefined)
        {
            ctx.WriteJson(SignInEndpoints.StatusNotFound, { [SignInEndpoints.ErrorField]: SignInEndpoints.UnknownRealm });
            return;
        }
        ctx.Response.setHeader(SignInEndpoints.CacheControlHeader, SignInEndpoints.NoStore);
        ctx.WriteJson(SignInEndpoints.StatusOk, new LoginConfig(realm).ToJson());
    }

    private async BrokerLogin(ctx: RequestContext): Promise<void>
    {
        const S = SignInEndpoints;
        const realm = this.RealmOf(ctx);
        const request = await AuthorizeRequest.Validate(realm, this.clients, ctx.Query.toString());
        if (request instanceof AuthorizeRefusal || realm === undefined)
        {
            this.Refuse(ctx, request as AuthorizeRefusal);
            return;
        }
        const source = realm.Upstream(ctx.Param(S.SourceParam));
        if (source === undefined)
        {
            ctx.WriteJson(S.StatusNotFound, { [S.ErrorField]: S.UnknownSource });
            return;
        }
        const binding = IdpBrokerBinding.Begin(request.Query);
        const location = await source.Begin(binding.ReturnPath);
        ctx.Response.setHeader(S.SetCookieHeader, IdpBrokerBinding.Cookie(realm.Id, binding.Value, this.secureCookie));
        this.RedirectTo(ctx, location);
    }

    private async BrokerCallback(ctx: RequestContext): Promise<void>
    {
        const S = SignInEndpoints;
        const realm = this.RealmOf(ctx);
        const source = realm?.Upstream(ctx.Param(S.SourceParam));
        const code = ctx.Query.get(S.CodeParam);
        const state = ctx.Query.get(S.StateParam);
        const upstream = realm === undefined || source === undefined || code === null || state === null ? undefined : await source.Complete(code, state);
        const carried = upstream === undefined ? undefined : IdpBrokerBinding.Parse(upstream.AuthorizeRequest);
        const bound = carried !== undefined && IdpBrokerBinding.Admits(ctx.Request.headers.cookie, carried);
        const request = carried === undefined || !bound ? undefined : await AuthorizeRequest.Validate(realm, this.clients, carried.AuthorizeRequest);
        if (realm !== undefined)
        {
            ctx.Response.setHeader(S.SetCookieHeader, IdpBrokerBinding.Clear(realm.Id, this.secureCookie));
        }
        if (realm === undefined || source === undefined || upstream === undefined || !(request instanceof AuthorizeRequest))
        {
            ctx.WriteJson(S.StatusUnauthorized, { [S.ErrorField]: S.UpstreamFailed });
            return;
        }
        const subject = upstream.Principal.Id;
        const accountId = await realm.LinkUpstream(source.Id, subject, upstream.Email, upstream.Name);
        if (!(await realm.IsActive(accountId)))
        {
            ctx.WriteJson(S.StatusUnauthorized, { [S.ErrorField]: S.UpstreamFailed });
            return;
        }
        const signIn = new RealmSignIn(accountId, source.Id, subject, upstream.Principal.Groups, upstream.Email, upstream.Name, undefined, this.now());
        const redirect = await this.completion.Complete(realm, request, signIn, undefined, IdpSsoCookie.Read(ctx.Request.headers.cookie));
        if (redirect.SetCookie !== undefined)
        {
            ctx.Response.appendHeader(S.SetCookieHeader, redirect.SetCookie);
        }
        this.RedirectTo(ctx, redirect.Location);
    }

    private RealmOf(ctx: RequestContext): IdpRealm | undefined
    {
        return this.realms.For(ctx.Param(RealmIssuer.RealmParam));
    }

    private async Session(ctx: RequestContext, realm: IdpRealm): Promise<SsoSession | undefined>
    {
        const id = IdpSsoCookie.Read(ctx.Request.headers.cookie);
        const session = id === undefined ? undefined : await this.sso.Validate(id, realm.Id);
        if (session === undefined)
        {
            return undefined;
        }
        const profile = await realm.Profile(session.SignIn.AccountId);
        // A session from before the account's password changed, or of an account gone or disabled, no longer signs in.
        if (profile === undefined || !profile.Active || await realm.IsStale(session.SignIn.AccountId, session.SignIn.AuthenticatedAt))
        {
            await this.sso.Revoke(session.IdHash);
            return undefined;
        }
        return session;
    }

    private Refuse(ctx: RequestContext, refusal: AuthorizeRefusal): void
    {
        ctx.Response.setHeader(SignInEndpoints.CacheControlHeader, SignInEndpoints.NoStore);
        ctx.WriteJson(refusal.Status, refusal.Body());
    }

    private Redirect(ctx: RequestContext, redirect: SignInRedirect): void
    {
        if (redirect.SetCookie !== undefined)
        {
            ctx.Response.setHeader(SignInEndpoints.SetCookieHeader, redirect.SetCookie);
        }
        this.RedirectTo(ctx, redirect.Location);
    }

    private RedirectTo(ctx: RequestContext, location: string): void
    {
        const S = SignInEndpoints;
        ctx.Response.writeHead(S.StatusFound, { [S.LocationHeader]: location, [S.CacheControlHeader]: S.NoStore });
        ctx.Response.end();
    }

    private WritePage(ctx: RequestContext, failed: boolean): void
    {
        const S = SignInEndpoints;
        ctx.Response.writeHead(S.StatusOk, { [S.ContentTypeHeader]: S.HtmlType, [S.CacheControlHeader]: S.NoStore });
        ctx.Response.end(this.loginPage.Render(failed));
    }

    /** The broker login path of a source under the issuer (the login page appends the request). */
    public static BrokerLoginPath(issuer: string, source: string): string
    {
        return issuer + RealmIssuer.BrokerSegment + encodeURIComponent(source) + RealmIssuer.BrokerLoginSuffix + SignInEndpoints.QueryMark;
    }
}

/** What the login page offers for a realm (`GET <issuer>/login/config`). */
export class LoginConfig
{
    private static readonly NoPage = null;
    private static readonly RealmField = 'realm';
    private static readonly DisplayNameField = 'displayName';
    private static readonly LocalField = 'local';
    private static readonly SourcesField = 'sources';
    private static readonly IdField = 'id';
    private static readonly KindField = 'kind';
    private static readonly LabelField = 'label';
    private static readonly LoginField = 'login';
    private static readonly IdentityPlatformField = 'identityPlatform';
    private static readonly SignUpField = 'signUp';

    public constructor(private readonly realm: IdpRealm)
    {
    }

    public ToJson(): Record<string, unknown>
    {
        const L = LoginConfig;
        const realm = this.realm;
        const issuerPath = new URL(realm.Issuer).pathname;
        return {
            [L.RealmField]: realm.Id,
            [L.DisplayNameField]: realm.DisplayName,
            [L.LocalField]: realm.HasLocalAccounts,
            [L.SourcesField]: realm.Upstreams().map(source => ({
                [L.IdField]: source.Id,
                [L.KindField]: source.Settings.Kind,
                [L.LabelField]: source.Label,
                [L.LoginField]: SignInEndpoints.BrokerLoginPath(issuerPath, source.Id),
            })),
            [L.IdentityPlatformField]: realm.IdentityPlatform === undefined ? L.NoPage : realm.IdentityPlatform.PageConfig().ToJson(),
            [L.SignUpField]: realm.Settings.OffersSignUp,
        };
    }
}
