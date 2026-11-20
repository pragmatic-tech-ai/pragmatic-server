import type { TenantRecord } from '../platform-records.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuthorizationOutcome, ClaimsAuthorizer, RequestContext, RouteTable, SessionClaims, SessionPolicy, SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import { TenantRoleClaims } from '../tenant-auth/tenant-roles.js'
import { TenantSessionClaims, TenantSessionKind, type TenantSession } from '../tenant-auth/tenant-sessions.js'

/** Tenant-plane sessions for tests: the record a view stands for, and the view with the roles the gate would give it. */
export class TenantTestSessions
{
    private static readonly Policy = new SessionPolicy(12 * 60 * 60 * 1000)
    private static readonly Epoch = '2026-01-01T00:00:00.000Z'

    /** The session record a view stands for; with `tenants`, its roles are what the gate's bridge derives from the tenant record. */
    public static Record(view: TenantSession, tenants?: Pick<ITenantDirectory, 'GetTenant'>): SessionRecord
    {
        const C = TenantSessionClaims
        let claims = C.Of(view.tenantId, view.email, view.kind ?? TenantSessionKind.Console)
        claims = claims.With(C.RolesClaim, [...view.roles ?? []]).With(C.AppRolesClaim, [...view.appRoles ?? []])
        const issued = new Date(view.issuedAt ?? TenantTestSessions.Epoch)
        const record = new SessionRecord(view.id, view.principalId, claims, issued, new Date(view.expiresAt), issued, TenantTestSessions.Policy)
        return tenants === undefined ? record : TenantRoleClaims.Bridged(record, tenants.GetTenant(view.tenantId))
    }

    /** The view with the roles the gate's bridge derives from the tenant record. */
    public static Bridged(view: TenantSession, tenants: Pick<ITenantDirectory, 'GetTenant'>): TenantSession
    {
        return { ...view, ...TenantTestSessions.RolesOf(TenantTestSessions.Record(view, tenants)) }
    }

    /** A record's role claims as view fields. */
    public static RolesOf(record: SessionRecord): { roles: readonly string[]; appRoles: readonly string[] }
    {
        return { roles: record.Claims.Values(TenantSessionClaims.RolesClaim), appRoles: record.Claims.Values(TenantSessionClaims.AppRolesClaim) }
    }

    /** The claims of a console session of `tenantId` (no roles). */
    public static Claims(tenantId: string, email?: string): SessionClaims
    {
        return TenantSessionClaims.Of(tenantId, email)
    }
}

/**
 * Runs one request through the tenant API's declared routes the way the host does after authentication: the route lookup
 * (404, or 405 for a known path under another method), the role check of ClaimsAuthorizer against the session (403), then
 * the handler with a RequestContext. Unit tests of the endpoint drive it with fake requests and a recorded response.
 */
export class TenantApiDispatch
{
    private static readonly DefaultMethod = 'GET'
    private static readonly Address = '127.0.0.1'
    private static readonly BodyLimit = 1024 * 1024
    private static readonly StatusForbidden = 403
    private static readonly StatusNotFound = 404
    private static readonly StatusMethodNotAllowed = 405
    private static readonly JsonType = 'application/json; charset=utf-8'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly AllowHeader = 'Allow'
    private static readonly ForbiddenBody = { error: 'Forbidden' }
    private static readonly NotFoundBody = { error: 'Not found' }
    private static readonly MethodNotAllowedBody = { error: 'Method not allowed' }

    /** A directory whose every tenant records no owner: the role bridge makes each session `admin` (pre-owner tracking). */
    public static readonly OwnerlessDirectory: Pick<ITenantDirectory, 'GetTenant'> = { GetTenant: (id: string) => ({ id }) as TenantRecord }

    /** Answers the request (always true, as the host always answers); `tenants` makes the session's roles the bridge's. */
    public static async Handle(endpoint: TenantApiEndpoint, req: IncomingMessage, res: ServerResponse, path: string, session: TenantSession, tenants?: Pick<ITenantDirectory, 'GetTenant'>): Promise<boolean>
    {
        const D = TenantApiDispatch
        const table = new RouteTable()
        endpoint.Register(table)
        const match = table.Match((req.method ?? D.DefaultMethod).toUpperCase(), path)
        if (match.Route === undefined)
        {
            if (match.AllowedMethods.length > 0)
            {
                D.Write(res, D.StatusMethodNotAllowed, D.MethodNotAllowedBody, { [D.AllowHeader]: match.AllowedMethods.join(', ') })
                return true
            }
            D.Write(res, D.StatusNotFound, D.NotFoundBody)
            return true
        }
        const record = TenantTestSessions.Record(session, tenants)
        if (new ClaimsAuthorizer().Authorize(match.Route.Definition, record) !== AuthorizationOutcome.Allowed)
        {
            D.Write(res, D.StatusForbidden, D.ForbiddenBody)
            return true
        }
        const query = new URLSearchParams(new URL(req.url ?? path, 'http://localhost').search)
        await match.Route.Definition.Handler(new RequestContext(req, res, path, match.Params, query, record, D.Address, match.Route.Definition.BodyLimit ?? D.BodyLimit))
        return true
    }

    private static Write(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void
    {
        res.writeHead(status, { ...extra, [TenantApiDispatch.ContentTypeHeader]: TenantApiDispatch.JsonType })
        res.end(JSON.stringify(body))
    }
}
