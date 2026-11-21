import { createHash, randomBytes } from 'node:crypto';
import { decodeJwt } from 'jose';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import type { IdpTestReply, TenantIdpTestHost } from './tenant-idp-test-host.js';

/** One authorize request of a test relying party: its query and the PKCE verifier, state and nonce behind it. */
export class IdpTestRequest
{
    public constructor(public readonly Query: string, public readonly Verifier: string, public readonly State: string, public readonly Nonce: string)
    {
    }
}

/** A relying party's side of the sign-in, driven by hand (the login page's JSON post stands in for the browser). */
export class IdpTestFlow
{
    public constructor(
        private readonly host: TenantIdpTestHost,
        public readonly Realm: string,
        public readonly ClientId: string,
        public readonly Secret: string,
        public readonly RedirectUri: string)
    {
    }

    public get Issuer(): string
    {
        return this.host.Issuer(this.Realm);
    }

    public Request(extra: Record<string, string> = {}): IdpTestRequest
    {
        const verifier = randomBytes(32).toString('base64url');
        const state = randomBytes(8).toString('hex');
        const nonce = randomBytes(8).toString('hex');
        const query = new URLSearchParams({
            response_type: 'code',
            client_id: this.ClientId,
            redirect_uri: this.RedirectUri,
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
            state,
            nonce,
            scope: 'openid email profile',
            ...extra,
        }).toString();
        return new IdpTestRequest(query, verifier, state, nonce);
    }

    public Authorize(request: IdpTestRequest, cookie?: string): Promise<IdpTestReply>
    {
        return this.host.Http.Send('GET', this.Issuer + RealmIssuer.AuthorizePath + '?' + request.Query, { Headers: cookie === undefined ? {} : { cookie } });
    }

    public Login(request: IdpTestRequest, body: Record<string, unknown>): Promise<IdpTestReply>
    {
        return this.host.Http.Send('POST', this.Issuer + RealmIssuer.LoginPath, { Json: { request: request.Query, ...body }, Headers: { origin: this.host.BaseUrl } });
    }

    public PasswordLogin(request: IdpTestRequest, email: string, password: string): Promise<IdpTestReply>
    {
        return this.Login(request, { method: 'password', email, password });
    }

    /** The code a redirect (302 Location or the login API's `redirect`) carries for this request. */
    public static CodeOf(location: string, request: IdpTestRequest): string
    {
        const url = new URL(location);
        if (url.searchParams.get('state') !== request.State)
        {
            throw new Error('state mismatch');
        }
        const code = url.searchParams.get('code');
        if (code === null)
        {
            throw new Error('no code in ' + location);
        }
        return code;
    }

    public Exchange(code: string, request: IdpTestRequest, secret: string = this.Secret): Promise<IdpTestReply>
    {
        return this.host.Http.Send('POST', this.Issuer + RealmIssuer.TokenPath, {
            Form: { grant_type: 'authorization_code', code, code_verifier: request.Verifier, redirect_uri: this.RedirectUri, client_id: this.ClientId, client_secret: secret },
        });
    }

    public Refresh(refreshToken: string): Promise<IdpTestReply>
    {
        return this.host.Http.Send('POST', this.Issuer + RealmIssuer.TokenPath, {
            Form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.ClientId, client_secret: this.Secret },
        });
    }

    public Revoke(token: string): Promise<IdpTestReply>
    {
        return this.host.Http.Send('POST', this.Issuer + RealmIssuer.RevocationPath, { Form: { token, client_id: this.ClientId, client_secret: this.Secret } });
    }

    public Logout(cookie: string | undefined, query: string = '', method: string = 'GET'): Promise<IdpTestReply>
    {
        const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
        if (method === 'POST')
        {
            headers.origin = this.host.BaseUrl;
        }
        return this.host.Http.Send(method, this.Issuer + RealmIssuer.LogoutPath + (query === '' ? '' : '?' + query), { Headers: headers });
    }

    /** Signs in with a password and exchanges the code: the token answer and the SSO cookie. */
    public async SignIn(email: string, password: string): Promise<{ Tokens: any; Cookie: string | undefined; Request: IdpTestRequest }>
    {
        const request = this.Request();
        const login = await this.PasswordLogin(request, email, password);
        if (login.Status !== 200)
        {
            throw new Error(`login failed: ${login.Status} ${login.Text}`);
        }
        const exchanged = await this.Exchange(IdpTestFlow.CodeOf(login.Json().redirect, request), request);
        if (exchanged.Status !== 200)
        {
            throw new Error(`exchange failed: ${exchanged.Status} ${exchanged.Text}`);
        }
        return { Tokens: exchanged.Json(), Cookie: login.Cookie(), Request: request };
    }

    public static Claims(idToken: string): Record<string, unknown>
    {
        return decodeJwt(idToken) as Record<string, unknown>;
    }
}
