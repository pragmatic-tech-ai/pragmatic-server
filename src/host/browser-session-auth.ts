import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { TLSSocket } from 'node:tls'

/** A tenant-bound session token presented by a browser cookie. The token is a secret: never log or echo it. */
export interface BrowserCredential
{
    Tenant: string
    Token: string
}

/** Browser session-cookie auth: builds the Set-Cookie, parses the cookie back into (tenant, token), and enforces the
 *  Origin allowlist that defends the cookie-authenticated WebSocket upgrade against cross-site hijacking.
 *  The cookie value is `<tenant>.<token>` so a same-origin app that sends no ?tenant= still resolves its tenant. */
export class BrowserSessionAuth
{
    public static readonly CookieName = 'ps_session'
    private static readonly SessionPath = '/auth/session'
    private static readonly LogoutPath = '/auth/logout'
    private static readonly CookieHeader = 'cookie'
    private static readonly OriginHeader = 'origin'
    private static readonly HostHeader = 'host'
    private static readonly ForwardedProtoHeader = 'x-forwarded-proto'
    private static readonly HttpsProto = 'https'
    private static readonly PairSeparator = ';'
    private static readonly NameValueSeparator = '='
    private static readonly TenantTokenSeparator = '.'
    private static readonly TokenPattern = /^[A-Za-z0-9_-]+$/
    private static readonly CookieAttributes = '; Path=/; HttpOnly; SameSite=Strict'
    private static readonly SecureAttribute = '; Secure'
    private static readonly MaxAgeAttribute = '; Max-Age='
    private static readonly MillisPerSecond = 1000

    private readonly allowedOrigins: ReadonlySet<string>
    private readonly trustForwardedProto: boolean

    public constructor(allowedOrigins: readonly string[] = [], trustForwardedProto = false)
    {
        this.allowedOrigins = new Set(allowedOrigins)
        this.trustForwardedProto = trustForwardedProto
    }

    public BuildSetCookie(req: IncomingMessage | undefined, tenantId: string, token: string, expiresAt: Date, now: Date = new Date()): string
    {
        const seconds = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / BrowserSessionAuth.MillisPerSecond))
        const value = encodeURIComponent(tenantId) + BrowserSessionAuth.TenantTokenSeparator + token
        return BrowserSessionAuth.CookieName + BrowserSessionAuth.NameValueSeparator + value + BrowserSessionAuth.CookieAttributes
            + BrowserSessionAuth.MaxAgeAttribute + seconds + (this.IsSecure(req) ? BrowserSessionAuth.SecureAttribute : '')
    }

    public BuildClearCookie(req: IncomingMessage | undefined): string
    {
        return BrowserSessionAuth.CookieName + BrowserSessionAuth.NameValueSeparator + BrowserSessionAuth.CookieAttributes
            + BrowserSessionAuth.MaxAgeAttribute + '0' + (this.IsSecure(req) ? BrowserSessionAuth.SecureAttribute : '')
    }

    /** Cookie-session endpoints answer an unidentified caller with 401 rather than the generic no-tenant 404. */
    public static IsSessionPath(path: string): boolean
    {
        return path === BrowserSessionAuth.SessionPath || path === BrowserSessionAuth.LogoutPath
    }

    /** The tenant named by the session cookie, or null. Unauthenticated: a routing hint only (the token still has to validate). */
    public CookieTenant(headers: IncomingHttpHeaders): string | null
    {
        return this.Parse(headers)?.Tenant ?? null
    }

    /** The cookie credential if the request carries a well-formed cookie and its Origin is acceptable; otherwise null (deny).
     *  requireOrigin = true (WebSocket upgrade, state-changing requests): a missing Origin is denied. */
    public Credential(headers: IncomingHttpHeaders, requireOrigin: boolean): BrowserCredential | null
    {
        const credential = this.Parse(headers)
        if (credential === null || !this.OriginAllowed(headers, requireOrigin))
        {
            return null
        }
        return credential
    }

    public OriginAllowed(headers: IncomingHttpHeaders, requireOrigin: boolean): boolean
    {
        const origin = headers[BrowserSessionAuth.OriginHeader]
        if (origin === undefined)
        {
            return !requireOrigin
        }
        if (typeof origin !== 'string')
        {
            return false
        }
        if (this.allowedOrigins.has(origin))
        {
            return true
        }
        const host = headers[BrowserSessionAuth.HostHeader]
        try
        {
            return typeof host === 'string' && host.length > 0 && new URL(origin).host === host
        }
        catch
        {
            return false
        }
    }

    private Parse(headers: IncomingHttpHeaders): BrowserCredential | null
    {
        const header = headers[BrowserSessionAuth.CookieHeader]
        if (typeof header !== 'string')
        {
            return null
        }
        let value: string | null = null
        for (const pair of header.split(BrowserSessionAuth.PairSeparator))
        {
            const index = pair.indexOf(BrowserSessionAuth.NameValueSeparator)
            if (index < 0 || pair.slice(0, index).trim() !== BrowserSessionAuth.CookieName)
            {
                continue
            }
            if (value !== null)
            {
                return null
            }
            value = pair.slice(index + 1).trim()
        }
        if (value === null)
        {
            return null
        }
        const split = value.lastIndexOf(BrowserSessionAuth.TenantTokenSeparator)
        if (split <= 0)
        {
            return null
        }
        const token = value.slice(split + 1)
        if (!BrowserSessionAuth.TokenPattern.test(token))
        {
            return null
        }
        try
        {
            const tenant = decodeURIComponent(value.slice(0, split))
            return tenant.length > 0 ? { Tenant: tenant, Token: token } : null
        }
        catch
        {
            return null
        }
    }

    private IsSecure(req: IncomingMessage | undefined): boolean
    {
        if (req === undefined)
        {
            return false
        }
        if ((req.socket as TLSSocket | undefined)?.encrypted === true && !this.trustForwardedProto)
        {
            return true
        }
        const proto = req.headers[BrowserSessionAuth.ForwardedProtoHeader]
        return this.trustForwardedProto && proto === BrowserSessionAuth.HttpsProto
    }
}
