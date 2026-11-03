import type { IOwnerSessionRevoker } from '../tenant-provisioning-service.js'
import type { TenantSession, TenantSessionStore } from './tenant-session.js'

/** Something holding live connections per tenant principal (the tenant plane's WebSocket registry). */
export interface IPrincipalConnections
{
    /**
     * Closes the principal's open connections in the tenant; returns how many. Connections opened under the session
     * `keepSessionId` (when given) stay open.
     */
    ClosePrincipal(tenantId: string, principalId: string, keepSessionId?: string): number

    /** Re-homes every connection opened under session `oldSessionId` to `newSessionId` (its session was rotated). */
    MoveSession(oldSessionId: string, newSessionId: string): void
}

/**
 * Ends a tenant principal's tenant-portal access after its password changed: every tenant-plane session of that
 * principal, and its open tenant-plane WebSocket connections (attached once the tenant listener exists). A self-service
 * change rotates the caller onto a fresh session and moves its connections there (RotateFor); a reset by someone else
 * keeps nothing (RevokeAllFor).
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
     * Ends every stored session of the principal (the caller's `oldSessionId` too) and issues the caller a fresh one; the
     * caller's open sockets move to the fresh session and every other socket of the principal closes. When the store
     * fails, every socket of the principal closes and the error is rethrown.
     */
    public async RotateFor(tenantId: string, principalId: string, oldSessionId: string, email?: string): Promise<TenantSession>
    {
        let fresh: TenantSession | undefined
        try
        {
            fresh = await this.sessions.RotateFor(tenantId, principalId, email)
            for (const connections of this.connections)
            {
                connections.MoveSession(oldSessionId, fresh.id)
            }
            return fresh
        }
        finally
        {
            this.CloseConnections(tenantId, principalId, fresh?.id)
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
