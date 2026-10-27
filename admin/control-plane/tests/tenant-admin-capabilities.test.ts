import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { TenantAdminCapabilities } from '../tenant-api/tenant-admin-capabilities.js'
import type { TenantRecord } from '../platform-records.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

class Fx
{
    public static Session(principalId: string, email?: string): TenantSession
    {
        return { id: 'tok', tenantId: 't1', principalId, email, expiresAt: '2099-01-01T00:00:00Z' }
    }

    public static Tenant(extra: Partial<TenantRecord>): TenantRecord
    {
        return { id: 't1', clientId: 'c1', displayName: 'T One', createdAt: '2026-01-01T00:00:00Z', ...extra }
    }
}

describe('TenantAdminCapabilities', () =>
{
    const All = { envs: true, adopt: true, access: true, settings: true }

    it('owner by matching ownerPrincipalId', () =>
    {
        const r = TenantAdminCapabilities.For(Fx.Session('p1'), Fx.Tenant({ ownerPrincipalId: 'p1', ownerEmail: 'x@y.z' }))
        assert.deepEqual(r, { roleLabel: TenantAdminCapabilities.OwnerRoleLabel, capabilities: All })
    })

    it('owner by ownerEmail when no ownerPrincipalId', () =>
    {
        const r = TenantAdminCapabilities.For(Fx.Session('p9', 'o@x.io'), Fx.Tenant({ ownerEmail: 'o@x.io' }))
        assert.equal(r.roleLabel, TenantAdminCapabilities.OwnerRoleLabel)
        assert.deepEqual(r.capabilities, All)
    })

    it('principal mismatch is a non-owner even when the email matches', () =>
    {
        assert.equal(TenantAdminCapabilities.IsOwner(Fx.Session('p2', 'o@x.io'), Fx.Tenant({ ownerPrincipalId: 'p1', ownerEmail: 'o@x.io' })), false)
    })

    it('non-owner is an environment admin', () =>
    {
        const r = TenantAdminCapabilities.For(Fx.Session('p2'), Fx.Tenant({ ownerPrincipalId: 'p1' }))
        assert.deepEqual(r, { roleLabel: TenantAdminCapabilities.AdminRoleLabel, capabilities: { envs: true, adopt: true, access: false, settings: false } })
    })

    it('fails open to owner when the tenant records no owner', () =>
    {
        assert.equal(TenantAdminCapabilities.For(Fx.Session('p2'), Fx.Tenant({})).roleLabel, TenantAdminCapabilities.OwnerRoleLabel)
    })

    it('fails open to owner when the tenant is unknown', () =>
    {
        assert.deepEqual(TenantAdminCapabilities.For(Fx.Session('p2'), undefined).capabilities, All)
    })
})
