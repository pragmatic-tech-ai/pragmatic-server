import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuditThrottle } from './audit-throttle.js'
import { PlaneHttp } from './plane-http.js'
import type { TenantAccountIndex } from './tenant-account-index.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'

/**
 * Public `POST /api/desktop/discover`: tells the desktop app which tenant(s) an email belongs to and where the tenant
 * plane is. Unauthenticated by design, so it is desktop-only (any Origin header is refused, which blocks browser-page
 * probing) and every non-browser request counts against a per-address throttle.
 */
export class DesktopDiscoveryEndpoint
{
    public static readonly Path = '/api/desktop/discover'
    /** The throttle shape this endpoint is built for: 10 requests per minute per address. */
    public static readonly MaxHitsPerWindow = 10
    public static readonly WindowMs = 60 * 1000

    private static readonly MaxEmailLength = 254
    private static readonly MaxBodyBytes = 4096
    private static readonly Utf8 = 'utf8'
    private static readonly RetryAfterHeader = 'retry-after'
    private static readonly MsPerSecond = 1000
    private static readonly StatusBadRequest = 400
    private static readonly StatusForbidden = 403
    private static readonly StatusNotFound = 404
    private static readonly StatusTooManyRequests = 429
    private static readonly StatusUnavailable = 503
    private static readonly ForbiddenBody = { error: 'forbidden' }
    private static readonly TooManyBody = { error: 'too-many-requests' }
    private static readonly InvalidEmailBody = { error: 'invalid-email' }
    private static readonly UnavailableBody = { error: 'unavailable' }
    private static readonly NoAccountBody = { error: 'no-account' }
    private static readonly EmailField = 'email'

    public constructor(
        private readonly index: TenantAccountIndex,
        private readonly directory: ITenantDirectory,
        private readonly tenantPlaneUrl: string | undefined,
        private readonly throttle: AuditThrottle)
    {
    }

    /** Builds the throttle this endpoint expects (10 hits per minute per address). */
    public static NewThrottle(now?: () => number): AuditThrottle
    {
        return new AuditThrottle({ maxHits: DesktopDiscoveryEndpoint.MaxHitsPerWindow, windowMs: DesktopDiscoveryEndpoint.WindowMs, lockoutMs: DesktopDiscoveryEndpoint.WindowMs, now })
    }

    public async Handle(req: IncomingMessage, res: ServerResponse, clientIp: string = req.socket.remoteAddress ?? ''): Promise<void>
    {
        if (req.headers[PlaneHttp.OriginHeader] !== undefined)
        {
            req.resume()
            PlaneHttp.WriteJson(res, DesktopDiscoveryEndpoint.StatusForbidden, DesktopDiscoveryEndpoint.ForbiddenBody)
            return
        }
        // The hit is counted first so the request that crosses the limit is itself refused (the 11th in a window).
        this.throttle.RecordHit(clientIp)
        const decision = this.throttle.CheckAllowed(clientIp)
        if (!decision.allowed)
        {
            req.resume()
            res.setHeader(DesktopDiscoveryEndpoint.RetryAfterHeader, String(Math.ceil(decision.retryAfterMs / DesktopDiscoveryEndpoint.MsPerSecond)))
            PlaneHttp.WriteJson(res, DesktopDiscoveryEndpoint.StatusTooManyRequests, DesktopDiscoveryEndpoint.TooManyBody)
            return
        }
        const email = await this.ReadEmail(req)
        if (email === undefined)
        {
            PlaneHttp.WriteJson(res, DesktopDiscoveryEndpoint.StatusBadRequest, DesktopDiscoveryEndpoint.InvalidEmailBody)
            return
        }
        if (this.tenantPlaneUrl === undefined)
        {
            PlaneHttp.WriteJson(res, DesktopDiscoveryEndpoint.StatusUnavailable, DesktopDiscoveryEndpoint.UnavailableBody)
            return
        }
        const tenants = this.index.TenantsFor(email)
            .map(id => this.directory.GetTenant(id))
            .filter(t => t !== undefined)
            .map(t => ({ id: t.id, displayName: t.displayName }))
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
        if (tenants.length === 0)
        {
            PlaneHttp.WriteJson(res, DesktopDiscoveryEndpoint.StatusNotFound, DesktopDiscoveryEndpoint.NoAccountBody)
            return
        }
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { tenants, tenantPlaneUrl: this.tenantPlaneUrl })
    }

    /** The body's email when it is a non-empty string of at most 254 characters; otherwise undefined. */
    private async ReadEmail(req: IncomingMessage): Promise<string | undefined>
    {
        const raw = await DesktopDiscoveryEndpoint.ReadBody(req)
        if (raw === undefined)
        {
            return undefined
        }
        let body: unknown
        try
        {
            body = JSON.parse(raw)
        }
        catch
        {
            return undefined
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body))
        {
            return undefined
        }
        const email = (body as Record<string, unknown>)[DesktopDiscoveryEndpoint.EmailField]
        if (typeof email !== 'string' || email.trim().length === 0 || email.length > DesktopDiscoveryEndpoint.MaxEmailLength)
        {
            return undefined
        }
        return email
    }

    /** The request body as text, or undefined when it exceeds the cap. */
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
                if (size > DesktopDiscoveryEndpoint.MaxBodyBytes)
                {
                    tooLarge = true
                    return
                }
                chunks.push(c)
            })
            req.on('end', () => resolveBody(tooLarge ? undefined : Buffer.concat(chunks).toString(DesktopDiscoveryEndpoint.Utf8)))
            req.on('error', reject)
        })
    }
}
