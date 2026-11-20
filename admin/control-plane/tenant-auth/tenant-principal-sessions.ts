import type { SessionStore } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { IOwnerSessionRevoker } from '../tenant-provisioning-service.js'

/** Something holding live connections per tenant principal (the tenant plane's WebSocket registry, the desktop relay). */
export interface IPrincipalConnections
{
    /** Closes the principal's open connections in the tenant; returns how many. */
    ClosePrincipal(tenantId: string, principalId: string): number

    /** Closes every open connection of the tenant, any principal and any session kind (the tenant is gone); returns how many. */
    CloseTenant(tenantId: string): number
}

/**
 * Ends a tenant principal's access (an Owner reset by an operator): every session of that principal in the session store,
 * console and desktop, and its open tenant-plane sockets and desktop relays (attached once the tenant listener exists).
 * A tenant-wide end (the tenant deleted or its provisioning rolled back) closes the tenant's connections; its stored
 * sessions are refused by the gates from then on (TenantSessionRules: the tenant is gone, or re-created later).
 */
export class TenantPrincipalSessions implements IOwnerSessionRevoker
{
    private readonly connections: IPrincipalConnections[] = []

    public constructor(private readonly sessions: SessionStore)
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

    /** Ends the stored sessions; the open sockets are closed even when that fails (the store refuses them in process anyway, and its error is rethrown). */
    public async RevokeAllFor(tenantId: string, principalId: string): Promise<void>
    {
        try
        {
            await this.sessions.RevokeSubject(principalId)
        }
        finally
        {
            for (const connections of this.connections)
            {
                connections.ClosePrincipal(tenantId, principalId)
            }
        }
    }

    /** Closes every open socket and desktop relay of the tenant (its sessions are refused by the gates once it is gone). */
    public async RevokeTenant(tenantId: string): Promise<void>
    {
        for (const connections of this.connections)
        {
            connections.CloseTenant(tenantId)
        }
    }
}
