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

class RecordingSessions
{
    public readonly Calls: string[] = []

    public async RevokeOthersFor(tenantId: string, principalId: string, keepId: string): Promise<number>
    {
        this.Calls.push(tenantId + '/' + principalId + '/keep:' + keepId)
        return 1
    }
}

class KeepingConnections implements IPrincipalConnections
{
    public readonly Closed: string[] = []

    public ClosePrincipal(tenantId: string, principalId: string, keepSessionId?: string): number
    {
        this.Closed.push(tenantId + '/' + principalId + '/keep:' + String(keepSessionId))
        return 1
    }
}

describe('TenantPrincipalSessions.RevokeOthersFor', () =>
{
    it('ends the other stored sessions and closes the other sockets, keeping the named session on both', async () =>
    {
        const sessions = new RecordingSessions()
        const revoker = new TenantPrincipalSessions(sessions as unknown as TenantSessionStore)
        const connections = new KeepingConnections()
        revoker.Attach(connections)
        revoker.Attach(connections)
        await revoker.RevokeOthersFor('t1', 'owner', 'sess-1')
        assert.deepEqual(sessions.Calls, ['t1/owner/keep:sess-1'])
        assert.deepEqual(connections.Closed, ['t1/owner/keep:sess-1'], 'attached once, closed once')
    })
})
