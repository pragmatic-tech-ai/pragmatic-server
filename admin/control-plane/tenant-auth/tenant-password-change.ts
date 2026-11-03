import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IdpConnection } from '../idp-workload-driver.js'
import { IdpPasswordResult, type IIdpPasswordClient } from './idp-password-client.js'
import type { TenantSession } from './tenant-session.js'

/** Reaches a tenant's IdP without launching one (the IdP service's connect-only lookup). */
export interface ITenantIdpConnector
{
    ConnectForTenant(tenantId: string): Promise<IdpConnection | undefined>
}

/** Ends the principal's other tenant-portal sessions and sockets, keeping the one session named. */
export interface IOtherSessionsRevoker
{
    RevokeOthersFor(tenantId: string, principalId: string, keepSessionId: string): Promise<void>
}

/**
 * `POST /tenant-auth/password`: the signed-in tenant user changes their own password. The identity is the SESSION's (its
 * tenant and email), never the body's; the body carries only currentPassword, newPassword and an optional
 * confirmPassword. The change is made by the tenant's IdP (its self-service endpoint verifies the current password,
 * throttles, rotates and ends the principal's IdP SSO sessions), reached server-to-server over the IdP's own CA. On success
 * every OTHER tenant-portal session of the principal ends, with its sockets; the session making the request is kept.
 *
 * Replies: 200 { ok, otherSessionsEnded } (a failed revoke still reports the change, with a warning); 400 for a missing,
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

    public constructor(
        private readonly idp: ITenantIdpConnector,
        private readonly client: IIdpPasswordClient,
        private readonly principals: IOtherSessionsRevoker)
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
        const outcome = await this.client.ChangePassword(conn, session.tenantId, session.email, current, next)
        switch (outcome.Result)
        {
            case IdpPasswordResult.Changed:
                await this.EndOtherSessions(res, session)
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

    /** The password is changed: end the principal's other sessions (keeping this one) and report whether that worked. */
    private async EndOtherSessions(res: ServerResponse, session: TenantSession): Promise<void>
    {
        try
        {
            await this.principals.RevokeOthersFor(session.tenantId, session.principalId, session.id)
        }
        catch
        {
            this.Reply(res, TenantPasswordChange.StatusOk, { ok: true, otherSessionsEnded: false, warning: TenantPasswordChange.RevokeFailedWarning })
            return
        }
        this.Reply(res, TenantPasswordChange.StatusOk, { ok: true, otherSessionsEnded: true })
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
