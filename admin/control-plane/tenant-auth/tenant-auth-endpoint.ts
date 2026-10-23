import type { IncomingMessage, ServerResponse } from 'node:http'
import { TenantLoginError, type ITenantOidcRelyingParty } from './tenant-oidc-relying-party.js'
import type { TenantSessionStore } from './tenant-session.js'
import { TenantSessionCookie } from './tenant-session-cookie.js'

/**
 * The `/tenant-auth/*` HTTP surface: OIDC begin/callback, session introspection, logout. The session token only
 * ever travels in the Set-Cookie of a successful callback; a failed login is a generic 401 with no cookie, and
 * neither the token nor the authorization code is ever logged or echoed.
 */
export class TenantAuthEndpoint
{
    private static readonly BeginPath = '/tenant-auth/oidc/begin'
    private static readonly CallbackPath = '/tenant-auth/oidc/callback'
    private static readonly SessionPath = '/tenant-auth/session'
    private static readonly LogoutPath = '/tenant-auth/logout'
    private static readonly BaseUrl = 'http://localhost'
    private static readonly RootPath = '/'
    private static readonly GetMethod = 'GET'
    private static readonly PostMethod = 'POST'
    private static readonly CodeParam = 'code'
    private static readonly StateParam = 'state'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly NoStore = 'no-store'
    private static readonly LocationHeader = 'Location'
    private static readonly SetCookieHeader = 'Set-Cookie'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly AllowHeader = 'Allow'
    private static readonly JsonContentType = 'application/json'
    private static readonly StatusOk = 200
    private static readonly StatusFound = 302
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusMethodNotAllowed = 405
    private static readonly BadRequestBody = '{"error":"bad request"}'
    private static readonly UnauthorizedBody = '{"error":"unauthorized"}'
    private static readonly MethodNotAllowedBody = '{"error":"method not allowed"}'

    public constructor(
        private readonly rp: ITenantOidcRelyingParty,
        private readonly sessions: TenantSessionStore,
        private readonly secureCookie: boolean)
    {
    }

    /**
     * Handles the request iff `path` is a tenant-auth route; returns whether it did. `tenantId` and `callbackUrl`
     * are derived by `TenantPlaneHost` from the validated request host (never a `?tenant=` query), so `begin`/
     * `callback` act for exactly the tenant whose subdomain the request arrived on.
     */
    public async Handle(req: IncomingMessage, res: ServerResponse, path: string, tenantId: string, callbackUrl: string): Promise<boolean>
    {
        switch (path)
        {
            case TenantAuthEndpoint.BeginPath:
                await this.guard(req, res, TenantAuthEndpoint.GetMethod, () => this.begin(res, tenantId, callbackUrl))
                return true
            case TenantAuthEndpoint.CallbackPath:
                await this.guard(req, res, TenantAuthEndpoint.GetMethod, () => this.callback(req, res, tenantId, callbackUrl))
                return true
            case TenantAuthEndpoint.SessionPath:
                await this.guard(req, res, TenantAuthEndpoint.GetMethod, () => this.session(req, res))
                return true
            case TenantAuthEndpoint.LogoutPath:
                await this.guard(req, res, TenantAuthEndpoint.PostMethod, () => this.logout(req, res))
                return true
            default:
                return false
        }
    }

    private async guard(req: IncomingMessage, res: ServerResponse, method: string, run: () => Promise<void>): Promise<void>
    {
        if (req.method !== method)
        {
            this.reply(res, TenantAuthEndpoint.StatusMethodNotAllowed, TenantAuthEndpoint.MethodNotAllowedBody, { [TenantAuthEndpoint.AllowHeader]: method })
            return
        }
        await run()
    }

    private async begin(res: ServerResponse, tenantId: string, callbackUrl: string): Promise<void>
    {
        try
        {
            const begun = await this.rp.Begin(tenantId, callbackUrl)
            res.writeHead(TenantAuthEndpoint.StatusFound, {
                [TenantAuthEndpoint.LocationHeader]: begun.Url,
                [TenantAuthEndpoint.CacheControlHeader]: TenantAuthEndpoint.NoStore,
            })
            res.end()
        }
        catch (err)
        {
            if (!(err instanceof TenantLoginError))
            {
                throw err
            }
            this.reply(res, TenantAuthEndpoint.StatusUnauthorized, TenantAuthEndpoint.UnauthorizedBody)
        }
    }

    private async callback(req: IncomingMessage, res: ServerResponse, tenantId: string, callbackUrl: string): Promise<void>
    {
        const query = this.query(req)
        const code = query.get(TenantAuthEndpoint.CodeParam)
        const state = query.get(TenantAuthEndpoint.StateParam)
        if (!code || !state)
        {
            this.reply(res, TenantAuthEndpoint.StatusBadRequest, TenantAuthEndpoint.BadRequestBody)
            return
        }
        try
        {
            const who = await this.rp.Complete(tenantId, code, state, callbackUrl)
            const session = await this.sessions.Issue(tenantId, who.principalId, who.email)
            res.writeHead(TenantAuthEndpoint.StatusFound, {
                [TenantAuthEndpoint.LocationHeader]: TenantAuthEndpoint.RootPath,
                [TenantAuthEndpoint.SetCookieHeader]: TenantSessionCookie.Build(tenantId, session.id, new Date(session.expiresAt), this.secureCookie),
                [TenantAuthEndpoint.CacheControlHeader]: TenantAuthEndpoint.NoStore,
            })
            res.end()
        }
        catch (err)
        {
            if (!(err instanceof TenantLoginError))
            {
                throw err
            }
            this.reply(res, TenantAuthEndpoint.StatusUnauthorized, TenantAuthEndpoint.UnauthorizedBody)
        }
    }

    private async session(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const cookie = TenantSessionCookie.Read(req.headers.cookie)
        const session = cookie === null ? null : await this.sessions.Validate(cookie.token)
        if (cookie === null || session === null || session.tenantId !== cookie.tenantId)
        {
            this.reply(res, TenantAuthEndpoint.StatusUnauthorized, TenantAuthEndpoint.UnauthorizedBody)
            return
        }
        const body = session.email === undefined
            ? { tenantId: session.tenantId, principalId: session.principalId }
            : { tenantId: session.tenantId, principalId: session.principalId, email: session.email }
        this.reply(res, TenantAuthEndpoint.StatusOk, JSON.stringify(body))
    }

    private async logout(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const cookie = TenantSessionCookie.Read(req.headers.cookie)
        if (cookie !== null)
        {
            await this.sessions.Revoke(cookie.token)
        }
        res.writeHead(TenantAuthEndpoint.StatusNoContent, {
            [TenantAuthEndpoint.SetCookieHeader]: TenantSessionCookie.BuildClearing(this.secureCookie),
        })
        res.end()
    }

    private query(req: IncomingMessage): URLSearchParams
    {
        return new URL(req.url ?? TenantAuthEndpoint.RootPath, TenantAuthEndpoint.BaseUrl).searchParams
    }

    private reply(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void
    {
        res.writeHead(status, {
            ...extra,
            [TenantAuthEndpoint.ContentTypeHeader]: TenantAuthEndpoint.JsonContentType,
            [TenantAuthEndpoint.CacheControlHeader]: TenantAuthEndpoint.NoStore,
        })
        res.end(body)
    }
}
