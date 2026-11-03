import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TenantSessionStore } from '../tenant-auth/tenant-session.js'
import { TenantPrincipalSessions, type IPrincipalConnections } from '../tenant-auth/tenant-principal-sessions.js'

class FailingSessions
{
    public async RevokeAllFor(_tenantId: string, _principalId: string): Promise<number>
    {
        throw new Error('disk full')
    }
}

class RecordingConnections implements IPrincipalConnections
{
    public readonly Closed: string[] = []

    public ClosePrincipal(tenantId: string, principalId: string): number
    {
        this.Closed.push(tenantId + '/' + principalId)
        return 1
    }
}

describe('TenantPrincipalSessions', () =>
{
    it('closes the principal\'s sockets even when ending the stored sessions fails, then reports the failure', async () =>
    {
        const revoker = new TenantPrincipalSessions(new FailingSessions() as unknown as TenantSessionStore)
        const connections = new RecordingConnections()
        revoker.Attach(connections)
        await assert.rejects(revoker.RevokeAllFor('t1', 'owner'), /disk full/)
        assert.deepEqual(connections.Closed, ['t1/owner'])
    })
})
