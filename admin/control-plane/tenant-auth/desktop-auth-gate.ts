import type { IncomingMessage } from 'node:http'
import type { TenantRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantSessionKind } from './tenant-session.js'
import type { TenantSession, TenantSessionStore } from './tenant-session.js'

/**
 * The desktop authentication gate. It reads only `Authorization: Bearer <token>` (cookies are ignored, so a console
 * cookie can never act as a desktop credential) and returns the session only when it is a Desktop-kind session that
 * is still valid. Given the tenant records, it also refuses a session whose tenant no longer exists or was re-created
 * after the session was issued (a deleted tenant's bearer never reaches a later tenant of the same id, even when the
 * revocation's write was lost). The token is a secret: it is never logged, echoed, or placed in an error.
 */
export class DesktopAuthGate
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPattern = /^Bearer ([^\s]+)$/i

    public constructor(
        private readonly sessions: TenantSessionStore,
        private readonly tenants?: Pick<ITenantDirectory, 'GetTenant'>)
    {
    }

    public async Principal(req: IncomingMessage): Promise<TenantSession | null>
    {
        const header = req.headers[DesktopAuthGate.AuthorizationHeader]
        const match = typeof header === 'string' ? DesktopAuthGate.BearerPattern.exec(header) : null
        if (match === null)
        {
            return null
        }
        const session = await this.sessions.Validate(match[1])
        if (session === null || session.kind !== TenantSessionKind.Desktop)
        {
            return null
        }
        if (this.tenants !== undefined && !DesktopAuthGate.IsOfIncarnation(session, this.tenants.GetTenant(session.tenantId)))
        {
            return null
        }
        return session
    }

    /**
     * Whether the session belongs to this tenant record: the record exists and was created no later than the session was
     * issued (an unreadable creation time fails closed).
     */
    public static IsOfIncarnation(session: TenantSession, record: TenantRecord | undefined): boolean
    {
        if (record === undefined)
        {
            return false
        }
        const issuedMs = new Date(session.issuedAt ?? session.expiresAt).getTime()
        const createdMs = new Date(record.createdAt).getTime()
        return !Number.isNaN(createdMs) && issuedMs >= createdMs
    }
}
