import type { IncomingMessage } from 'node:http'
import { SessionGate, type SessionCookie, type SessionRecord, type SessionStore } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { TenantRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantRoleClaims } from './tenant-roles.js'
import { TenantSessionClaims, TenantSessionKind, type TenantSession } from './tenant-sessions.js'

/** Which tenant a request's host answers for (TenantHostResolver); undefined for a host that is not a known tenant's. */
export interface IRequestTenant
{
    TenantFor(hostHeader: string | undefined): string | undefined
}

/**
 * The rules every tenant-plane gate applies to a stored session: it belongs to a tenant that still exists and is the one
 * it was issued in (the record was created no later than the session: a deleted, or deleted and re-created, tenant's
 * sessions are refused, which is how a tenant-wide revocation reaches the store), and its role claims are refreshed
 * from the tenant record (TenantRoleClaims), so an owner change bites at once.
 */
export class TenantSessionRules
{
    public constructor(private readonly tenants: Pick<ITenantDirectory, 'GetTenant'>)
    {
    }

    /** The session with its roles refreshed, or null when it is not a live tenant-plane session of `kind`. */
    public Admit(record: SessionRecord | null, kind: TenantSessionKind): SessionRecord | null
    {
        if (record === null || TenantSessionClaims.KindOf(record) !== kind)
        {
            return null
        }
        const tenantId = TenantSessionClaims.TenantOf(record)
        const tenant = tenantId === undefined ? undefined : this.tenants.GetTenant(tenantId)
        if (tenant === undefined || !TenantSessionRules.IsOfIncarnation(record, tenant))
        {
            return null
        }
        return TenantRoleClaims.Bridged(record, tenant)
    }

    /** Whether the session was issued no earlier than the tenant record was created (an unreadable time fails closed). */
    public static IsOfIncarnation(record: SessionRecord, tenant: TenantRecord): boolean
    {
        const createdMs = new Date(tenant.createdAt).getTime()
        return !Number.isNaN(createdMs) && record.IssuedAt.getTime() >= createdMs
    }
}

/**
 * The authentication step of the tenant console: the `pts_session` cookie's session, admitted only when it is a console
 * session of the tenant the request's host answers for (TenantSessionRules: tenant alive and of the session's
 * incarnation, roles refreshed). A desktop bearer session never authenticates here; a session of another plane (the
 * platform operators', which carries no tenant) is refused. A mismatch reads as no session (the generic 401), so it is
 * not an oracle for a valid-but-wrong cookie.
 */
export class TenantSessionGate extends SessionGate
{
    private static readonly HostHeader = 'host'
    private readonly rules: TenantSessionRules

    public constructor(sessions: SessionStore, cookie: SessionCookie, private readonly hosts: IRequestTenant, tenants: Pick<ITenantDirectory, 'GetTenant'>)
    {
        super(sessions, cookie)
        this.rules = new TenantSessionRules(tenants)
    }

    public override async Current(req: IncomingMessage): Promise<SessionRecord | null>
    {
        const record = this.rules.Admit(await super.Current(req), TenantSessionKind.Console)
        if (record === null)
        {
            return null
        }
        const hostTenant = this.hosts.TenantFor(req.headers[TenantSessionGate.HostHeader] as string | undefined)
        return hostTenant !== undefined && TenantSessionClaims.TenantOf(record) === hostTenant ? record : null
    }

    /** The routes' view of the request's session, or null. */
    public async View(req: IncomingMessage): Promise<TenantSession | null>
    {
        const record = await this.Current(req)
        return record === null ? null : TenantSessionClaims.ViewOf(record) ?? null
    }

    /** A session id's live console session of `tenantId` (a socket's re-check, or a ticketed upgrade), roles refreshed; else null. */
    public async ById(sessionId: string, tenantId: string): Promise<SessionRecord | null>
    {
        const record = this.rules.Admit(await this.Sessions.ValidateId(sessionId), TenantSessionKind.Console)
        return record !== null && TenantSessionClaims.TenantOf(record) === tenantId ? record : null
    }

    /** Whether `sessionId` is still a live console session of `tenantId`. */
    public async IsLive(sessionId: string, tenantId: string): Promise<boolean>
    {
        return await this.ById(sessionId, tenantId) !== null
    }
}
