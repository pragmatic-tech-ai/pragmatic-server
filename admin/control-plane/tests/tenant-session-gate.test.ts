import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { InMemorySessionRepository, SessionClaims, SessionStore, SignedInIdentity, type SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { TenantRecord } from '../platform-records.js'
import { DesktopAuthGate } from '../tenant-auth/desktop-auth-gate.js'
import { TenantPrincipalSessions, type IPrincipalConnections } from '../tenant-auth/tenant-principal-sessions.js'
import { TenantRoles } from '../tenant-auth/tenant-roles.js'
import { TenantSessionGate, TenantSessionRules, type IRequestTenant } from '../tenant-auth/tenant-session-gate.js'
import { TenantSessionClaims, TenantSessionKind, TenantSessions } from '../tenant-auth/tenant-sessions.js'

class GateFixture
{
    public static readonly Tenant = 'acme'
    public static readonly OtherTenant = 'beta'
    public static readonly AcmeHost = 'acme.admin.test'
    public static readonly BetaHost = 'beta.admin.test'
    public static readonly Owner = 'owner-1'
    public static readonly Member = 'member-1'
    public static readonly CreatedAt = '2026-01-01T00:00:00.000Z'

    public readonly Tenants = new Map<string, TenantRecord>([
        [GateFixture.Tenant, { id: GateFixture.Tenant, clientId: 'c', displayName: 'Acme', createdAt: GateFixture.CreatedAt, ownerPrincipalId: GateFixture.Owner }],
        [GateFixture.OtherTenant, { id: GateFixture.OtherTenant, clientId: 'c', displayName: 'Beta', createdAt: GateFixture.CreatedAt }],
    ])
    public readonly Directory = { GetTenant: (id: string): TenantRecord | undefined => this.Tenants.get(id) }
    public readonly Hosts: IRequestTenant = {
        TenantFor: (host: string | undefined): string | undefined => host === GateFixture.AcmeHost ? GateFixture.Tenant : host === GateFixture.BetaHost ? GateFixture.OtherTenant : undefined,
    }
    public now = new Date('2026-02-01T00:00:00.000Z')
    public readonly Sessions = new TenantSessions({ Sessions: new InMemorySessionRepository(), Tickets: undefined as never, Throttles: TenantSessions.InMemory().Throttles }, false, { Now: () => this.now })
    public readonly Gate = new TenantSessionGate(this.Sessions.Store, this.Sessions.Cookie, this.Hosts, this.Directory)

    public async Console(principal: string, tenant: string = GateFixture.Tenant): Promise<string>
    {
        return (await this.Sessions.Store.Issue(principal, TenantSessionClaims.Of(tenant, principal + '@acme.test'))).Token
    }

    public async Desktop(principal: string, tenant: string = GateFixture.Tenant): Promise<string>
    {
        return (await this.Sessions.IssueDesktop(new SignedInIdentity(principal, TenantSessionClaims.Of(tenant, undefined)))).Token
    }

    public Request(host: string, token?: string, bearer?: string): IncomingMessage
    {
        const headers: Record<string, string> = { host }
        if (token !== undefined)
        {
            headers.cookie = TenantSessions.CookieName + '=' + token
        }
        if (bearer !== undefined)
        {
            headers.authorization = 'Bearer ' + bearer
        }
        return { headers } as unknown as IncomingMessage
    }

    public static Roles(record: SessionRecord | null): { roles: readonly string[]; appRoles: readonly string[] } | undefined
    {
        return record === null ? undefined : { roles: record.Claims.Values(TenantSessionClaims.RolesClaim), appRoles: record.Claims.Values(TenantSessionClaims.AppRolesClaim) }
    }
}

class RecordingConnections implements IPrincipalConnections
{
    public readonly Principals: string[] = []
    public readonly Tenants: string[] = []

    public ClosePrincipal(tenantId: string, principalId: string): number
    {
        this.Principals.push(tenantId + '/' + principalId)
        return 1
    }

    public CloseTenant(tenantId: string): number
    {
        this.Tenants.push(tenantId)
        return 1
    }
}

describe('TenantSessions', () =>
{
    it('a console session is fixed 12 hours; a desktop session slides (7 days) and carries kind desktop', async () =>
    {
        const f = new GateFixture()
        const console = await f.Sessions.Store.Validate(await f.Console(GateFixture.Member))
        assert.equal(console?.ExpiresAt.getTime(), f.now.getTime() + TenantSessions.ConsoleTtlMs)
        assert.equal(TenantSessionClaims.KindOf(console!), TenantSessionKind.Console)
        const desktop = await f.Sessions.Store.Validate(await f.Desktop(GateFixture.Member))
        assert.equal(desktop?.ExpiresAt.getTime(), f.now.getTime() + TenantSessions.DesktopTtlMs)
        assert.equal(TenantSessionClaims.KindOf(desktop!), TenantSessionKind.Desktop)
        assert.equal(desktop?.Policy.Slides, true)
    })

    it('the view carries the id (digest), tenant, principal, email and roles, never the token', async () =>
    {
        const f = new GateFixture()
        const token = await f.Console(GateFixture.Member)
        const record = await f.Sessions.Store.Validate(token)
        const view = TenantSessionClaims.ViewOf(record!)
        assert.equal(view?.id, SessionStore.DigestOf(token))
        assert.equal(view?.tenantId, GateFixture.Tenant)
        assert.equal(view?.principalId, GateFixture.Member)
        assert.equal(view?.email, GateFixture.Member + '@acme.test')
        assert.equal(JSON.stringify(view).includes(token), false)
        assert.equal(TenantSessionClaims.ViewOf({ ...record!, Claims: SessionClaims.From({ email: 'x' }) } as SessionRecord), undefined)
    })
})

describe('TenantSessionGate', () =>
{
    it('admits a console session on its tenant\'s host, with the bridged roles', async () =>
    {
        const f = new GateFixture()
        const owner = await f.Gate.Current(f.Request(GateFixture.AcmeHost, await f.Console(GateFixture.Owner)))
        assert.deepEqual(GateFixture.Roles(owner), { roles: [TenantRoles.Admin], appRoles: [] })
        const member = await f.Gate.Current(f.Request(GateFixture.AcmeHost, await f.Console(GateFixture.Member)))
        assert.deepEqual(GateFixture.Roles(member), { roles: [], appRoles: [TenantRoles.EnvironmentAdmin] })
    })

    it('refuses the session on another tenant\'s host, an unknown host and without a cookie', async () =>
    {
        const f = new GateFixture()
        const token = await f.Console(GateFixture.Member)
        assert.equal(await f.Gate.Current(f.Request(GateFixture.BetaHost, token)), null)
        assert.equal(await f.Gate.Current(f.Request('evil.test', token)), null)
        assert.equal(await f.Gate.Current(f.Request(GateFixture.AcmeHost)), null)
    })

    it('never admits a desktop bearer session as a cookie, nor a session of another plane (no tenant claim)', async () =>
    {
        const f = new GateFixture()
        assert.equal(await f.Gate.Current(f.Request(GateFixture.AcmeHost, await f.Desktop(GateFixture.Member))), null)
        const operator = (await f.Sessions.Store.Issue('op-1', SessionClaims.From({ email: 'op@platform.test', app_roles: ['operator.full'] }))).Token
        assert.equal(await f.Gate.Current(f.Request(GateFixture.AcmeHost, operator)), null)
    })

    it('a deleted tenant\'s sessions, and a re-created tenant\'s earlier ones, are refused (tenant-wide end)', async () =>
    {
        const f = new GateFixture()
        const token = await f.Console(GateFixture.Member)
        f.Tenants.delete(GateFixture.Tenant)
        assert.equal(await f.Gate.Current(f.Request(GateFixture.AcmeHost, token)), null)
        f.Tenants.set(GateFixture.Tenant, { id: GateFixture.Tenant, clientId: 'c', displayName: 'Acme again', createdAt: '2026-03-01T00:00:00.000Z' })
        assert.equal(await f.Gate.Current(f.Request(GateFixture.AcmeHost, token)), null)
        f.now = new Date('2026-03-02T00:00:00.000Z')
        assert.ok(await f.Gate.Current(f.Request(GateFixture.AcmeHost, await f.Console(GateFixture.Member))) !== null)
    })

    it('an unreadable tenant creation time fails closed', () =>
    {
        const record = { IssuedAt: new Date('2026-02-01T00:00:00Z') } as SessionRecord
        assert.equal(TenantSessionRules.IsOfIncarnation(record, { id: 't', clientId: 'c', displayName: 'T', createdAt: 'not a time' }), false)
    })

    it('ById / IsLive re-check a session id against its tenant', async () =>
    {
        const f = new GateFixture()
        const token = await f.Console(GateFixture.Member)
        const id = SessionStore.DigestOf(token)
        assert.equal(await f.Gate.IsLive(id, GateFixture.Tenant), true)
        assert.equal(await f.Gate.IsLive(id, GateFixture.OtherTenant), false)
        await f.Sessions.Store.Revoke(token)
        assert.equal(await f.Gate.IsLive(id, GateFixture.Tenant), false)
    })
})

describe('DesktopAuthGate', () =>
{
    it('admits a desktop bearer and refuses a console token as bearer, a missing header and cookies', async () =>
    {
        const f = new GateFixture()
        const gate = new DesktopAuthGate(f.Sessions.Store, f.Directory)
        const desktop = await f.Desktop(GateFixture.Member)
        const session = await gate.Principal(f.Request(GateFixture.AcmeHost, undefined, desktop))
        assert.equal(session?.principalId, GateFixture.Member)
        assert.equal(session?.kind, TenantSessionKind.Desktop)
        assert.deepEqual(session?.appRoles, [TenantRoles.EnvironmentAdmin])
        assert.equal(await gate.Principal(f.Request(GateFixture.AcmeHost, undefined, await f.Console(GateFixture.Member))), null)
        assert.equal(await gate.Principal(f.Request(GateFixture.AcmeHost, desktop)), null)
        assert.equal(await gate.Principal(f.Request(GateFixture.AcmeHost)), null)
    })

    it('refuses the bearer of a deleted or re-created tenant', async () =>
    {
        const f = new GateFixture()
        const gate = new DesktopAuthGate(f.Sessions.Store, f.Directory)
        const desktop = await f.Desktop(GateFixture.Member)
        f.Tenants.set(GateFixture.Tenant, { id: GateFixture.Tenant, clientId: 'c', displayName: 'Acme again', createdAt: '2026-03-01T00:00:00.000Z' })
        assert.equal(await gate.Principal(f.Request(GateFixture.AcmeHost, undefined, desktop)), null)
    })
})

describe('TenantPrincipalSessions', () =>
{
    it('ends every session of the principal, console and desktop, and closes its connections', async () =>
    {
        const f = new GateFixture()
        const connections = new RecordingConnections()
        const principals = new TenantPrincipalSessions(f.Sessions.Store)
        principals.Attach(connections)
        principals.Attach(connections)
        const console = await f.Console(GateFixture.Member)
        const desktop = await f.Desktop(GateFixture.Member)
        const other = await f.Console(GateFixture.Owner)
        await principals.RevokeAllFor(GateFixture.Tenant, GateFixture.Member)
        assert.equal(await f.Sessions.Store.Validate(console), null)
        assert.equal(await f.Sessions.Store.Validate(desktop), null)
        assert.ok(await f.Sessions.Store.Validate(other) !== null)
        assert.deepEqual(connections.Principals, [GateFixture.Tenant + '/' + GateFixture.Member])
    })

    it('closes the connections even when ending the stored sessions fails, then reports the failure', async () =>
    {
        const connections = new RecordingConnections()
        const failing = { RevokeSubject: async (): Promise<number> => { throw new Error('write failed') } } as unknown as SessionStore
        const principals = new TenantPrincipalSessions(failing)
        principals.Attach(connections)
        await assert.rejects(principals.RevokeAllFor(GateFixture.Tenant, GateFixture.Member), /write failed/)
        assert.deepEqual(connections.Principals, [GateFixture.Tenant + '/' + GateFixture.Member])
    })

    it('a tenant-wide end closes the tenant\'s connections (its sessions are refused by the gates)', async () =>
    {
        const f = new GateFixture()
        const connections = new RecordingConnections()
        const principals = new TenantPrincipalSessions(f.Sessions.Store)
        principals.Attach(connections)
        await principals.RevokeTenant(GateFixture.Tenant)
        assert.deepEqual(connections.Tenants, [GateFixture.Tenant])
    })
})
