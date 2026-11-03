import type { IOwnerSessionRevoker } from '../tenant-provisioning-service.js'
import type { TenantSessionStore } from './tenant-session.js'

/** Something holding live connections per tenant principal (the tenant plane's WebSocket registry). */
export interface IPrincipalConnections
{
    /**
     * Closes the principal's open connections in the tenant; returns how many. Connections opened under the session
     * `keepSessionId` (when given) stay open.
     */
    ClosePrincipal(tenantId: string, principalId: string, keepSessionId?: string): number
}

/**
 * Ends a tenant principal's tenant-portal access after its password changed: every tenant-plane session of that
 * principal, and its open tenant-plane WebSocket connections (attached once the tenant listener exists). A self-service
 * change keeps the session that made it (RevokeOthersFor); a reset by someone else keeps nothing (RevokeAllFor).
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
        if (!this.connections.includes(connections))
        {
            this.connections.push(connections)
        }
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
            this.CloseConnections(tenantId, principalId, undefined)
        }
    }

    /**
     * Ends every stored session of the principal except `keepSessionId`, and closes every open socket of the principal
     * except those of that session; the sockets are closed even when ending the sessions fails (its error is rethrown).
     */
    public async RevokeOthersFor(tenantId: string, principalId: string, keepSessionId: string): Promise<void>
    {
        try
        {
            await this.sessions.RevokeOthersFor(tenantId, principalId, keepSessionId)
        }
        finally
        {
            this.CloseConnections(tenantId, principalId, keepSessionId)
        }
    }

    private CloseConnections(tenantId: string, principalId: string, keepSessionId: string | undefined): void
    {
        for (const connections of this.connections)
        {
            connections.ClosePrincipal(tenantId, principalId, keepSessionId)
        }
    }
}
