import type { IOwnerSessionRevoker } from '../tenant-provisioning-service.js'
import type { TenantSessionStore } from './tenant-session.js'

/** Something holding live connections per tenant principal (the tenant plane's WebSocket registry). */
export interface IPrincipalConnections
{
    /** Closes the principal's open connections in the tenant; returns how many. */
    ClosePrincipal(tenantId: string, principalId: string): number
}

/**
 * Ends a tenant principal's tenant-portal access after its password changed: every tenant-plane session of that
 * principal, and its open tenant-plane WebSocket connections (attached once the tenant listener exists).
 */
export class TenantPrincipalSessions implements IOwnerSessionRevoker
{
    private readonly connections: IPrincipalConnections[] = []

    public constructor(private readonly sessions: TenantSessionStore)
    {
    }

    /** Adds a connection registry whose principal connections are closed on revoke. */
    public Attach(connections: IPrincipalConnections): void
    {
        this.connections.push(connections)
    }

    /** Ends the stored sessions; the open sockets are closed even when that fails (its error is then rethrown). */
    public async RevokeAllFor(tenantId: string, principalId: string): Promise<void>
    {
        try
        {
            await this.sessions.RevokeAllFor(tenantId, principalId)
        }
        finally
        {
            for (const connections of this.connections)
            {
                connections.ClosePrincipal(tenantId, principalId)
            }
        }
    }
}
