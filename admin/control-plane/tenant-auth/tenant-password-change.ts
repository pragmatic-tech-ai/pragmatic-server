import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IdpConnection } from '../idp-workload-driver.js'
import { IdpPasswordResult, type IIdpPasswordClient } from './idp-password-client.js'
import type { TenantSession } from './tenant-session.js'
import { TenantSessionCookie } from './tenant-session-cookie.js'
import { TenantClientAddress } from './tenant-client-address.js'

/** Reaches a tenant's IdP without launching one (the IdP service's connect-only lookup). */
export interface ITenantIdpConnector
{
    ConnectForTenant(tenantId: string): Promise<IdpConnection | undefined>
}

/** Ends every tenant-portal session of the principal and issues the caller a fresh one, moving the caller's sockets to it. */
export interface ISessionRotator
{
    RotateFor(tenantId: string, principalId: string, oldSessionId: string, email?: string): Promise<TenantSession>
}

/**
 * `POST /tenant-auth/password`: the signed-in tenant user changes their own password. The identity is the SESSION's (its
 * tenant and email), never the body's; the body carries only currentPassword, newPassword and an optional
 * confirmPassword. The change is made by the tenant's IdP (its self-service endpoint verifies the current password,
 * throttles, rotates and ends the principal's IdP SSO sessions), reached server-to-server over the IdP's own CA. On success
 * every tenant-portal session of the principal ends, the caller's too, and the caller gets a fresh session (Set-Cookie, the
 * login cookie's flags) that its open sockets move to; every other socket of the principal closes. One change per
 * principal at a time (409 while one runs).
 *
 * Replies: 200 { ok, otherSessionsEnded } (a failed rotation still reports the change, with a warning); 400 for a missing,
 * short (under MinPasswordLength: the IdP enforces none, so this plane does), mismatched or unchanged new password; 403
 * when the current password is wrong (not 401: 401 tells the portal its session is gone); 409 when the session carries no
 * email; 429 + Retry-After passed through from the IdP; 503 when the IdP cannot be reached; 502 for any other IdP refusal.
 * Every reply is no-store. No password is ever echoed, logged, or put in an error.
 */
export class TenantPasswordChange
{
    /** The tenant plane's floor for a new password: the same as the Platform Admin's operator passwords. */
    public static readonly MinPasswordLength = 12

    private static readonly CurrentPasswordField = 'currentPassword'
    private static readonly NewPasswordField = 'newPassword'
    private static readonly ConfirmPasswordField = 'confirmPassword'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly SetCookieHeader = 'Set-Cookie'
    private static readonly KeySeparator = '\u0000'
    private static readonly BusyMessage = 'A password change for this account is already running.'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly JsonContentType = 'application/json'
    private static readonly NoStore = 'no-store'
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly MaxBodyBytes = 16 * 1024
    private static readonly StatusOk = 200
    private static readonly StatusBadRequest = 400
    private static readonly StatusForbidden = 403
    private static readonly StatusConflict = 409
    private static readonly StatusPayloadTooLarge = 413
    private static readonly StatusTooManyRequests = 429
    private static readonly StatusBadGateway = 502
    private static readonly StatusUnavailable = 503
    private static readonly FieldsMessage = 'currentPassword and newPassword (strings) are required'
    private static readonly TooLargeMessage = 'Request body too large'
    private static readonly WeakMessage = 'The new password must be at least ' + TenantPasswordChange.MinPasswordLength + ' characters.'
    private static readonly MismatchMessage = 'The new password and its confirmation do not match.'
    private static readonly SameMessage = 'The new password must differ from the current one.'
    private static readonly NoEmailMessage = 'This sign-in carries no email, so its password cannot be changed here.'
    private static readonly WrongPasswordMessage = 'The current password is not correct.'
    private static readonly ThrottledMessage = 'Too many attempts; try again later.'
    private static readonly UnreachableMessage = 'The identity provider could not be reached; try again later.'
    private static readonly RefusedMessage = 'The password could not be changed.'
    private static readonly RevokeFailedWarning = 'Your password is changed, but your other sessions could not be signed out. Sign out of them, or ask your tenant owner.'

    /** tenant + principal of each change in flight. */
    private readonly inFlight = new Set<string>()

    public constructor(
        private readonly idp: ITenantIdpConnector,
        private readonly client: IIdpPasswordClient,
        private readonly principals: ISessionRotator,
        private readonly secureCookie: boolean,
        /** Behind a trusted proxy (PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY) the end user's address is the last x-forwarded-for hop; else the socket's. */
        private readonly trustedProxy: boolean = false)
    {
    }

    /** Serves the change for the validated `session` (its tenant already matched to the request host). */
    public async Handle(req: IncomingMessage, res: ServerResponse, session: TenantSession): Promise<void>
    {
        const raw = await TenantPasswordChange.ReadBody(req)
        if (raw === undefined)
        {
            this.Reply(res, TenantPasswordChange.StatusPayloadTooLarge, { error: TenantPasswordChange.TooLargeMessage })
            return
        }
        const fields = TenantPasswordChange.ParseObject(raw)
        const current = fields?.[TenantPasswordChange.CurrentPasswordField]
        const next = fields?.[TenantPasswordChange.NewPasswordField]
        const confirm = fields?.[TenantPasswordChange.ConfirmPasswordField]
        if (typeof current !== 'string' || current.length === 0 || typeof next !== 'string')
        {
            this.Reply(res, TenantPasswordChange.StatusBadRequest, { error: TenantPasswordChange.FieldsMessage })
            return
        }
        if (next.length < TenantPasswordChange.MinPasswordLength)
        {
            this.Reply(res, TenantPasswordChange.StatusBadRequest, { error: TenantPasswordChange.WeakMessage })
            return
        }
        if (confirm !== undefined && confirm !== next)
        {
            this.Reply(res, TenantPasswordChange.StatusBadRequest, { error: TenantPasswordChange.MismatchMessage })
            return
        }
        if (next === current)
        {
            this.Reply(res, TenantPasswordChange.StatusBadRequest, { error: TenantPasswordChange.SameMessage })
            return
        }
        if (session.email === undefined || session.email.length === 0)
        {
            this.Reply(res, TenantPasswordChange.StatusConflict, { error: TenantPasswordChange.NoEmailMessage })
            return
        }
        // One change per principal at a time: a second one's rotation would end the first's fresh session.
        const key = session.tenantId + TenantPasswordChange.KeySeparator + session.principalId
        if (this.inFlight.has(key))
        {
            this.Reply(res, TenantPasswordChange.StatusConflict, { error: TenantPasswordChange.BusyMessage })
            return
        }
        this.inFlight.add(key)
        try
        {
            await this.Change(res, session, session.email, current, next, this.EndUserIp(req))
        }
        finally
        {
            this.inFlight.delete(key)
        }
    }

    /** Reaches the tenant IdP, asks it to change the password, and answers by its outcome (guard held). */
    private async Change(res: ServerResponse, session: TenantSession, email: string, current: string, next: string, endUserIp: string): Promise<void>
    {
        let conn: IdpConnection | undefined
        try
        {
            conn = await this.idp.ConnectForTenant(session.tenantId)
        }
        catch
        {
            conn = undefined
        }
        if (conn === undefined)
        {
            this.Reply(res, TenantPasswordChange.StatusUnavailable, { error: TenantPasswordChange.UnreachableMessage })
            return
        }
        const outcome = await this.client.ChangePassword(conn, session.tenantId, email, current, next, endUserIp)
        switch (outcome.Result)
        {
            case IdpPasswordResult.Changed:
                await this.Rotate(res, session)
                return
            case IdpPasswordResult.WrongPassword:
                this.Reply(res, TenantPasswordChange.StatusForbidden, { error: TenantPasswordChange.WrongPasswordMessage })
                return
            case IdpPasswordResult.Throttled:
                this.Reply(res, TenantPasswordChange.StatusTooManyRequests, { error: TenantPasswordChange.ThrottledMessage },
                    outcome.RetryAfterSeconds === undefined ? {} : { [TenantPasswordChange.RetryAfterHeader]: String(outcome.RetryAfterSeconds) })
                return
            default:
                this.Reply(res, TenantPasswordChange.StatusBadGateway, { error: TenantPasswordChange.RefusedMessage })
                return
        }
    }

    /** The password is changed: rotate the caller onto a fresh session (ending all others) and hand it the new cookie. */
    private async Rotate(res: ServerResponse, session: TenantSession): Promise<void>
    {
        let fresh: TenantSession
        try
        {
            fresh = await this.principals.RotateFor(session.tenantId, session.principalId, session.id, session.email)
        }
        catch
        {
            this.Reply(res, TenantPasswordChange.StatusOk, { ok: true, otherSessionsEnded: false, warning: TenantPasswordChange.RevokeFailedWarning })
            return
        }
        const cookie = TenantSessionCookie.Build(fresh.tenantId, fresh.id, new Date(fresh.expiresAt), this.secureCookie)
        this.Reply(res, TenantPasswordChange.StatusOk, { ok: true, otherSessionsEnded: true }, { [TenantPasswordChange.SetCookieHeader]: cookie })
    }

    /**
     * The end user's address, relayed to the IdP for its per-address throttle: the last x-forwarded-for hop only behind a
     * trusted proxy and only when it looks like an IP address; otherwise the socket's peer.
     */
    private EndUserIp(req: IncomingMessage): string
    {
        return TenantClientAddress.Of(req, this.trustedProxy)
    }

    private Reply(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void
    {
        res.writeHead(status, {
            ...extra,
            [TenantPasswordChange.ContentTypeHeader]: TenantPasswordChange.JsonContentType,
            [TenantPasswordChange.CacheControlHeader]: TenantPasswordChange.NoStore,
        })
        res.end(JSON.stringify(body))
    }

    private static ParseObject(raw: string): Record<string, unknown> | undefined
    {
        try
        {
            const parsed: unknown = JSON.parse(raw)
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
        }
        catch
        {
            return undefined
        }
    }

    /** The request body as text, or undefined past MaxBodyBytes (the rest is drained, not buffered). */
    private static ReadBody(req: IncomingMessage): Promise<string | undefined>
    {
        return new Promise(resolve =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on(TenantPasswordChange.DataEvent, (chunk: Buffer) =>
            {
                size += chunk.length
                if (size > TenantPasswordChange.MaxBodyBytes)
                {
                    tooLarge = true
                    chunks.length = 0
                    return
                }
                if (!tooLarge)
                {
                    chunks.push(chunk)
                }
            })
            req.on(TenantPasswordChange.EndEvent, () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString(TenantPasswordChange.Utf8)))
            req.on(TenantPasswordChange.ErrorEvent, () => resolve(undefined))
        })
    }
}
