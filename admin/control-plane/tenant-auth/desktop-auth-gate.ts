import type { IncomingMessage } from 'node:http'
import { TenantSessionKind } from './tenant-session.js'
import type { TenantSession, TenantSessionStore } from './tenant-session.js'

/**
 * The desktop authentication gate. It reads only `Authorization: Bearer <token>` (cookies are ignored, so a console
 * cookie can never act as a desktop credential) and returns the session only when it is a Desktop-kind session that
 * is still valid. The token is a secret: it is never logged, echoed, or placed in an error.
 */
export class DesktopAuthGate
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPattern = /^Bearer ([^\s]+)$/i

    public constructor(private readonly sessions: TenantSessionStore)
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
        return session !== null && session.kind === TenantSessionKind.Desktop ? session : null
    }
}
