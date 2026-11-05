import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuditThrottle } from '../audit-throttle.js'
import type { LoginThrottle } from '../login-throttle.js'
import { PlaneHttp } from '../plane-http.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { TenantProfileDto } from '../tenant-api/tenant-profile-dto.js'
import type { DesktopAuthGate } from './desktop-auth-gate.js'
import type { DesktopSignInFlows } from './desktop-sign-in-flows.js'
import type { DesktopTargets } from './desktop-targets.js'
import { TenantClientAddress } from './tenant-client-address.js'
import { TenantLoginError, TenantOidcClientKind, type ITenantOidcRelyingParty } from './tenant-oidc-relying-party.js'
import { TenantSessionKind, type TenantSession, type TenantSessionStore } from './tenant-session.js'

/** Live connections opened under a desktop session (the relay): signing out closes them. */
export interface IDesktopSessionConnections
{
    /** Closes the connections opened under session `sessionId`; returns how many. */
    CloseSession(sessionId: string): number
}

/** A /desktop/* route: the method it answers and what runs it. */
type DesktopRoute = { method: string; run: (req: IncomingMessage, res: ServerResponse) => Promise<void> }

/** A read request body: the JSON object (undefined when absent, not JSON or not an object), or that it was over the cap. */
type DesktopBody = { tooLarge: boolean; value: Record<string, unknown> | undefined }

/**
 * The Plexus desktop surface of the tenant plane (`/desktop/*`), Host-independent: the tenant always comes from the sign-in
 * flow or the bearer session, never the Host header or a body field after begin. It is desktop-only, so any request with
 * an Origin header is refused (a browser page cannot drive it).
 *
 * Sign-in brokers the IdP code exchange for a system-browser RFC 8252 loopback redirect. Plexus begins with a SHA-256
 * binding challenge and completes with its preimage, so only the Plexus instance that began a sign-in can finish it (the
 * IdP's own PKCE verifier stays inside the relying party). A completed sign-in issues a Desktop-kind session, the bearer
 * the other routes accept through `DesktopAuthGate`. Secrets (the bearer, the binding verifier, the code, the RP state)
 * are never logged or echoed.
 *
 * Throttling is per end-user address (the last x-forwarded-for hop behind a trusted proxy, else the socket peer): every
 * begin counts against a begin rate limit (it is unauthenticated and costs an IdP registration and a flow slot), and every
 * failed complete counts against the login throttle, which is checked before a flow is taken so a throttled attempt cannot
 * burn a legitimate one.
 */
export class DesktopEndpoint
{
    public static readonly Prefix = '/desktop/'
    /** The begin rate limit: 10 begins per minute per address, then locked for a minute. */
    public static readonly MaxBeginsPerWindow = 10
    public static readonly BeginWindowMs = 60 * 1000

    private static readonly BeginPath = '/desktop/sign-in/begin'
    private static readonly CompletePath = '/desktop/sign-in/complete'
    private static readonly SignOutPath = '/desktop/sign-out'
    private static readonly ProfilePath = '/desktop/profile'
    private static readonly TargetsPath = '/desktop/targets'
    private static readonly ConsolePath = '/desktop/console'
    private static readonly RedirectPattern = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/pragmatic-desktop\/callback$/
    private static readonly ChallengePattern = /^[A-Za-z0-9_-]{43}$/
    /** RFC 7636 verifier shape: 43-128 unreserved characters. */
    private static readonly VerifierPattern = /^[A-Za-z0-9._~-]{43,128}$/
    private static readonly MinPort = 1
    private static readonly MaxPort = 65535
    /** http's default port: URL parsing drops it, so the IdP's loopback rule (which needs a port) refuses it; refused here too. */
    private static readonly DefaultHttpPort = 80
    private static readonly MaxTenantIdLength = 128
    private static readonly MaxRedirectLength = 64
    private static readonly MaxChallengeLength = 43
    private static readonly MaxStateLength = 512
    private static readonly MaxCodeLength = 4096
    private static readonly MaxVerifierLength = 128
    private static readonly MaxBodyBytes = 16384
    private static readonly HashAlgorithm = 'sha256'
    private static readonly ChallengeEncoding = 'base64url'
    private static readonly Ascii = 'ascii'
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly FinishEvent = 'finish'
    /** The login-throttle key's first part: desktop failures are bucketed by address alone (no tenant is known before the flow). */
    private static readonly AddressBucket = ''
    private static readonly TenantIdField = 'tenantId'
    private static readonly RedirectUriField = 'redirectUri'
    private static readonly ChallengeField = 'bindingChallenge'
    private static readonly StateField = 'state'
    private static readonly CodeField = 'code'
    private static readonly VerifierField = 'bindingVerifier'
    private static readonly EmailField = 'email'
    private static readonly AllowHeader = 'Allow'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly NoStore = 'no-store'
    private static readonly Close = 'close'
    private static readonly MsPerSecond = 1000
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusForbidden = 403
    private static readonly StatusNotFound = 404
    private static readonly StatusMethodNotAllowed = 405
    private static readonly StatusPayloadTooLarge = 413
    private static readonly StatusTooManyRequests = 429
    private static readonly StatusBadGateway = 502
    private static readonly ForbiddenBody = { error: 'forbidden' }
    private static readonly InvalidRequestBody = { error: 'invalid-request' }
    private static readonly UnknownTenantBody = { error: 'unknown-tenant' }
    private static readonly SignInFailedBody = { error: 'sign-in-failed' }
    private static readonly SignInUnavailableBody = { error: 'sign-in-unavailable' }
    private static readonly SignedOutBody = { error: 'signed-out' }
    private static readonly TooManyBody = { error: 'too-many-requests' }
    private static readonly TooLargeBody = { error: 'too-large' }
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
        private readonly throttle: LoginThrottle,
        private readonly beginThrottle: AuditThrottle = DesktopEndpoint.NewBeginThrottle(),
        /** Behind a trusted proxy (PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY) the end user's address is the last x-forwarded-for hop. */
        private readonly trustedProxy: boolean = false,
        /** Connections a sign-out ends (the relay); absent, sign-out only revokes the session. */
        private readonly connections?: IDesktopSessionConnections,
        /** The one tenant this listener serves (the in-hive console); absent on the control plane, where /desktop/console is not a route. */
        private readonly consoleTenantId?: string)
    {
        const consoleRoutes: [string, DesktopRoute][] = consoleTenantId === undefined ? []
            : [[DesktopEndpoint.ConsolePath, { method: PlaneHttp.MethodGet, run: (req, res) => this.Console(req, res, consoleTenantId) }]]
        this.routes = new Map<string, DesktopRoute>([
            ...consoleRoutes,
            [DesktopEndpoint.BeginPath, { method: PlaneHttp.MethodPost, run: (req, res) => this.Begin(req, res) }],
            [DesktopEndpoint.CompletePath, { method: PlaneHttp.MethodPost, run: (req, res) => this.Complete(req, res) }],
            [DesktopEndpoint.SignOutPath, { method: PlaneHttp.MethodPost, run: (req, res) => this.Authenticated(req, res, s => this.SignOut(res, s)) }],
            [DesktopEndpoint.ProfilePath, { method: PlaneHttp.MethodGet, run: (req, res) => this.Authenticated(req, res, async s => this.Reply(res, PlaneHttp.StatusOk, this.profile(s))) }],
            [DesktopEndpoint.TargetsPath, { method: PlaneHttp.MethodGet, run: (req, res) => this.Authenticated(req, res, async s => this.Reply(res, PlaneHttp.StatusOk, await this.targets.For(s))) }],
        ])
    }

    /** The begin rate limit this endpoint is built for (10 per minute per address). */
    public static NewBeginThrottle(now?: () => number): AuditThrottle
    {
        return new AuditThrottle({ maxHits: DesktopEndpoint.MaxBeginsPerWindow, windowMs: DesktopEndpoint.BeginWindowMs, lockoutMs: DesktopEndpoint.BeginWindowMs, now })
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

    /**
     * No body -> `{ tenantId, tenantName }` of the one tenant this console serves. Unauthenticated and email-free, so it
     * reveals nothing about accounts; it counts against the begin rate limit (it is the same kind of unauthenticated probe).
     */
    private async Console(req: IncomingMessage, res: ServerResponse, tenantId: string): Promise<void>
    {
        req.resume()
        const ip = TenantClientAddress.Of(req, this.trustedProxy)
        this.beginThrottle.RecordHit(ip)
        const decision = this.beginThrottle.CheckAllowed(ip)
        if (!decision.allowed)
        {
            this.ReplyTooMany(res, decision.retryAfterMs)
            return
        }
        const tenant = this.directory.GetTenant(tenantId)
        if (tenant === undefined)
        {
            this.Reply(res, DesktopEndpoint.StatusNotFound, DesktopEndpoint.UnknownTenantBody)
            return
        }
        this.Reply(res, PlaneHttp.StatusOk, { tenantId, tenantName: tenant.displayName ?? tenantId })
    }

    /** `{ tenantId, redirectUri, bindingChallenge }` -> `{ authorizeUrl }`; the flow is kept under the RP's state. */
    private async Begin(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const ip = TenantClientAddress.Of(req, this.trustedProxy)
        // Every begin counts (before any work), so the request that crosses the limit is itself refused.
        this.beginThrottle.RecordHit(ip)
        const decision = this.beginThrottle.CheckAllowed(ip)
        if (!decision.allowed)
        {
            req.resume()
            this.ReplyTooMany(res, decision.retryAfterMs)
            return
        }
        if (!this.AllowedOrReplied(req, res, ip))
        {
            return
        }
        const body = await this.ReadBodyOrReply(req, res)
        if (body === undefined)
        {
            return
        }
        const tenantId = DesktopEndpoint.StringField(body, DesktopEndpoint.TenantIdField, DesktopEndpoint.MaxTenantIdLength)
        const redirectUri = DesktopEndpoint.StringField(body, DesktopEndpoint.RedirectUriField, DesktopEndpoint.MaxRedirectLength)
        const challenge = DesktopEndpoint.StringField(body, DesktopEndpoint.ChallengeField, DesktopEndpoint.MaxChallengeLength)
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
     * `{ state, code, bindingVerifier }` -> the desktop session. The address's login throttle is checked first, before the
     * body is read or a flow taken. The flow is then taken (single use: a failed attempt burns it), the binding checked,
     * the code redeemed and a Desktop session issued. Every failure is the same 401 and a throttle failure for the address.
     */
    private async Complete(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const ip = TenantClientAddress.Of(req, this.trustedProxy)
        if (!this.AllowedOrReplied(req, res, ip))
        {
            return
        }
        const body = await this.ReadBodyOrReply(req, res)
        if (body === undefined)
        {
            return
        }
        const state = DesktopEndpoint.StringField(body, DesktopEndpoint.StateField, DesktopEndpoint.MaxStateLength)
        const flow = state === undefined ? undefined : this.flows.Take(state)
        const code = DesktopEndpoint.StringField(body, DesktopEndpoint.CodeField, DesktopEndpoint.MaxCodeLength)
        const verifier = DesktopEndpoint.StringField(body, DesktopEndpoint.VerifierField, DesktopEndpoint.MaxVerifierLength)
        if (flow === undefined || state === undefined || code === undefined || verifier === undefined || !DesktopEndpoint.BindingHolds(verifier, flow.bindingChallenge))
        {
            this.Fail(res, ip)
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
            this.Fail(res, ip)
            return
        }
        const session = await this.sessions.Issue(flow.tenantId, who.principalId, who.email, TenantSessionKind.Desktop)
        this.throttle.Clear(DesktopEndpoint.AddressBucket, ip)
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

    /**
     * Ends only the presenting session and the connections (relays) opened under it. A revocation fails closed (refused in
     * memory even if the write failed), so it is still 204, and the connections close either way.
     */
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
        this.connections?.CloseSession(session.id)
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

    /** Whether the address may attempt a sign-in (its login throttle is not locked); answers 429 when it may not. */
    private AllowedOrReplied(req: IncomingMessage, res: ServerResponse, ip: string): boolean
    {
        const decision = this.throttle.CheckAllowed(DesktopEndpoint.AddressBucket, ip)
        if (decision.allowed)
        {
            return true
        }
        req.resume()
        this.ReplyTooMany(res, decision.retryAfterMs)
        return false
    }

    private ReplyTooMany(res: ServerResponse, retryAfterMs: number): void
    {
        this.Reply(res, DesktopEndpoint.StatusTooManyRequests, DesktopEndpoint.TooManyBody,
            { [DesktopEndpoint.RetryAfterHeader]: String(Math.ceil(retryAfterMs / DesktopEndpoint.MsPerSecond)) })
    }

    private Fail(res: ServerResponse, ip: string): void
    {
        this.throttle.RecordFailure(DesktopEndpoint.AddressBucket, ip)
        this.Reply(res, DesktopEndpoint.StatusUnauthorized, DesktopEndpoint.SignInFailedBody)
    }

    private Reply(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void
    {
        res.writeHead(status, { ...extra, [PlaneHttp.ContentType]: PlaneHttp.JsonType, [DesktopEndpoint.CacheControlHeader]: DesktopEndpoint.NoStore })
        res.end(JSON.stringify(body))
    }

    /**
     * The request's JSON object body (undefined fields when it is not one). Over the cap it answers 413, closes the
     * connection and destroys the request once the reply is out, and returns undefined (the caller stops).
     */
    private async ReadBodyOrReply(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined>
    {
        const body = await DesktopEndpoint.ReadBody(req)
        if (body.tooLarge)
        {
            res.once(DesktopEndpoint.FinishEvent, () => req.destroy())
            this.Reply(res, DesktopEndpoint.StatusPayloadTooLarge, DesktopEndpoint.TooLargeBody, { [DesktopEndpoint.ConnectionHeader]: DesktopEndpoint.Close })
            return undefined
        }
        return body.value ?? {}
    }

    /** `http://127.0.0.1:<port>/pragmatic-desktop/callback` with a port 1-65535 other than 80, written without leading zeros. */
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
        return String(port) === raw && port >= DesktopEndpoint.MinPort && port <= DesktopEndpoint.MaxPort && port !== DesktopEndpoint.DefaultHttpPort
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

    private static StringField(body: Record<string, unknown>, field: string, maxLength: number): string | undefined
    {
        const value = body[field]
        return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined
    }

    private static ParseObject(raw: string): Record<string, unknown> | undefined
    {
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

    /** Reads the body; past MaxBodyBytes it stops reading at once (the rest is not drained) and reports tooLarge. */
    private static ReadBody(req: IncomingMessage): Promise<DesktopBody>
    {
        return new Promise((resolveBody, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            const onData = (c: Buffer): void =>
            {
                size += c.length
                if (size > DesktopEndpoint.MaxBodyBytes)
                {
                    req.off(DesktopEndpoint.DataEvent, onData)
                    req.pause()
                    chunks.length = 0
                    resolveBody({ tooLarge: true, value: undefined })
                    return
                }
                chunks.push(c)
            }
            req.on(DesktopEndpoint.DataEvent, onData)
            req.on(DesktopEndpoint.EndEvent, () => resolveBody({ tooLarge: false, value: DesktopEndpoint.ParseObject(Buffer.concat(chunks).toString(DesktopEndpoint.Utf8)) }))
            req.on(DesktopEndpoint.ErrorEvent, reject)
        })
    }
}
