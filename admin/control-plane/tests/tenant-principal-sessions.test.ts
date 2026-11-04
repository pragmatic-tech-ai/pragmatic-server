import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TenantSession, TenantSessionStore } from '../tenant-auth/tenant-session.js'
import { TenantPrincipalSessions, type IPrincipalConnections } from '../tenant-auth/tenant-principal-sessions.js'

class FailingSessions
{
    public async RevokeAllFor(_tenantId: string, _principalId: string): Promise<number>
    {
        throw new Error('disk full')
    }

    public async RevokeTenant(_tenantId: string): Promise<number>
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

    public MoveSession(_oldSessionId: string, _newSessionId: string): void
    {
    }

    public CloseTenant(tenantId: string): number
    {
        this.Closed.push(tenantId + '/*')
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

    it('closes every socket and relay of the tenant even when ending its stored sessions fails, then reports the failure', async () =>
    {
        const revoker = new TenantPrincipalSessions(new FailingSessions() as unknown as TenantSessionStore)
        const connections = new RecordingConnections()
        revoker.Attach(connections)
        await assert.rejects(revoker.RevokeTenant('t1'), /disk full/)
        assert.deepEqual(connections.Closed, ['t1/*'])
    })
})

class RotatingSessions
{
    public readonly Calls: string[] = []

    public async RotateFor(tenantId: string, principalId: string, email?: string): Promise<TenantSession>
    {
        this.Calls.push(tenantId + '/' + principalId + '/' + String(email))
        return { id: 'fresh-1', tenantId, principalId, expiresAt: '2099-01-01T00:00:00.000Z' }
    }
}

class OrderedConnections implements IPrincipalConnections
{
    public readonly Log: string[] = []

    public ClosePrincipal(tenantId: string, principalId: string, keepSessionId?: string): number
    {
        this.Log.push('close ' + tenantId + '/' + principalId + ' keep:' + String(keepSessionId))
        return 1
    }

    public MoveSession(oldSessionId: string, newSessionId: string): void
    {
        this.Log.push('move ' + oldSessionId + '->' + newSessionId)
    }

    public CloseTenant(tenantId: string): number
    {
        this.Log.push('close tenant ' + tenantId)
        return 1
    }
}

describe('TenantPrincipalSessions.RotateFor', () =>
{
    it('rotates the stored sessions, moves the caller sockets to the fresh session, then closes every other socket', async () =>
    {
        const sessions = new RotatingSessions()
        const revoker = new TenantPrincipalSessions(sessions as unknown as TenantSessionStore)
        const connections = new OrderedConnections()
        revoker.Attach(connections)
        revoker.Attach(connections)
        const fresh = await revoker.RotateFor('t1', 'owner', 'old-1', 'o@t')
        assert.equal(fresh.id, 'fresh-1')
        assert.deepEqual(sessions.Calls, ['t1/owner/o@t'])
        assert.deepEqual(connections.Log, ['move old-1->fresh-1', 'close t1/owner keep:fresh-1'], 'attached once; moved before the close')
    })

    it('when the store fails nothing changed: no socket is moved or closed, and the failure is rethrown', async () =>
    {
        const revoker = new TenantPrincipalSessions({ RotateFor: async () => { throw new Error('disk full') } } as unknown as TenantSessionStore)
        const connections = new OrderedConnections()
        revoker.Attach(connections)
        await assert.rejects(revoker.RotateFor('t1', 'owner', 'old-1'), /disk full/)
        assert.deepEqual(connections.Log, [])
    })
})
