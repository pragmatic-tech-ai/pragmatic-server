import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LoginThrottle } from '../login-throttle.js'
import { PlaneHttp } from '../plane-http.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { TenantProfileDto } from '../tenant-api/tenant-profile-dto.js'
import type { DesktopAuthGate } from './desktop-auth-gate.js'
import type { DesktopSignInFlows } from './desktop-sign-in-flows.js'
import type { DesktopTargets } from './desktop-targets.js'
import { TenantLoginError, TenantOidcClientKind, type ITenantOidcRelyingParty } from './tenant-oidc-relying-party.js'
import { TenantSessionKind, type TenantSession, type TenantSessionStore } from './tenant-session.js'

/** A /desktop/* route: the method it answers and what runs it. */
type DesktopRoute = { method: string; run: (req: IncomingMessage, res: ServerResponse) => Promise<void> }

/**
 * The Plexus desktop surface of the tenant plane (`/desktop/*`), Host-independent: the tenant always comes from the sign-in
 * flow or the bearer session, never the Host header or a body field after begin. It is desktop-only, so any request with
 * an Origin header is refused (a browser page cannot drive it).
 *
 * Sign-in brokers the IdP code exchange for a system-browser RFC 8252 loopback redirect. Plexus begins with a SHA-256
 * binding challenge and completes with its preimage, so only the Plexus instance that began a sign-in can finish it (the
 * IdP's own PKCE verifier stays inside the relying party). A completed sign-in issues a Desktop-kind session, the bearer
 * the other routes accept through `DesktopAuthGate`. Secrets (the bearer, the binding verifier, the code, the RP state)
 * are never logged or echoed; every sign-in failure is the same generic 401 and counts against the login throttle.
 */
export class DesktopEndpoint
{
    public static readonly Prefix = '/desktop/'

    private static readonly BeginPath = '/desktop/sign-in/begin'
    private static readonly CompletePath = '/desktop/sign-in/complete'
    private static readonly SignOutPath = '/desktop/sign-out'
    private static readonly ProfilePath = '/desktop/profile'
    private static readonly TargetsPath = '/desktop/targets'
    private static readonly RedirectPattern = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/pragmatic-desktop\/callback$/
    private static readonly ChallengePattern = /^[A-Za-z0-9_-]{43}$/
    /** RFC 7636 verifier shape: 43-128 unreserved characters. */
    private static readonly VerifierPattern = /^[A-Za-z0-9._~-]{43,128}$/
    private static readonly MinPort = 1
    private static readonly MaxPort = 65535
    private static readonly MaxTenantIdLength = 128
    private static readonly MaxStateLength = 512
    private static readonly MaxCodeLength = 4096
    private static readonly MaxBodyBytes = 16384
    private static readonly HashAlgorithm = 'sha256'
    private static readonly ChallengeEncoding = 'base64url'
    private static readonly Ascii = 'ascii'
    private static readonly Utf8 = 'utf8'
    private static readonly NoAddress = ''
    private static readonly NoTenant = ''
    private static readonly TenantIdField = 'tenantId'
    private static readonly RedirectUriField = 'redirectUri'
    private static readonly ChallengeField = 'bindingChallenge'
    private static readonly StateField = 'state'
    private static readonly CodeField = 'code'
    private static readonly VerifierField = 'bindingVerifier'
    private static readonly EmailField = 'email'
    private static readonly AllowHeader = 'Allow'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly NoStore = 'no-store'
    private static readonly MsPerSecond = 1000
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusForbidden = 403
    private static readonly StatusNotFound = 404
    private static readonly StatusMethodNotAllowed = 405
    private static readonly StatusTooManyRequests = 429
    private static readonly StatusBadGateway = 502
    private static readonly ForbiddenBody = { error: 'forbidden' }
    private static readonly InvalidRequestBody = { error: 'invalid-request' }
    private static readonly UnknownTenantBody = { error: 'unknown-tenant' }
    private static readonly SignInFailedBody = { error: 'sign-in-failed' }
    private static readonly SignInUnavailableBody = { error: 'sign-in-unavailable' }
    private static readonly SignedOutBody = { error: 'signed-out' }
    private static readonly TooManyBody = { error: 'too-many-requests' }
    private static readonly MethodNotAllowedBody = { error: 'method-not-allowed' }

    private readonly routes: ReadonlyMap<string, DesktopRoute>

    public constructor(
        private readonly rp: ITenantOidcRelyingParty,
        private readonly sessions: TenantSessionStore,
        private readonly gate: DesktopAuthGate,
        private readonly flows: DesktopSignInFlows,
        private readonly targets: DesktopTargets,
        private readonly directory: ITenantDirectory,
        private readonly profile: (session: TenantSession) => TenantProfileDto,
        private readonly throttle: LoginThrottle)
    {
        this.routes = new Map<string, DesktopRoute>([
            [DesktopEndpoint.BeginPath, { method: PlaneHttp.MethodPost, run: (req, res) => this.Begin(req, res) }],
            [DesktopEndpoint.CompletePath, { method: PlaneHttp.MethodPost, run: (req, res) => this.Complete(req, res) }],
            [DesktopEndpoint.SignOutPath, { method: PlaneHttp.MethodPost, run: (req, res) => this.Authenticated(req, res, s => this.SignOut(res, s)) }],
            [DesktopEndpoint.ProfilePath, { method: PlaneHttp.MethodGet, run: (req, res) => this.Authenticated(req, res, async s => this.Reply(res, PlaneHttp.StatusOk, this.profile(s))) }],
            [DesktopEndpoint.TargetsPath, { method: PlaneHttp.MethodGet, run: (req, res) => this.Authenticated(req, res, async s => this.Reply(res, PlaneHttp.StatusOk, await this.targets.For(s))) }],
        ])
    }

    /** Answers `path` when it is a /desktop/* route and returns whether it did (an unknown /desktop/ path is left unanswered). */
    public async Handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
    {
        if (!path.startsWith(DesktopEndpoint.Prefix))
        {
            return false
        }
        if (req.headers[PlaneHttp.OriginHeader] !== undefined)
        {
            req.resume()
            this.Reply(res, DesktopEndpoint.StatusForbidden, DesktopEndpoint.ForbiddenBody)
            return true
        }
        const route = this.routes.get(path)
        if (route === undefined)
        {
            return false
        }
        if (req.method !== route.method)
        {
            req.resume()
            this.Reply(res, DesktopEndpoint.StatusMethodNotAllowed, DesktopEndpoint.MethodNotAllowedBody, { [DesktopEndpoint.AllowHeader]: route.method })
            return true
        }
        await route.run(req, res)
        return true
    }

    /** `{ tenantId, redirectUri, bindingChallenge }` -> `{ authorizeUrl }`; the flow is kept under the RP's state. */
    private async Begin(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const body = await DesktopEndpoint.ReadObject(req)
        const tenantId = DesktopEndpoint.StringField(body, DesktopEndpoint.TenantIdField, DesktopEndpoint.MaxTenantIdLength)
        const redirectUri = DesktopEndpoint.StringField(body, DesktopEndpoint.RedirectUriField, DesktopEndpoint.MaxStateLength)
        const challenge = DesktopEndpoint.StringField(body, DesktopEndpoint.ChallengeField, DesktopEndpoint.MaxStateLength)
        if (tenantId === undefined || redirectUri === undefined || challenge === undefined
            || !DesktopEndpoint.IsLoopbackRedirect(redirectUri) || !DesktopEndpoint.ChallengePattern.test(challenge))
        {
            this.Reply(res, DesktopEndpoint.StatusBadRequest, DesktopEndpoint.InvalidRequestBody)
            return
        }
        if (this.directory.GetTenant(tenantId) === undefined)
        {
            this.Reply(res, DesktopEndpoint.StatusNotFound, DesktopEndpoint.UnknownTenantBody)
            return
        }
        if (!this.AllowedOrReplied(res, tenantId, DesktopEndpoint.ClientIp(req)))
        {
            return
        }
        let begun: { Url: string; State: string }
        try
        {
            begun = await this.rp.Begin(tenantId, redirectUri, TenantOidcClientKind.Desktop)
        }
        catch (err)
        {
            if (!(err instanceof TenantLoginError))
            {
                throw err
            }
            this.Reply(res, DesktopEndpoint.StatusBadGateway, DesktopEndpoint.SignInUnavailableBody)
            return
        }
        this.flows.Start(tenantId, redirectUri, challenge, begun.State)
        this.Reply(res, PlaneHttp.StatusOk, { authorizeUrl: begun.Url })
    }

    /**
     * `{ state, code, bindingVerifier }` -> the desktop session. The flow is taken first (single use: a failed attempt burns
     * it), then the binding is checked, the code redeemed and a Desktop session issued. Every failure is the same 401 and a
     * throttle failure keyed by the flow's tenant (or none) and the caller's address.
     */
    private async Complete(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const body = await DesktopEndpoint.ReadObject(req)
        const state = DesktopEndpoint.StringField(body, DesktopEndpoint.StateField, DesktopEndpoint.MaxStateLength)
        const flow = state === undefined ? undefined : this.flows.Take(state)
        const throttleKey = flow?.tenantId ?? DesktopEndpoint.NoTenant
        const ip = DesktopEndpoint.ClientIp(req)
        if (!this.AllowedOrReplied(res, throttleKey, ip))
        {
            return
        }
        const code = DesktopEndpoint.StringField(body, DesktopEndpoint.CodeField, DesktopEndpoint.MaxCodeLength)
        const verifier = DesktopEndpoint.StringField(body, DesktopEndpoint.VerifierField, DesktopEndpoint.MaxStateLength)
        if (flow === undefined || state === undefined || code === undefined || verifier === undefined || !DesktopEndpoint.BindingHolds(verifier, flow.bindingChallenge))
        {
            this.Fail(res, throttleKey, ip)
            return
        }
        let who: { principalId: string; email?: string }
        try
        {
            who = await this.rp.Complete(flow.tenantId, code, state, flow.redirectUri, TenantOidcClientKind.Desktop)
        }
        catch (err)
        {
            if (!(err instanceof TenantLoginError))
            {
                throw err
            }
            this.Fail(res, throttleKey, ip)
            return
        }
        const session = await this.sessions.Issue(flow.tenantId, who.principalId, who.email, TenantSessionKind.Desktop)
        this.throttle.Clear(throttleKey, ip)
        const signedIn: Record<string, string> = {
            token: session.id,
            expiresAt: session.expiresAt,
            tenantId: flow.tenantId,
            tenantName: this.directory.GetTenant(flow.tenantId)?.displayName ?? flow.tenantId,
        }
        if (who.email !== undefined)
        {
            signedIn[DesktopEndpoint.EmailField] = who.email
        }
        this.Reply(res, PlaneHttp.StatusOk, signedIn)
    }

    /** Ends only the presenting session. A revocation fails closed (refused in memory even if the write failed), so it is still 204. */
    private async SignOut(res: ServerResponse, session: TenantSession): Promise<void>
    {
        try
        {
            await this.sessions.Revoke(session.id)
        }
        catch
        {
            // Already refused in memory; the token is never logged.
        }
        res.writeHead(DesktopEndpoint.StatusNoContent, { [DesktopEndpoint.CacheControlHeader]: DesktopEndpoint.NoStore })
        res.end()
    }

    /** Runs `run` with the request's Desktop session, or answers 401 signed-out (missing, unknown, expired or console bearer). */
    private async Authenticated(req: IncomingMessage, res: ServerResponse, run: (session: TenantSession) => Promise<void>): Promise<void>
    {
        req.resume()
        const session = await this.gate.Principal(req)
        if (session === null)
        {
            this.Reply(res, DesktopEndpoint.StatusUnauthorized, DesktopEndpoint.SignedOutBody)
            return
        }
        await run(session)
    }

    /** Whether the (tenant, address) key may attempt a sign-in; answers 429 with Retry-After when it may not. */
    private AllowedOrReplied(res: ServerResponse, tenantKey: string, ip: string): boolean
    {
        const decision = this.throttle.CheckAllowed(tenantKey, ip)
        if (decision.allowed)
        {
            return true
        }
        this.Reply(res, DesktopEndpoint.StatusTooManyRequests, DesktopEndpoint.TooManyBody,
            { [DesktopEndpoint.RetryAfterHeader]: String(Math.ceil(decision.retryAfterMs / DesktopEndpoint.MsPerSecond)) })
        return false
    }

    private Fail(res: ServerResponse, tenantKey: string, ip: string): void
    {
        this.throttle.RecordFailure(tenantKey, ip)
        this.Reply(res, DesktopEndpoint.StatusUnauthorized, DesktopEndpoint.SignInFailedBody)
    }

    private Reply(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void
    {
        res.writeHead(status, { ...extra, [PlaneHttp.ContentType]: PlaneHttp.JsonType, [DesktopEndpoint.CacheControlHeader]: DesktopEndpoint.NoStore })
        res.end(JSON.stringify(body))
    }

    /** `http://127.0.0.1:<port>/pragmatic-desktop/callback` with a port 1-65535 written without leading zeros. */
    public static IsLoopbackRedirect(redirectUri: string): boolean
    {
        const m = DesktopEndpoint.RedirectPattern.exec(redirectUri)
        if (m === null)
        {
            return false
        }
        const raw = m[1] as string
        const port = Number(raw)
        // A zero-padded port would not match the IdP's byte-exact loopback rule, so it is refused here too.
        return String(port) === raw && port >= DesktopEndpoint.MinPort && port <= DesktopEndpoint.MaxPort
    }

    /** Timing-safe `base64url(sha256(verifier)) === challenge`. */
    private static BindingHolds(verifier: string, challenge: string): boolean
    {
        if (!DesktopEndpoint.VerifierPattern.test(verifier))
        {
            return false
        }
        const computed = Buffer.from(createHash(DesktopEndpoint.HashAlgorithm).update(verifier, DesktopEndpoint.Ascii).digest(DesktopEndpoint.ChallengeEncoding), DesktopEndpoint.Ascii)
        const expected = Buffer.from(challenge, DesktopEndpoint.Ascii)
        return computed.length === expected.length && timingSafeEqual(computed, expected)
    }

    private static ClientIp(req: IncomingMessage): string
    {
        return req.socket?.remoteAddress ?? DesktopEndpoint.NoAddress
    }

    private static StringField(body: Record<string, unknown> | undefined, field: string, maxLength: number): string | undefined
    {
        const value = body?.[field]
        return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined
    }

    /** The JSON object body, or undefined when it is too large, not JSON, or not an object. */
    private static async ReadObject(req: IncomingMessage): Promise<Record<string, unknown> | undefined>
    {
        const raw = await DesktopEndpoint.ReadBody(req)
        if (raw === undefined)
        {
            return undefined
        }
        try
        {
            const parsed: unknown = JSON.parse(raw)
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
        }
        catch
        {
            return undefined
        }
    }

    private static ReadBody(req: IncomingMessage): Promise<string | undefined>
    {
        return new Promise((resolveBody, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on('data', (c: Buffer) =>
            {
                size += c.length
                if (size > DesktopEndpoint.MaxBodyBytes)
                {
                    tooLarge = true
                    return
                }
                chunks.push(c)
            })
            req.on('end', () => resolveBody(tooLarge ? undefined : Buffer.concat(chunks).toString(DesktopEndpoint.Utf8)))
            req.on('error', reject)
        })
    }
}
