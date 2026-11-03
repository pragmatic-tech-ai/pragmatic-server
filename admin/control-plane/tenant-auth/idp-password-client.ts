import * as https from 'node:https'
import type { IdpConnection } from '../idp-workload-driver.js'

/** How the tenant IdP answered a self-service password change. */
export enum IdpPasswordResult
{
    /** The current password verified and the new one is set (the IdP has ended the principal's SSO sessions). */
    Changed,
    /** The current password did not verify (IdP 401); nothing changed. */
    WrongPassword,
    /** The IdP throttled the attempt (429); RetryAfterSeconds says when to try again, when it said. */
    Throttled,
    /** The IdP refused or failed in any other way, or could not be reached; nothing is known to have changed. */
    Failed
}

export type IdpPasswordOutcome = { Result: IdpPasswordResult; RetryAfterSeconds?: number }

/** The tenant IdP's self-service password endpoint, reached server-to-server. */
export interface IIdpPasswordClient
{
    ChangePassword(conn: IdpConnection, tenantId: string, email: string, currentPassword: string, newPassword: string): Promise<IdpPasswordOutcome>
}

/**
 * HTTPS client for `POST <idp>/<tenant>/password` (the IdP's self-service change: email, currentPassword, newPassword).
 * Trusts only the tenant IdP's CA (`conn.ca`), as the relying party and the admin client do. It never throws: a transport
 * failure is Failed. Neither password is ever logged, put in an error, or kept past the request.
 */
export class IdpPasswordClient implements IIdpPasswordClient
{
    private static readonly PasswordSuffix = '/password'
    private static readonly PathSeparator = '/'
    private static readonly NoText = ''
    private static readonly PostMethod = 'POST'
    private static readonly HttpsProtocol = 'https:'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly RetryAfterHeader = 'retry-after'
    private static readonly JsonType = 'application/json'
    private static readonly Utf8 = 'utf8'
    private static readonly DefaultPort = 443
    private static readonly TimeoutMs = 10000
    private static readonly StatusOk = 200
    private static readonly StatusUnauthorized = 401
    private static readonly StatusTooManyRequests = 429
    private static readonly WholeSeconds = /^\d+$/
    private static readonly TrailingSlashes = /\/+$/

    public async ChangePassword(conn: IdpConnection, tenantId: string, email: string, currentPassword: string, newPassword: string): Promise<IdpPasswordOutcome>
    {
        const url = new URL(conn.baseUrl.replace(IdpPasswordClient.TrailingSlashes, IdpPasswordClient.NoText) + IdpPasswordClient.PathSeparator + encodeURIComponent(tenantId) + IdpPasswordClient.PasswordSuffix)
        if (url.protocol !== IdpPasswordClient.HttpsProtocol)
        {
            return { Result: IdpPasswordResult.Failed }
        }
        const payload = Buffer.from(JSON.stringify({ email, currentPassword, newPassword }), IdpPasswordClient.Utf8)
        try
        {
            return await this.Post(new https.Agent({ ca: conn.ca }), url, payload)
        }
        finally
        {
            payload.fill(0)
        }
    }

    private Post(agent: https.Agent, url: URL, payload: Buffer): Promise<IdpPasswordOutcome>
    {
        return new Promise<IdpPasswordOutcome>(resolve =>
        {
            let settled = false
            const settle = (outcome: IdpPasswordOutcome): void =>
            {
                if (!settled)
                {
                    settled = true
                    agent.destroy()
                    resolve(outcome)
                }
            }
            const req = https.request({
                agent,
                host: url.hostname,
                port: url.port === '' ? IdpPasswordClient.DefaultPort : Number(url.port),
                path: url.pathname,
                method: IdpPasswordClient.PostMethod,
                headers: { [IdpPasswordClient.ContentTypeHeader]: IdpPasswordClient.JsonType, [IdpPasswordClient.ContentLengthHeader]: payload.length },
            }, res =>
            {
                res.resume()
                res.on('end', () => settle(IdpPasswordClient.OutcomeOf(res.statusCode ?? 0, res.headers[IdpPasswordClient.RetryAfterHeader])))
                res.on('error', () => settle({ Result: IdpPasswordResult.Failed }))
            })
            req.setTimeout(IdpPasswordClient.TimeoutMs, () =>
            {
                req.destroy()
                settle({ Result: IdpPasswordResult.Failed })
            })
            req.on('error', () => settle({ Result: IdpPasswordResult.Failed }))
            req.end(payload)
        })
    }

    private static OutcomeOf(status: number, retryAfter: string | string[] | undefined): IdpPasswordOutcome
    {
        if (status === IdpPasswordClient.StatusOk)
        {
            return { Result: IdpPasswordResult.Changed }
        }
        if (status === IdpPasswordClient.StatusUnauthorized)
        {
            return { Result: IdpPasswordResult.WrongPassword }
        }
        if (status === IdpPasswordClient.StatusTooManyRequests)
        {
            const raw = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter
            const trimmed = raw?.trim()
            return trimmed !== undefined && IdpPasswordClient.WholeSeconds.test(trimmed)
                ? { Result: IdpPasswordResult.Throttled, RetryAfterSeconds: Number(trimmed) }
                : { Result: IdpPasswordResult.Throttled }
        }
        return { Result: IdpPasswordResult.Failed }
    }
}
