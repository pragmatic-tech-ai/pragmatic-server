/**
 * GATED end-to-end SSO smoke for the SP-HIVE-6a local OIDC identity provider (`pragmatic-idp`).
 * NOT a *.test.ts and NOT part of any test glob. Run it directly:
 *
 *   npx tsx admin/control-plane/idp-sso-smoke.ts
 *
 * Requires the openssl CLI on PATH (DevCa mints a dev CA + server cert at runtime). The smoke stands up
 * the real IdpHost over HTTPS, seeds one tenant account, registers two confidential clients with distinct
 * redirect URIs, then proves SINGLE SIGN-ON across the two "environments" using the REAL relying-party
 * verifier (`OidcAuthenticator`): env A performs an interactive login, env B rides the IdP's SSO cookie
 * straight to a code with NO login page. Four negative gates (off-allowlist redirect, code replay, bad
 * PKCE verifier, tampered id_token) assert the issuer fails closed. The dev CA is handed to every HTTPS
 * client in-process (node:https `{ ca }`); NODE_EXTRA_CA_CERTS is deliberately NOT used.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalJWKSet, jwtVerify } from 'jose'
import type { JSONWebKeySet } from 'jose'
import {
    AuthMethod, AuthenticatedResult, Credential, DelegationDepth,
    IdentityConfig, PresentedSecret, Tenant, TenantKind,
} from '@pragmatic-tech-ai/todl-identity'
import type { ISecretStore } from '@pragmatic-tech-ai/todl-identity'
import {
    AuthorizationRequest, ClaimArrayGroupStrategy, ClaimsMapper, InMemoryOidcFlowStateStore,
    JwksCache, OidcAuthenticator, OidcDiscovery, OidcResolvedConfig, PkceChallenge,
} from '@pragmatic-tech-ai/todl-identity-cloud'
import type { IHttpClient } from '@pragmatic-tech-ai/todl-identity-cloud'
import { InMemoryAuthorizationCodeStore } from '../../src/idp/authorization-code-store.js'
import { DevCa, IdpTlsMaterial } from '../../src/idp/dev-ca.js'
import { IdpClientStore } from '../../src/idp/idp-client-store.js'
import { IdpHost, IdpRealmSet } from '../../src/idp/idp-host.js'
import { IdpRealm } from '../../src/idp/idp-realm.js'
import { IdpSigningKey } from '../../src/idp/idp-signing-key.js'
import { IdpSsoSessionStore } from '../../src/idp/idp-sso-session.js'

/** An in-memory `ISecretStore` over a Map — the RP's client-secret vault for one environment. */
class MapSecretStore implements ISecretStore
{
    private readonly entries = new Map<string, string>()

    public async Get(reference: string): Promise<string | null>
    {
        return this.entries.get(reference) ?? null
    }

    public async Put(reference: string, secret: string): Promise<void>
    {
        this.entries.set(reference, secret)
    }

    public async Delete(reference: string): Promise<void>
    {
        this.entries.delete(reference)
    }
}

/** The raw result of one browser-side HTTPS exchange; redirects are read, never followed. */
class BrowserResponse
{
    public constructor(
        public readonly Status: number,
        public readonly Location: string | undefined,
        public readonly SsoCookie: string | undefined,
        public readonly Body: string)
    {
    }

    public Json(): Record<string, unknown>
    {
        return JSON.parse(this.Body) as Record<string, unknown>
    }
}

/**
 * A minimal `node:https` relying-party HTTP client that trusts a supplied dev CA. Implements the exact
 * `IHttpClient` surface the OidcAuthenticator consumes (https-only, JSON responses, no redirect following).
 */
class HttpsCaClient implements IHttpClient
{
    private static readonly HttpsProtocol = 'https:'
    private static readonly NonHttpsMessage = 'HttpsCaClient: only https URLs are permitted: '
    private static readonly RequestFailedMessage = 'HttpsCaClient: HTTP request failed with status '

    public constructor(private readonly transport: BrowserClient)
    {
    }

    public async GetJson(url: string): Promise<unknown>
    {
        this.RequireHttps(url)
        return this.ParseOk(await this.transport.Get(url, undefined))
    }

    public async PostForm(url: string, fields: ReadonlyMap<string, string>): Promise<unknown>
    {
        this.RequireHttps(url)
        return this.ParseOk(await this.transport.PostForm(url, fields, undefined))
    }

    private ParseOk(response: BrowserResponse): unknown
    {
        if (response.Status < 200 || response.Status >= 300)
        {
            throw new Error(HttpsCaClient.RequestFailedMessage + response.Status)
        }
        return response.Json()
    }

    private RequireHttps(url: string): void
    {
        if (new URL(url).protocol !== HttpsCaClient.HttpsProtocol)
        {
            throw new Error(HttpsCaClient.NonHttpsMessage + url)
        }
    }
}

/** Plays the user-agent: raw HTTPS GET/POST against the IdP, returning status + Location + SSO cookie + body. */
class BrowserClient
{
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly FormContentType = 'application/x-www-form-urlencoded'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly CookieHeader = 'Cookie'
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly CookieName = 'idp_sso'
    private static readonly CookieAssign = 'idp_sso='
    private static readonly AttributeSeparator = ';'
    private static readonly Utf8 = 'utf8'
    private static readonly TimeoutMs = 10000
    private static readonly TimeoutMessage = 'BrowserClient: request timed out'

    public constructor(private readonly ca: Buffer)
    {
    }

    public Get(url: string, cookie: string | undefined): Promise<BrowserResponse>
    {
        return this.Send(BrowserClient.MethodGet, url, cookie, undefined)
    }

    public PostForm(url: string, fields: ReadonlyMap<string, string>, cookie: string | undefined): Promise<BrowserResponse>
    {
        const body = new URLSearchParams([...fields]).toString()
        return this.Send(BrowserClient.MethodPost, url, cookie, body)
    }

    private Send(method: string, url: string, cookie: string | undefined, body: string | undefined): Promise<BrowserResponse>
    {
        const headers: Record<string, string> = {}
        if (cookie !== undefined)
        {
            headers[BrowserClient.CookieHeader] = cookie
        }
        if (body !== undefined)
        {
            headers[BrowserClient.ContentTypeHeader] = BrowserClient.FormContentType
            headers[BrowserClient.ContentLengthHeader] = String(Buffer.byteLength(body))
        }
        return new Promise<BrowserResponse>((resolve, reject) =>
        {
            const req = httpsRequest(url, { ca: this.ca, method, headers }, (res: IncomingMessage) =>
            {
                const chunks: Buffer[] = []
                res.on('data', (chunk: Buffer) => chunks.push(chunk))
                res.on('end', () =>
                {
                    resolve(new BrowserResponse(
                        res.statusCode ?? 0,
                        res.headers.location,
                        BrowserClient.ReadSsoCookie(res.headers['set-cookie']),
                        Buffer.concat(chunks).toString(BrowserClient.Utf8)))
                })
                res.on('error', reject)
            })
            req.setTimeout(BrowserClient.TimeoutMs, () => req.destroy(new Error(BrowserClient.TimeoutMessage)))
            req.on('error', reject)
            if (body !== undefined)
            {
                req.write(body)
            }
            req.end()
        })
    }

    /** Returns the `idp_sso=<id>` pair (no attributes) ready to resend as a Cookie header, or undefined. */
    private static ReadSsoCookie(setCookie: string[] | undefined): string | undefined
    {
        if (setCookie === undefined)
        {
            return undefined
        }
        for (const header of setCookie)
        {
            const pair = header.split(BrowserClient.AttributeSeparator)[0].trim()
            if (pair.startsWith(BrowserClient.CookieAssign))
            {
                return pair
            }
        }
        return undefined
    }
}

/** A mutable single-cookie jar shared across the browser-side exchanges that drive the IdP. */
class CookieJar
{
    private cookie: string | undefined

    public Capture(cookie: string | undefined): void
    {
        if (cookie !== undefined)
        {
            this.cookie = cookie
        }
    }

    public Value(): string | undefined
    {
        return this.cookie
    }
}

/** Reserves then releases an ephemeral TCP port so the IdP can be constructed with a matching baseUrl. */
class FreePort
{
    public static Find(host: string): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const server = createNetServer()
            server.once('error', reject)
            server.listen(0, host, () =>
            {
                const port = (server.address() as AddressInfo).port
                server.close(() => resolve(port))
            })
        })
    }
}

export class IdpSsoSmoke
{
    private static readonly TempPrefix = 'idp-sso-smoke-'
    private static readonly Host = '127.0.0.1'
    private static readonly HttpsOrigin = 'https://'
    private static readonly PortSeparator = ':'
    private static readonly PathSeparator = '/'
    private static readonly DiscoveryRest = '.well-known/openid-configuration'
    private static readonly JwksRest = 'jwks'
    private static readonly AuthorizeRest = 'authorize'
    private static readonly TokenRest = 'token'

    private static readonly TlsDirName = 'tls'
    private static readonly SigningKeyFileName = 'signing-key.pem'
    private static readonly RealmsDirName = 'realms'
    private static readonly MasterKeyBytes = 32

    private static readonly TenantId = 'pragmatic-dev'
    private static readonly TenantDisplayName = 'Pragmatic Dev'
    private static readonly AccountEmail = 'maker@pragmatic.dev'
    private static readonly AccountPrincipalId = 'user-maker-0001'
    private static readonly AccountPassword = 'correct-horse-battery-staple'

    private static readonly ClientIdA = 'env-a'
    private static readonly ClientIdB = 'env-b'
    private static readonly RedirectUriA = 'https://env-a.local/cb'
    private static readonly RedirectUriB = 'https://env-b.local/cb'
    private static readonly OffAllowlistRedirect = 'https://evil.example/cb'
    private static readonly ClientSecretA = 'env-a-confidential-secret-9f2c'
    private static readonly ClientSecretB = 'env-b-confidential-secret-4a7e'
    private static readonly SecretRefA = 'oidc-secret/env-a'
    private static readonly SecretRefB = 'oidc-secret/env-b'

    private static readonly PackId = 'generic-oidc'
    private static readonly EmailClaim = 'email'
    private static readonly GroupsClaim = 'groups'
    private static readonly ClientSecretParam = 'client_secret'
    private static readonly Scopes: readonly string[] = ['openid', 'email', 'profile']

    private static readonly EmailField = 'email'
    private static readonly PasswordField = 'password'
    private static readonly GrantTypeField = 'grant_type'
    private static readonly GrantTypeAuthorizationCode = 'authorization_code'
    private static readonly CodeField = 'code'
    private static readonly CodeVerifierField = 'code_verifier'
    private static readonly RedirectUriField = 'redirect_uri'
    private static readonly ClientIdField = 'client_id'
    private static readonly StateField = 'state'
    private static readonly IdTokenField = 'id_token'
    private static readonly ErrorField = 'error'
    private static readonly InvalidGrant = 'invalid_grant'
    private static readonly FormOpenTag = '<form'

    private static readonly StatusOk = 200
    private static readonly StatusFound = 302
    private static readonly StatusBadRequest = 400
    private static readonly JwtSegmentSeparator = '.'
    private static readonly SignatureIndex = 2
    private static readonly FlipFrom = 'A'
    private static readonly FlipTo = 'B'
    private static readonly Rs256 = 'RS256'
    private static readonly RandomEncoding = 'base64url'
    private static readonly StateBytes = 32

    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly InfoTag = 'INFO '
    private static readonly DetailSep = ' -- '
    private static readonly StatusDetailPrefix = 'status='
    private static readonly OverallPass = 'OVERALL PASS: two-environment SSO + 4 negative gates proven against the live IdP'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly TeardownWarning = 'WARN best-effort teardown failed: '
    private static readonly ListeningInfo = 'IdP listening (HTTPS, dev CA) on '
    private static readonly SsoInfo = 'env A set an idp_sso cookie; env B reused it with no login page'

    private static readonly Labels = {
        EnvALoginPage: 'env A: unauthenticated GET /authorize serves a 200 login page (HTML form)',
        EnvARedirect: 'env A: POST credentials -> 302 to env-a redirect_uri with code+state and an idp_sso cookie',
        EnvAAuthenticated: 'env A: real OidcAuthenticator returns AuthenticatedResult with the seeded sub',
        EnvBSso: 'env B: GET /authorize with the jar cookie -> 302 straight to env-b redirect_uri, NO login page',
        EnvBAuthenticated: 'env B: real OidcAuthenticator returns AuthenticatedResult with the SAME sub (SSO proof)',
        GateRedirect: 'gate: off-allowlist redirect_uri is rejected (no 302, no code)',
        GateReplay: 'gate: replaying a consumed authorization code -> invalid_grant',
        GatePkce: 'gate: token exchange with a wrong code_verifier -> invalid_grant',
        GateTamper: 'gate: a tampered id_token signature is rejected by jose against the IdP JWKS',
    }

    private failed = false
    private tempDir: string | undefined
    private host: IdpHost | undefined
    private baseUrl = ''
    private readonly jar = new CookieJar()
    private readonly tenant = new Tenant(IdpSsoSmoke.TenantId, TenantKind.SelfHosted, IdpSsoSmoke.TenantDisplayName)
    private ca!: Buffer
    private browser!: BrowserClient

    public static async Main(): Promise<void>
    {
        const smoke = new IdpSsoSmoke()
        const ok = await smoke.Run()
        console.log(ok ? IdpSsoSmoke.OverallPass : IdpSsoSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = IdpSsoSmoke
        try
        {
            this.tempDir = await mkdtemp(join(tmpdir(), S.TempPrefix))
            await this.StandUp(this.tempDir)
            await this.LoginEnvA()
            await this.SsoEnvB()
            await this.NegativeGates()
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + (err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            await this.Cleanup()
        }
        return !this.failed
    }

    /** Mints TLS, signing key, realm + account, the two clients; binds the host to a known free port. */
    private async StandUp(dir: string): Promise<void>
    {
        const S = IdpSsoSmoke
        const tlsFiles = DevCa.EnsureAt(join(dir, S.TlsDirName), S.Host)
        this.ca = readFileSync(tlsFiles.caFile)
        this.browser = new BrowserClient(this.ca)
        const tls = IdpTlsMaterial.Load({ certFile: tlsFiles.certFile, keyFile: tlsFiles.keyFile })

        const signingKey = await IdpSigningKey.LoadOrCreate(join(dir, S.SigningKeyFileName))
        const masterKey = randomBytes(S.MasterKeyBytes)
        const realm = await IdpRealm.OpenFor(join(dir, S.RealmsDirName), S.TenantId, S.TenantDisplayName, masterKey)
        await realm.SeedAccount(S.AccountEmail, S.AccountPrincipalId, S.AccountPassword)
        const realms = new IdpRealmSet([[S.TenantId, realm]])

        const clients = new IdpClientStore()
        await clients.Register(S.TenantId, S.ClientIdA, [S.RedirectUriA], S.ClientSecretA)
        await clients.Register(S.TenantId, S.ClientIdB, [S.RedirectUriB], S.ClientSecretB)

        const port = await FreePort.Find(S.Host)
        this.baseUrl = S.HttpsOrigin + S.Host + S.PortSeparator + port
        this.host = new IdpHost(this.baseUrl, signingKey, realms, clients, new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true)
        await this.host.Listen(port, S.Host)
        console.log(S.InfoTag + S.ListeningInfo + this.baseUrl)
    }

    /** Env A: unauthenticated GET -> login page -> POST credentials -> 302 code -> real authenticator. */
    private async LoginEnvA(): Promise<void>
    {
        const S = IdpSsoSmoke
        const authenticator = await this.AuthenticatorFor(S.ClientIdA, S.RedirectUriA, S.SecretRefA, S.ClientSecretA)
        const begin = await authenticator.BeginAuthorization(this.tenant)

        const loginPage = await this.browser.Get(begin.Url, undefined)
        this.Check(S.Labels.EnvALoginPage, loginPage.Status === S.StatusOk && loginPage.Body.includes(S.FormOpenTag), S.StatusDetailPrefix + loginPage.Status)

        const form = new Map<string, string>([[S.EmailField, S.AccountEmail], [S.PasswordField, S.AccountPassword]])
        const redirect = await this.browser.PostForm(begin.Url, form, undefined)
        const target = this.ParseRedirect(redirect.Location)
        const landedOnA = redirect.Status === S.StatusFound && this.SameEndpoint(target, S.RedirectUriA)
        this.Check(S.Labels.EnvARedirect, landedOnA && redirect.SsoCookie !== undefined && this.HasCodeState(target), S.StatusDetailPrefix + redirect.Status)
        this.jar.Capture(redirect.SsoCookie)

        const code = target?.searchParams.get(S.CodeField) ?? ''
        const result = await authenticator.Authenticate(new Credential(AuthMethod.Oidc, begin.State), new PresentedSecret(code), this.tenant)
        this.Check(S.Labels.EnvAAuthenticated, result instanceof AuthenticatedResult && result.Principal.Id === S.AccountPrincipalId, this.ResultDetail(result))
    }

    /** Env B: GET with the jar cookie must redirect straight to a code with NO login page served. */
    private async SsoEnvB(): Promise<void>
    {
        const S = IdpSsoSmoke
        const authenticator = await this.AuthenticatorFor(S.ClientIdB, S.RedirectUriB, S.SecretRefB, S.ClientSecretB)
        const begin = await authenticator.BeginAuthorization(this.tenant)

        const redirect = await this.browser.Get(begin.Url, this.jar.Value())
        const target = this.ParseRedirect(redirect.Location)
        const landedOnB = redirect.Status === S.StatusFound && this.SameEndpoint(target, S.RedirectUriB)
        this.Check(S.Labels.EnvBSso, landedOnB && this.HasCodeState(target), S.StatusDetailPrefix + redirect.Status)
        console.log(S.InfoTag + S.SsoInfo)

        const code = target?.searchParams.get(S.CodeField) ?? ''
        const result = await authenticator.Authenticate(new Credential(AuthMethod.Oidc, begin.State), new PresentedSecret(code), this.tenant)
        this.Check(S.Labels.EnvBAuthenticated, result instanceof AuthenticatedResult && result.Principal.Id === S.AccountPrincipalId, this.ResultDetail(result))
    }

    /** Four fail-closed gates driven directly against the IdP endpoints with the raw browser client. */
    private async NegativeGates(): Promise<void>
    {
        const S = IdpSsoSmoke
        await this.GateOffAllowlistRedirect()
        const token = await this.ExchangeCode(S.ClientIdA, S.RedirectUriA, S.ClientSecretA)
        await this.GateReplay(token.code)
        await this.GateBadPkce()
        await this.GateTamperedIdToken(token.idToken)
    }

    /** (a) An authorize request whose redirect_uri is not on the client's allowlist must not yield a 302/code. */
    private async GateOffAllowlistRedirect(): Promise<void>
    {
        const S = IdpSsoSmoke
        const pkce = PkceChallenge.Create()
        const url = this.AuthorizeUrl(S.ClientIdA, S.OffAllowlistRedirect, pkce.Challenge)
        const response = await this.browser.Get(url, this.jar.Value())
        const noRedirect = response.Status !== S.StatusFound && response.Location === undefined
        this.Check(S.Labels.GateRedirect, noRedirect && this.ErrorPresent(response), S.StatusDetailPrefix + response.Status)
    }

    /** (b) Replaying an already-consumed authorization code must be refused with invalid_grant. */
    private async GateReplay(code: string): Promise<void>
    {
        const S = IdpSsoSmoke
        const response = await this.PostToken(this.TokenFields(code, this.FreshVerifier(), S.ClientIdA, S.RedirectUriA, S.ClientSecretA))
        this.Check(S.Labels.GateReplay, this.IsInvalidGrant(response), S.StatusDetailPrefix + response.Status)
    }

    /** (c) A fresh code exchanged with the wrong PKCE verifier must be refused with invalid_grant. */
    private async GateBadPkce(): Promise<void>
    {
        const S = IdpSsoSmoke
        const pkce = PkceChallenge.Create()
        const url = this.AuthorizeUrl(S.ClientIdA, S.RedirectUriA, pkce.Challenge)
        const redirect = await this.browser.Get(url, this.jar.Value())
        const code = this.ParseRedirect(redirect.Location)?.searchParams.get(S.CodeField) ?? ''
        const response = await this.PostToken(this.TokenFields(code, this.FreshVerifier(), S.ClientIdA, S.RedirectUriA, S.ClientSecretA))
        this.Check(S.Labels.GatePkce, this.IsInvalidGrant(response), S.StatusDetailPrefix + response.Status)
    }

    /** (d) A valid id_token with a single flipped signature char must fail jose verification against the JWKS. */
    private async GateTamperedIdToken(idToken: string): Promise<void>
    {
        const S = IdpSsoSmoke
        const segments = idToken.split(S.JwtSegmentSeparator)
        const signature = segments[S.SignatureIndex]
        const flipped = (signature[0] === S.FlipFrom ? S.FlipTo : S.FlipFrom) + signature.slice(1)
        segments[S.SignatureIndex] = flipped
        const tampered = segments.join(S.JwtSegmentSeparator)

        const jwks = await this.FetchJwks()
        const keySet = createLocalJWKSet(jwks)
        let rejected = false
        try
        {
            await jwtVerify(tampered, keySet, { issuer: this.Issuer(), audience: S.ClientIdA, algorithms: [S.Rs256] })
        }
        catch
        {
            rejected = true
        }
        this.Check(S.Labels.GateTamper, rejected)
    }

    /** Drives a full browser authorize+token flow (SSO cookie present) and returns the live code + id_token. */
    private async ExchangeCode(clientId: string, redirectUri: string, secret: string): Promise<{ code: string; idToken: string }>
    {
        const S = IdpSsoSmoke
        const pkce = PkceChallenge.Create()
        const url = this.AuthorizeUrl(clientId, redirectUri, pkce.Challenge)
        const redirect = await this.browser.Get(url, this.jar.Value())
        const code = this.ParseRedirect(redirect.Location)?.searchParams.get(S.CodeField) ?? ''
        const response = await this.PostToken(this.TokenFields(code, pkce.Verifier, clientId, redirectUri, secret))
        const idToken = response.Json()[S.IdTokenField]
        return { code, idToken: typeof idToken === 'string' ? idToken : '' }
    }

    private TokenFields(code: string, verifier: string, clientId: string, redirectUri: string, secret: string): Map<string, string>
    {
        const S = IdpSsoSmoke
        return new Map<string, string>([
            [S.GrantTypeField, S.GrantTypeAuthorizationCode],
            [S.CodeField, code],
            [S.CodeVerifierField, verifier],
            [S.RedirectUriField, redirectUri],
            [S.ClientIdField, clientId],
            [S.ClientSecretParam, secret],
        ])
    }

    private PostToken(fields: Map<string, string>): Promise<BrowserResponse>
    {
        return this.browser.PostForm(this.Issuer() + IdpSsoSmoke.PathSeparator + IdpSsoSmoke.TokenRest, fields, undefined)
    }

    private AuthorizeUrl(clientId: string, redirectUri: string, challenge: string): string
    {
        const S = IdpSsoSmoke
        return AuthorizationRequest.Build({
            AuthorizationEndpoint: this.Issuer() + S.PathSeparator + S.AuthorizeRest,
            ClientId: clientId,
            RedirectUri: redirectUri,
            Scopes: S.Scopes,
            State: this.FreshVerifier(),
            Nonce: this.FreshVerifier(),
            Challenge: challenge,
        })
    }

    /** Constructs a real relying-party verifier for one environment, sharing only the CA-trusting transport. */
    private async AuthenticatorFor(clientId: string, redirectUri: string, secretRef: string, secret: string): Promise<OidcAuthenticator>
    {
        const S = IdpSsoSmoke
        const http = new HttpsCaClient(this.browser)
        const secrets = new MapSecretStore()
        await secrets.Put(secretRef, secret)
        return new OidcAuthenticator({
            Http: http,
            Discovery: new OidcDiscovery(http),
            Jwks: new JwksCache(http),
            FlowStates: new InMemoryOidcFlowStateStore(),
            Secrets: secrets,
            Claims: new ClaimsMapper(new Map([[S.EmailClaim, S.EmailClaim]]), new ClaimArrayGroupStrategy(S.GroupsClaim)),
            Config: new IdentityConfig(S.PackId, DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map()),
            Resolved: new OidcResolvedConfig(
                this.Issuer() + S.PathSeparator + S.DiscoveryRest, this.Issuer(), clientId, redirectUri,
                S.Scopes, secretRef, S.ClientSecretParam),
        })
    }

    private async FetchJwks(): Promise<JSONWebKeySet>
    {
        const http = new HttpsCaClient(this.browser)
        return await http.GetJson(this.Issuer() + IdpSsoSmoke.PathSeparator + IdpSsoSmoke.JwksRest) as JSONWebKeySet
    }

    private Issuer(): string
    {
        return this.baseUrl + IdpSsoSmoke.PathSeparator + IdpSsoSmoke.TenantId
    }

    private FreshVerifier(): string
    {
        return randomBytes(IdpSsoSmoke.StateBytes).toString(IdpSsoSmoke.RandomEncoding)
    }

    private ParseRedirect(location: string | undefined): URL | undefined
    {
        if (location === undefined)
        {
            return undefined
        }
        try
        {
            return new URL(location)
        }
        catch
        {
            return undefined
        }
    }

    /** True when the redirect landed on the expected client callback (origin + path), ignoring the query. */
    private SameEndpoint(target: URL | undefined, expected: string): boolean
    {
        if (target === undefined)
        {
            return false
        }
        const want = new URL(expected)
        return target.origin === want.origin && target.pathname === want.pathname
    }

    private HasCodeState(target: URL | undefined): boolean
    {
        return target !== undefined
            && (target.searchParams.get(IdpSsoSmoke.CodeField) ?? '') !== ''
            && (target.searchParams.get(IdpSsoSmoke.StateField) ?? '') !== ''
    }

    private IsInvalidGrant(response: BrowserResponse): boolean
    {
        return response.Status === IdpSsoSmoke.StatusBadRequest && response.Json()[IdpSsoSmoke.ErrorField] === IdpSsoSmoke.InvalidGrant
    }

    private ErrorPresent(response: BrowserResponse): boolean
    {
        try
        {
            return typeof response.Json()[IdpSsoSmoke.ErrorField] === 'string'
        }
        catch
        {
            return false
        }
    }

    private ResultDetail(result: unknown): string
    {
        return result instanceof AuthenticatedResult ? 'sub=' + result.Principal.Id : 'result=' + (result?.constructor?.name ?? String(result))
    }

    private Check(label: string, ok: boolean, detail = ''): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === '' ? '' : IdpSsoSmoke.DetailSep + detail
        console.log((ok ? IdpSsoSmoke.PassTag : IdpSsoSmoke.FailTag) + label + suffix)
    }

    private async Cleanup(): Promise<void>
    {
        const S = IdpSsoSmoke
        try
        {
            await this.host?.Close()
        }
        catch (e)
        {
            console.log(S.TeardownWarning + (e instanceof Error ? e.message : String(e)))
        }
        if (this.tempDir !== undefined)
        {
            try
            {
                await rm(this.tempDir, { recursive: true, force: true })
            }
            catch (e)
            {
                console.log(S.TeardownWarning + (e instanceof Error ? e.message : String(e)))
            }
        }
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (IdpSsoSmoke.IsEntryPoint())
{
    await IdpSsoSmoke.Main()
}
