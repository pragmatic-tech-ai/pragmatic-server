import type { IncomingMessage } from 'node:http'
import type { TenantSession, TenantSessionStore } from './tenant-session.js'
import { TenantSessionCookie } from './tenant-session-cookie.js'

/**
 * The `/tenant-api/*` authentication gate. It reads the `pts_session` cookie, validates the carried token against
 * the session store, and returns the tenant principal — or null when the cookie is absent/malformed, the session
 * is unknown/expired/revoked, or the validated session's tenant does not match the cookie's tenant. The token is a
 * secret: it is never logged, echoed, or placed in an error.
 */
export class TenantAuthGate
{
    private static readonly CookieHeader = 'cookie'

    public constructor(private readonly sessions: TenantSessionStore)
    {
    }

    public async Principal(req: IncomingMessage): Promise<TenantSession | null>
    {
        const cookie = TenantSessionCookie.Read(req.headers[TenantAuthGate.CookieHeader])
        if (cookie === null)
        {
            return null
        }
        const session = await this.sessions.Validate(cookie.token)
        if (session === null || session.tenantId !== cookie.tenantId)
        {
            return null
        }
        return session
    }
}
