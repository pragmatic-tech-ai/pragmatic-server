import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { SessionClaims, SessionPolicy, SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import { TenantAdminCapabilities } from '../tenant-api/tenant-admin-capabilities.js'
import type { TenantRecord } from '../platform-records.js'
import { TenantRoleClaims, TenantRoles } from '../tenant-auth/tenant-roles.js'
import { TenantSessionClaims, type TenantSession } from '../tenant-auth/tenant-sessions.js'

class Fx
{
    public static Session(roles: readonly string[], appRoles: readonly string[]): TenantSession
    {
        return { id: 'sid', tenantId: 't1', principalId: 'p1', expiresAt: '2099-01-01T00:00:00Z', roles, appRoles }
    }

    public static Tenant(extra: Partial<TenantRecord>): TenantRecord
    {
        return { id: 't1', clientId: 'c1', displayName: 'T One', createdAt: '2026-01-01T00:00:00Z', ...extra }
    }

    /** A console session record of `principalId` (optionally with an email and realm-issued roles). */
    public static Record(principalId: string, email?: string, roles: readonly string[] = [], appRoles: readonly string[] = []): SessionRecord
    {
        const C = TenantSessionClaims
        const claims = SessionClaims.From({ [C.TenantClaim]: 't1', ...(email === undefined ? {} : { [C.EmailClaim]: email }), [C.RolesClaim]: roles, [C.AppRolesClaim]: appRoles })
        const at = new Date('2026-02-01T00:00:00Z')
        return new SessionRecord('sid', principalId, claims, at, new Date('2099-01-01T00:00:00Z'), at, new SessionPolicy(1000))
    }

    public static Roles(record: SessionRecord): { roles: readonly string[]; appRoles: readonly string[] }
    {
        return { roles: record.Claims.Values(TenantSessionClaims.RolesClaim), appRoles: record.Claims.Values(TenantSessionClaims.AppRolesClaim) }
    }
}

describe('TenantAdminCapabilities', () =>
{
    it('the tenant role admin holds every capability', () =>
    {
        assert.deepEqual(TenantAdminCapabilities.For(Fx.Session([TenantRoles.Admin], [])), {
            roleLabel: TenantAdminCapabilities.AdminRoleLabel, capabilities: { envs: true, adopt: true, access: true, settings: true },
        })
    })

    it('the application role environment-admin holds the environments and their rollout only', () =>
    {
        assert.deepEqual(TenantAdminCapabilities.For(Fx.Session([], [TenantRoles.EnvironmentAdmin])), {
            roleLabel: TenantAdminCapabilities.EnvironmentAdminRoleLabel, capabilities: { envs: true, adopt: true, access: false, settings: false },
        })
    })

    it('a session holding neither role holds no capability (deny by default)', () =>
    {
        assert.deepEqual(TenantAdminCapabilities.For(Fx.Session([], [])).capabilities, { envs: false, adopt: false, access: false, settings: false })
        assert.deepEqual(TenantAdminCapabilities.For({ id: 's', tenantId: 't1', principalId: 'p', expiresAt: '2099-01-01T00:00:00Z' }).capabilities,
            { envs: false, adopt: false, access: false, settings: false })
    })

    it('another application role or tenant role grants nothing here', () =>
    {
        assert.equal(TenantAdminCapabilities.For(Fx.Session(['finance'], ['viewer'])).roleLabel, TenantAdminCapabilities.NoRoleLabel)
    })
})

describe('TenantRoleClaims (the tenant-record bridge)', () =>
{
    it('the owner by principal id holds admin', () =>
    {
        const bridged = TenantRoleClaims.Bridged(Fx.Record('p1', 'x@y.z'), Fx.Tenant({ ownerPrincipalId: 'p1', ownerEmail: 'other@y.z' }))
        assert.deepEqual(Fx.Roles(bridged), { roles: [TenantRoles.Admin], appRoles: [] })
    })

    it('the owner by email (case-insensitive) when no owner principal is recorded', () =>
    {
        const bridged = TenantRoleClaims.Bridged(Fx.Record('p9', 'Owner@X.io'), Fx.Tenant({ ownerEmail: 'owner@x.io' }))
        assert.deepEqual(Fx.Roles(bridged).roles, [TenantRoles.Admin])
    })

    it('a principal mismatch is no owner even when the email matches', () =>
    {
        assert.equal(TenantRoleClaims.IsOwner('p2', 'o@x.io', Fx.Tenant({ ownerPrincipalId: 'p1', ownerEmail: 'o@x.io' })), false)
    })

    it('every other subject of the realm holds environment-admin', () =>
    {
        const bridged = TenantRoleClaims.Bridged(Fx.Record('p2'), Fx.Tenant({ ownerPrincipalId: 'p1' }))
        assert.deepEqual(Fx.Roles(bridged), { roles: [], appRoles: [TenantRoles.EnvironmentAdmin] })
    })

    it('fails open to owner when the tenant records no owner; an unknown tenant derives no role at all', () =>
    {
        assert.deepEqual(Fx.Roles(TenantRoleClaims.Bridged(Fx.Record('p2'), Fx.Tenant({}))).roles, [TenantRoles.Admin])
        assert.deepEqual(Fx.Roles(TenantRoleClaims.Bridged(Fx.Record('p2'), undefined)), Fx.Roles(Fx.Record('p2')))
    })

    it('keeps the roles the realm issued (a union, sorted and unique)', () =>
    {
        const bridged = TenantRoleClaims.Bridged(Fx.Record('p2', undefined, ['admin', 'auditor'], ['environment-admin', 'zeta']), Fx.Tenant({ ownerPrincipalId: 'p1' }))
        assert.deepEqual(Fx.Roles(bridged), { roles: ['admin', 'auditor'], appRoles: ['environment-admin', 'zeta'] })
    })

    it('keeps every other claim and the record itself', () =>
    {
        const record = Fx.Record('p2', 'a@b.c')
        const bridged = TenantRoleClaims.Bridged(record, Fx.Tenant({ ownerPrincipalId: 'p1' }))
        assert.equal(bridged.Id, record.Id)
        assert.equal(bridged.Subject, record.Subject)
        assert.equal(bridged.Claims.First(TenantSessionClaims.EmailClaim), 'a@b.c')
        assert.equal(bridged.Claims.First(TenantSessionClaims.TenantClaim), 't1')
    })
})
