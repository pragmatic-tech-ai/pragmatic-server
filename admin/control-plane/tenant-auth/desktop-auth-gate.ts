import type { IncomingMessage } from 'node:http'
import type { SessionStore } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantSessionRules } from './tenant-session-gate.js'
import { TenantSessionClaims, TenantSessionKind, type TenantSession } from './tenant-sessions.js'

/**
 * The desktop authentication gate. It reads only `Authorization: Bearer <token>` (cookies are ignored, so a console
 * cookie can never act as a desktop credential) and returns the session only when it is a live desktop session
 * (TenantSessionRules: its tenant exists and was not re-created after the session was issued, so a deleted tenant's
 * bearer never reaches a later tenant of the same id; roles refreshed). The token is a secret: it is never logged,
 * echoed, or placed in an error.
 */
export class DesktopAuthGate
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPattern = /^Bearer ([^\s]+)$/i
    private readonly rules: TenantSessionRules

    public constructor(private readonly sessions: SessionStore, tenants: Pick<ITenantDirectory, 'GetTenant'>)
    {
        this.rules = new TenantSessionRules(tenants)
    }

    /** The bearer token the request carries, or null. */
    public static Token(req: IncomingMessage): string | null
    {
        const header = req.headers[DesktopAuthGate.AuthorizationHeader]
        const match = typeof header === 'string' ? DesktopAuthGate.BearerPattern.exec(header) : null
        return match === null ? null : match[1] as string
    }

    public async Principal(req: IncomingMessage): Promise<TenantSession | null>
    {
        const token = DesktopAuthGate.Token(req)
        if (token === null)
        {
            return null
        }
        const record = this.rules.Admit(await this.sessions.Validate(token), TenantSessionKind.Desktop)
        return record === null ? null : TenantSessionClaims.ViewOf(record) ?? null
    }
}
