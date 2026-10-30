import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Tenant, TenantKind, Role, ResourceKind, ResourceRef, IdentityConfig, DelegationDepth, AuditEventKind, PresentedSecret, LocalAccountNotFoundError } from '@pragmatic-tech-ai/todl-identity'
import { Grant } from '@pragmatic-tech-ai/todl-identity'
import type { ISessionManager } from '@pragmatic-tech-ai/todl-identity'
import type { IAuditSink, AuditEvent, ITenantConfigStore, IRoleGrantStore, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { InMemoryRoleGrantStore, LocalAccountStore, ServiceTokenStore, LocalAccountRegistrar, EncryptedSecretStore, Argon2PasswordHasher } from '@pragmatic-tech-ai/todl-identity-local'
import { AdminService, AdminTokenNotFoundError, AdminSelfLockoutError, LastAdministratorError, AdminConfigMissingError, ForeignTenantResourceError } from '../admin-service.js'
import type { ISecurityModelReload } from '../cypher/read-filter-source.js'
import { AdminEnums, AdminEnumError } from '../admin-enums.js'
import type { IAdapterPackAdmin } from '../adapter-pack-admin.js'
import type { IPrincipalInvalidator } from '../principal-connection-registry.js'

class RecordingAuditSink implements IAuditSink
{
    public readonly Events: AuditEvent[] = []

    public async Record(event: AuditEvent): Promise<void>
    {
        this.Events.push(event)
    }
}

class FailingAuditSink implements IAuditSink
{
    public async Record(_event: AuditEvent): Promise<void>
    {
        throw new Error('audit down')
    }
}

class RecordingReload implements ISecurityModelReload
{
    public readonly Invalidated: string[] = []

    public Invalidate(tenantId: string): void
    {
        this.Invalidated.push(tenantId)
    }
}

class FakeConfigStore implements ITenantConfigStore
{
    public Stored: IdentityConfig | null = null
    public readonly Calls: string[] = []

    public async Get(_tenantId: string): Promise<IdentityConfig | null>
    {
        return this.Stored
    }

    public async Save(_tenantId: string, config: IdentityConfig): Promise<void>
    {
        this.Calls.push('save')
        this.Stored = config
    }

    public async List(): Promise<readonly string[]>
    {
        return []
    }
}

class SpyGrantStore implements IRoleGrantStore
{
    public Touched = 0
    public readonly Inner = new InMemoryRoleGrantStore()

    public GrantsFor(subject: string, tenant: Tenant): Promise<readonly Grant[]>
    {
        return this.Inner.GrantsFor(subject, tenant)
    }

    public GrantsOn(resource: ResourceRef): Promise<readonly Grant[]>
    {
        return this.Inner.GrantsOn(resource)
    }

    public Save(grant: Grant): Promise<void>
    {
        this.Touched++
        return this.Inner.Save(grant)
    }

    public Revoke(grant: Grant): Promise<void>
    {
        this.Touched++
        return this.Inner.Revoke(grant)
    }
}

class RecordingInvalidator implements IPrincipalInvalidator
{
    public readonly Calls: Array<[string, string]> = []

    public InvalidatePrincipal(tenantId: string, principalId: string): void
    {
        this.Calls.push([tenantId, principalId])
    }
}

class RecordingSessions implements ISessionManager
{
    public readonly Revoked: Array<[Tenant, string]> = []

    public Issue(): never
    {
        throw new Error('unused')
    }

    public Validate(): never
    {
        throw new Error('unused')
    }

    public Revoke(): never
    {
        throw new Error('unused')
    }

    public async RevokeAllFor(tenant: Tenant, principalId: string): Promise<void>
    {
        this.Revoked.push([tenant, principalId])
    }
}

class AdminFixture
{
    public static readonly Secret = 'super-secret-value'
    public readonly Tenant = new Tenant('t1', TenantKind.SelfHosted, 'T1')
    public readonly Grants = new SpyGrantStore()
    public readonly Audit = new RecordingAuditSink()
    public readonly Config = new FakeConfigStore()
    public readonly Accounts = new LocalAccountStore()
    public readonly Tokens = new ServiceTokenStore()
    public readonly Registrar = new LocalAccountRegistrar(this.Accounts, new EncryptedSecretStore(randomBytes(32)), new Argon2PasswordHasher(), new RecordingAuditSink())
    public readonly Invalidated: string[] = []
    public readonly Allowed: string[] = []
    public readonly Denied: string[] = []
    public readonly ScriptAllowlist: string[] = ['seed-pack']
    public readonly Packs: IAdapterPackAdmin = {
        Invalidate: async name => { this.Invalidated.push(name) },
        AllowScripts: async name => { this.Allowed.push(name) },
        DenyScripts: async name => { this.Denied.push(name) },
        ListScriptAllowlist: async () => this.ScriptAllowlist,
    }
    public readonly Reload = new RecordingReload()
    public readonly Service: AdminService

    public constructor()
    {
        this.Service = this.ServiceFor(this.Tenant, this.Audit, async () => { this.Config.Calls.push('evict') })
    }

    public WiredService(invalidator: IPrincipalInvalidator, sessions: ISessionManager): AdminService
    {
        return new AdminService(this.Grants, this.Audit, this.Config, this.Tenant, async () => undefined, this.Accounts, this.Registrar, this.Tokens, this.Packs, this.Reload, invalidator, sessions)
    }

    public ServiceFor(tenant: Tenant, audit: IAuditSink, evict: () => Promise<void>): AdminService
    {
        return new AdminService(this.Grants, audit, this.Config, tenant, evict, this.Accounts, this.Registrar, this.Tokens, this.Packs, this.Reload)
    }

    public TenantRoot(): ResourceRef
    {
        return new ResourceRef(ResourceKind.Tenant, this.Tenant.Id, [])
    }

    public async Seed(subject: string, role: Role, resource: ResourceRef = this.TenantRoot()): Promise<void>
    {
        await this.Grants.Inner.Save(new Grant(subject, role, resource))
    }

    public async RootGrantCount(): Promise<number>
    {
        return (await this.Grants.GrantsOn(this.TenantRoot())).length
    }
}

test('GrantRole saves and audits actor+action with no secret', async () =>
{
    const f = new AdminFixture()
    await f.Service.GrantRole('u1', 'u2', Role.Editor, f.TenantRoot())
    assert.equal((await f.Service.ListGrants('u2')).length, 1)
    assert.equal(f.Audit.Events.length, 1)
    const event = f.Audit.Events[0]
    assert.equal(event.Kind, AuditEventKind.AdminAction)
    assert.equal(event.PrincipalId, 'u2')
    assert.equal(event.Detail.get('actor'), 'u1')
    assert.equal(event.Detail.get('action'), 'grant-role')
    assert.equal(event.Detail.get('resourcePath'), '')
    assert.deepEqual([...event.Detail.keys()].sort(), ['action', 'actor', 'resourceKind', 'resourcePath', 'role'])
    assert.ok(![...event.Detail.values()].some(v => v.includes(AdminFixture.Secret)))
})

test('RevokeRole removes the grant and audits', async () =>
{
    const f = new AdminFixture()
    await f.Service.GrantRole('u1', 'u2', Role.Editor, f.TenantRoot())
    await f.Service.RevokeRole('u1', 'u2', Role.Editor, f.TenantRoot())
    assert.equal((await f.Service.ListGrants('u2')).length, 0)
    assert.equal(f.Audit.Events[1].Detail.get('action'), 'revoke-role')
})

test('self-lockout rejects before touching the store', async () =>
{
    const f = new AdminFixture()
    await assert.rejects(f.Service.RevokeRole('u1', 'u1', Role.Owner, f.TenantRoot()), AdminSelfLockoutError)
    assert.equal(f.Grants.Touched, 0)
    assert.equal(f.Audit.Events.length, 0)
})

test('revoking another subject Owner is allowed', async () =>
{
    const f = new AdminFixture()
    await f.Seed('u2', Role.Owner)
    await f.Seed('u3', Role.Owner)
    await f.Service.RevokeRole('u1', 'u2', Role.Owner, f.TenantRoot())
    assert.equal(f.Grants.Touched, 1)
})

test('revoking the sole tenant-root Owner is rejected, grant kept, no audit', async () =>
{
    const f = new AdminFixture()
    await f.Seed('u2', Role.Owner)
    await assert.rejects(f.Service.RevokeRole('u1', 'u2', Role.Owner, f.TenantRoot()), LastAdministratorError)
    assert.equal(await f.RootGrantCount(), 1)
    assert.equal(f.Grants.Touched, 0)
    assert.equal(f.Audit.Events.length, 0)
})

test('revoking the sole tenant-root Admin is rejected', async () =>
{
    const f = new AdminFixture()
    await f.Seed('u2', Role.Admin)
    await assert.rejects(f.Service.RevokeRole('u1', 'u2', Role.Admin, f.TenantRoot()), LastAdministratorError)
    assert.equal(await f.RootGrantCount(), 1)
    assert.equal(f.Audit.Events.length, 0)
})

test('two Owners: first revoke succeeds and audits, second is rejected', async () =>
{
    const f = new AdminFixture()
    await f.Seed('u2', Role.Owner)
    await f.Seed('u3', Role.Owner)
    await f.Service.RevokeRole('u1', 'u2', Role.Owner, f.TenantRoot())
    assert.equal(f.Audit.Events.length, 1)
    await assert.rejects(f.Service.RevokeRole('u1', 'u3', Role.Owner, f.TenantRoot()), LastAdministratorError)
    assert.equal(await f.RootGrantCount(), 1)
    assert.equal(f.Audit.Events.length, 1)
})

test('duplicate sole-Owner grants: revoke is still rejected (exclusion drops every copy, matching Revoke)', async () =>
{
    const f = new AdminFixture()
    // append-no-dedup: the same (subject, role, resource) seeded twice produces two copies.
    await f.Seed('u2', Role.Owner)
    await f.Seed('u2', Role.Owner)
    assert.equal(await f.RootGrantCount(), 2)
    // Revoke deletes BOTH copies, so u2 would be left with no admin grant; the guard must reject,
    // not be fooled into counting the second copy as a surviving administrator.
    await assert.rejects(f.Service.RevokeRole('u1', 'u2', Role.Owner, f.TenantRoot()), LastAdministratorError)
    assert.equal(await f.RootGrantCount(), 2)
    assert.equal(f.Grants.Touched, 0)
    assert.equal(f.Audit.Events.length, 0)
})

test('Owner plus Admin: Owner revoke allowed, then Admin revoke rejected', async () =>
{
    const f = new AdminFixture()
    await f.Seed('u2', Role.Owner)
    await f.Seed('u3', Role.Admin)
    await f.Service.RevokeRole('u1', 'u2', Role.Owner, f.TenantRoot())
    await assert.rejects(f.Service.RevokeRole('u1', 'u3', Role.Admin, f.TenantRoot()), LastAdministratorError)
    assert.equal(await f.RootGrantCount(), 1)
})

test('tenant-root Viewer revoke is allowed (guard skipped) when an Owner exists', async () =>
{
    const f = new AdminFixture()
    await f.Seed('u2', Role.Owner)
    await f.Seed('u3', Role.Viewer)
    await f.Service.RevokeRole('u1', 'u3', Role.Viewer, f.TenantRoot())
    assert.equal(await f.RootGrantCount(), 1)
})

test('Project-scoped Owner revoke is allowed as the only such grant (guard skipped)', async () =>
{
    const f = new AdminFixture()
    const project = new ResourceRef(ResourceKind.Project, f.Tenant.Id, ['p1'])
    await f.Seed('u2', Role.Owner)
    await f.Seed('u3', Role.Owner, project)
    await f.Service.RevokeRole('u1', 'u3', Role.Owner, project)
    assert.equal((await f.Grants.GrantsOn(project)).length, 0)
    assert.equal(await f.RootGrantCount(), 1)
})

test('two tenants each with one Owner: revoking A sole Owner is rejected regardless of B', async () =>
{
    const f = new AdminFixture()
    await f.Seed('u2', Role.Owner)
    await f.Seed('ub', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't2', []))
    await assert.rejects(f.Service.RevokeRole('u1', 'u2', Role.Owner, f.TenantRoot()), LastAdministratorError)
    assert.equal(await f.RootGrantCount(), 1)
})

test('self-lockout takes precedence over last-administrator', async () =>
{
    const f = new AdminFixture()
    await f.Seed('u1', Role.Owner)
    await assert.rejects(f.Service.RevokeRole('u1', 'u1', Role.Owner, f.TenantRoot()), AdminSelfLockoutError)
})

test('ListGrants returns only the subject grants', async () =>
{
    const f = new AdminFixture()
    await f.Service.GrantRole('u1', 'u2', Role.Viewer, f.TenantRoot())
    await f.Service.GrantRole('u1', 'u3', Role.Admin, f.TenantRoot())
    const grants = await f.Service.ListGrants('u2')
    assert.equal(grants.length, 1)
    assert.equal(grants[0].Role, Role.Viewer)
})

test('ListGrants never returns the same subject grants from another tenant', async () =>
{
    const f = new AdminFixture()
    await f.Grants.Save(new Grant('u2', Role.Viewer, f.TenantRoot()))
    await f.Grants.Save(new Grant('u2', Role.Owner, new ResourceRef(ResourceKind.Tenant, 'other-tenant', [])))
    const grants = await f.Service.ListGrants('u2')
    assert.equal(grants.length, 1)
    assert.equal(grants[0]!.Resource.TenantId, 't1')
    assert.equal(grants[0]!.Role, Role.Viewer)
})

test('SetConfig then GetConfig round-trips and evicts', async () =>
{
    const f = new AdminFixture()
    const config = new IdentityConfig('local', DelegationDepth.FullAuthz, new Map([['k', 'v']]), new Map(), new Map())
    await f.Service.SetConfig('u1', config)
    assert.deepEqual(await f.Service.GetConfig(), config)
    assert.ok(f.Config.Calls.includes('evict'))
})

test('SetConfig audit failure throws before the tenant is evicted', async () =>
{
    const f = new AdminFixture()
    const failing = f.ServiceFor(f.Tenant, new FailingAuditSink(), async () => { f.Config.Calls.push('evict') })
    const config = new IdentityConfig('local', DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map())
    await assert.rejects(failing.SetConfig('u1', config), /audit down/)
    assert.deepEqual(f.Config.Calls, ['save'])
})

test('SetConfig saves then evicts and audits identifiers only', async () =>
{
    const f = new AdminFixture()
    const config = new IdentityConfig('local', DelegationDepth.FullAuthz, new Map([['clientSecretRef', AdminFixture.Secret]]), new Map(), new Map())
    await f.Service.SetConfig('u1', config)
    assert.deepEqual(f.Config.Calls, ['save', 'evict'])
    const detail = f.Audit.Events[0].Detail
    assert.deepEqual([...detail.keys()].sort(), ['action', 'actor', 'delegationDepth', 'packId'])
    assert.equal(detail.get('action'), 'set-config')
    assert.equal(detail.get('delegationDepth'), 'FullAuthz')
    assert.ok(![...detail.values()].some(v => v.includes(AdminFixture.Secret)))
})

test('GetConfig throws when the store returns null, returns config otherwise', async () =>
{
    const f = new AdminFixture()
    await assert.rejects(f.Service.GetConfig(), AdminConfigMissingError)
    const config = new IdentityConfig('local', DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map())
    f.Config.Stored = config
    assert.equal(await f.Service.GetConfig(), config)
})

test('a failing audit fails the mutation closed', async () =>
{
    const f = new AdminFixture()
    const failing = f.ServiceFor(f.Tenant, new FailingAuditSink(), async () => {})
    await assert.rejects(failing.GrantRole('u1', 'u2', Role.Viewer, f.TenantRoot()), /audit down/)
})

test('AdminEnums round-trips names and fails closed naming the field only', () =>
{
    assert.equal(AdminEnums.RoleFromName('Owner'), Role.Owner)
    assert.equal(AdminEnums.NameOfRole(Role.Viewer), 'Viewer')
    assert.equal(AdminEnums.ResourceKindFromName('Connector'), ResourceKind.Connector)
    assert.equal(AdminEnums.NameOfDepth(DelegationDepth.ExternalGrants), 'ExternalGrants')
    assert.throws(() => AdminEnums.RoleFromName('Root'), (e: unknown) => e instanceof AdminEnumError && e.message.includes('role') && !e.message.includes('Root'))
    assert.throws(() => AdminEnums.ResourceKindFromName('x'), (e: unknown) => e instanceof AdminEnumError && e.Field === 'resourceKind')
    assert.throws(() => AdminEnums.DepthFromName('x'), (e: unknown) => e instanceof AdminEnumError && e.Field === 'delegationDepth')
})

test('self-lockout guard is narrow: other combinations proceed', async () =>
{
    const f = new AdminFixture()
    const tenantRoot = f.TenantRoot()
    await f.Seed('keeper', Role.Owner)
    const cases: ReadonlyArray<readonly [string, Role, ResourceRef]> = [
        ['u1', Role.Admin, tenantRoot],
        ['u1', Role.Owner, new ResourceRef(ResourceKind.Project, 't1', [])],
        ['u1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', ['p'])],
        ['u2', Role.Owner, tenantRoot],
    ]
    for (const [subject, role, resource] of cases)
    {
        const before = f.Grants.Touched
        await f.Service.RevokeRole('u1', subject, role, resource)
        assert.equal(f.Grants.Touched, before + 1)
    }
})

test('grant audit detail carries the joined resource path', async () =>
{
    const f = new AdminFixture()
    await f.Service.GrantRole('u1', 'u2', Role.Viewer, new ResourceRef(ResourceKind.Project, 't1', ['a', 'b']))
    assert.equal(f.Audit.Events[0].Detail.get('resourcePath'), 'a/b')
})

test('failing audit fails RevokeRole and SetConfig closed', async () =>
{
    const f = new AdminFixture()
    const failing = f.ServiceFor(f.Tenant, new FailingAuditSink(), async () => {})
    await assert.rejects(failing.RevokeRole('u1', 'u2', Role.Viewer, f.TenantRoot()), /audit down/)
    const config = new IdentityConfig('local', DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map())
    await assert.rejects(failing.SetConfig('u1', config), /audit down/)
})

test('CreateAccount registers the account and audits actor+principalId+email, never the password', async () =>
{
    const f = new AdminFixture()
    const password = 'pw-plaintext-123'
    const account = await f.Service.CreateAccount('u1', 'a@x.io', 'p9', new PresentedSecret(password))
    assert.equal(account.PrincipalId, 'p9')
    assert.equal((await f.Service.ListAccounts()).length, 1)
    const event = f.Audit.Events[0]
    assert.equal(event.PrincipalId, 'p9')
    assert.equal(event.Detail.get('action'), 'create-account')
    assert.equal(event.Detail.get('actor'), 'u1')
    assert.equal(event.Detail.get('principalId'), 'p9')
    assert.equal(event.Detail.get('email'), 'a@x.io')
    assert.ok(![...event.Detail.values()].some(v => v.includes(password)))
})

test('DisableAccount disables and audits; unknown principal throws LocalAccountNotFoundError', async () =>
{
    const f = new AdminFixture()
    await f.Service.CreateAccount('u1', 'a@x.io', 'p9', new PresentedSecret('pw'))
    await f.Service.DisableAccount('u1', 'p9')
    assert.equal((await f.Service.ListAccounts())[0].Disabled, true)
    assert.equal(f.Audit.Events[1].Detail.get('action'), 'disable-account')
    assert.equal(f.Audit.Events[1].Detail.get('principalId'), 'p9')
    const before = f.Audit.Events.length
    await assert.rejects(f.Service.DisableAccount('u1', 'nobody'), LocalAccountNotFoundError)
    assert.equal(f.Audit.Events.length, before)
})

test('ListAccounts returns only this tenant accounts', async () =>
{
    const f = new AdminFixture()
    const other = new Tenant('t2', TenantKind.SelfHosted, 'T2')
    const otherService = f.ServiceFor(other, f.Audit, async () => {})
    await f.Service.CreateAccount('u1', 'a@x.io', 'p1', new PresentedSecret('pw'))
    await otherService.CreateAccount('u1', 'b@x.io', 'p2', new PresentedSecret('pw'))
    assert.deepEqual((await f.Service.ListAccounts()).map(a => a.PrincipalId), ['p1'])
    assert.deepEqual((await otherService.ListAccounts()).map(a => a.PrincipalId), ['p2'])
})

test('IssueToken returns the token once and audits tokenRef not the token value', async () =>
{
    const f = new AdminFixture()
    const issued = await f.Service.IssueToken('u1', 'p1', ['read', 'write'], null)
    assert.ok(issued.Token.length > 0)
    const event = f.Audit.Events[0]
    assert.equal(event.Detail.get('action'), 'issue-token')
    assert.equal(event.Detail.get('tokenRef'), issued.Grant.TokenRef)
    assert.equal(event.Detail.get('scopes'), 'read write')
    assert.ok(![...event.Detail.values()].some(v => v.includes(issued.Token)))
})

test('ListTokens surfaces the issued token then revoked=true after RevokeToken', async () =>
{
    const f = new AdminFixture()
    const issued = await f.Service.IssueToken('u1', 'p1', ['read'], null)
    const listed = await f.Service.ListTokens()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].TokenRef, issued.Grant.TokenRef)
    assert.equal(listed[0].Revoked, false)
    await f.Service.RevokeToken('u1', issued.Grant.TokenRef)
    assert.equal((await f.Service.ListTokens())[0].Revoked, true)
    const event = f.Audit.Events[1]
    assert.equal(event.Detail.get('action'), 'revoke-token')
    assert.equal(event.Detail.get('tokenRef'), issued.Grant.TokenRef)
})

test('RevokeToken on an unknown tokenRef rejects and records no audit event', async () =>
{
    const f = new AdminFixture()
    await assert.rejects(f.Service.RevokeToken('u1', 'missing'), AdminTokenNotFoundError)
    assert.equal(f.Audit.Events.length, 0)
})

test('RevokeToken on another tenant tokenRef rejects and leaves that token unrevoked', async () =>
{
    const f = new AdminFixture()
    const other = f.ServiceFor(new Tenant('t2', TenantKind.SelfHosted, 'T2'), f.Audit, async () => {})
    const issued = await other.IssueToken('u1', 'p1', ['read'], null)
    const before = f.Audit.Events.length
    await assert.rejects(f.Service.RevokeToken('u1', issued.Grant.TokenRef), AdminTokenNotFoundError)
    assert.equal(f.Audit.Events.length, before)
    assert.equal((await other.ListTokens())[0].Revoked, false)
})

test('a failing audit fails DisableAccount closed', async () =>
{
    const f = new AdminFixture()
    await f.Service.CreateAccount('u1', 'a@x.io', 'p9', new PresentedSecret('pw'))
    const failing = f.ServiceFor(f.Tenant, new FailingAuditSink(), async () => {})
    await assert.rejects(failing.DisableAccount('u1', 'p9'), /audit down/)
})

test('InvalidatePack invokes the callback then audits the pack name only', async () =>
{
    const f = new AdminFixture()
    await f.Service.InvalidatePack('actor-1', 'acme-pack')
    assert.deepEqual(f.Invalidated, ['acme-pack'])
    assert.equal(f.Audit.Events.length, 1)
    const event = f.Audit.Events[0]
    assert.equal(event.Kind, AuditEventKind.AdminAction)
    assert.equal(event.Detail.get('actor'), 'actor-1')
    assert.equal(event.Detail.get('action'), 'invalidate-pack')
    assert.equal(event.Detail.get('pack'), 'acme-pack')
})

test('a failing audit fails InvalidatePack closed after the invalidate ran', async () =>
{
    const f = new AdminFixture()
    const failing = f.ServiceFor(f.Tenant, new FailingAuditSink(), async () => {})
    await assert.rejects(failing.InvalidatePack('u1', 'acme-pack'), /audit down/)
})

test('AllowPackScripts records the allow then audits actor, action and pack only', async () =>
{
    const f = new AdminFixture()
    await f.Service.AllowPackScripts('actor-1', 'acme-pack')
    assert.deepEqual(f.Allowed, ['acme-pack'])
    assert.equal(f.Audit.Events.length, 1)
    const event = f.Audit.Events[0]
    assert.equal(event.Kind, AuditEventKind.AdminAction)
    assert.deepEqual([...event.Detail.entries()], [['actor', 'actor-1'], ['action', 'allow-pack-scripts'], ['pack', 'acme-pack']])
})

test('DenyPackScripts records the deny then audits actor, action and pack only', async () =>
{
    const f = new AdminFixture()
    await f.Service.DenyPackScripts('actor-1', 'acme-pack')
    assert.deepEqual(f.Denied, ['acme-pack'])
    assert.equal(f.Audit.Events.length, 1)
    const event = f.Audit.Events[0]
    assert.equal(event.Kind, AuditEventKind.AdminAction)
    assert.deepEqual([...event.Detail.entries()], [['actor', 'actor-1'], ['action', 'deny-pack-scripts'], ['pack', 'acme-pack']])
})

test('a failing audit fails AllowPackScripts and DenyPackScripts closed after the mutation ran', async () =>
{
    const f = new AdminFixture()
    const failing = f.ServiceFor(f.Tenant, new FailingAuditSink(), async () => {})
    await assert.rejects(failing.AllowPackScripts('u1', 'acme-pack'), /audit down/)
    await assert.rejects(failing.DenyPackScripts('u1', 'acme-pack'), /audit down/)
    assert.deepEqual(f.Allowed, ['acme-pack'])
    assert.deepEqual(f.Denied, ['acme-pack'])
})

test('ListScriptAllowlist returns the list and emits no audit event', async () =>
{
    const f = new AdminFixture()
    assert.deepEqual(await f.Service.ListScriptAllowlist(), ['seed-pack'])
    assert.equal(f.Audit.Events.length, 0)
})

test('SetSecurityModel rejects a malformed model directly: store unchanged, no reload, no audit', async () =>
{
    const f = new AdminFixture()
    f.Config.Stored = new IdentityConfig('local', DelegationDepth.AuthnDirectory, new Map([['k', 'v']]), new Map(), new Map())
    const bad = { businessUnits: [{ id: 'root', name: 'Root' }], teams: [{ id: 't', name: 'T', owningBusinessUnit: 'nope' }], membership: { claimsMapping: [], overrides: [] }, ownershipRules: [] } as unknown as ISecurityModelConfig
    await assert.rejects(f.Service.SetSecurityModel('actor-1', bad))
    assert.deepEqual(f.Config.Calls, [])
    assert.equal(f.Config.Stored?.SecurityModel, undefined)
    assert.deepEqual(f.Reload.Invalidated, [])
    assert.equal(f.Audit.Events.length, 0)
})

test('SetSecurityModel persists a valid model, preserves other fields and fires the reload directly', async () =>
{
    const f = new AdminFixture()
    f.Config.Stored = new IdentityConfig('local', DelegationDepth.AuthnDirectory, new Map([['k', 'v']]), new Map(), new Map())
    const model: ISecurityModelConfig = { businessUnits: [{ id: 'root', name: 'Root' }], teams: [], membership: { claimsMapping: [], overrides: [] }, ownershipRules: [] }
    await f.Service.SetSecurityModel('actor-1', model)
    assert.deepEqual(f.Config.Stored?.SecurityModel, model)
    assert.equal(f.Config.Stored?.PackId, 'local')
    assert.equal(f.Config.Stored?.ProviderSettings.get('k'), 'v')
    assert.deepEqual(f.Reload.Invalidated, ['t1'])
    assert.equal(f.Audit.Events.length, 1)
})

test('GrantRole with a foreign-tenant resource is rejected before any store or audit call', async () =>
{
    const f = new AdminFixture()
    const foreign = new ResourceRef(ResourceKind.Tenant, 'other-tenant', [])
    await assert.rejects(f.Service.GrantRole('u1', 'u2', Role.Editor, foreign), ForeignTenantResourceError)
    assert.equal(f.Grants.Touched, 0)
    assert.equal(f.Audit.Events.length, 0)
})

test('RevokeRole with a foreign-tenant resource is rejected before any store or audit call', async () =>
{
    const f = new AdminFixture()
    const foreign = new ResourceRef(ResourceKind.Tenant, 'other-tenant', [])
    await f.Seed('u2', Role.Editor, foreign)
    await assert.rejects(f.Service.RevokeRole('u1', 'u2', Role.Editor, foreign), ForeignTenantResourceError)
    assert.equal(f.Grants.Touched, 0)
    assert.equal(f.Audit.Events.length, 0)
    assert.equal((await f.Grants.GrantsOn(foreign)).length, 1)
})

class RacyGrantStore implements IRoleGrantStore
{
    public readonly Inner = new InMemoryRoleGrantStore()

    public async GrantsFor(subject: string, tenant: Tenant): Promise<readonly Grant[]>
    {
        await Promise.resolve()
        return this.Inner.GrantsFor(subject, tenant)
    }

    public async GrantsOn(resource: ResourceRef): Promise<readonly Grant[]>
    {
        await Promise.resolve()
        return this.Inner.GrantsOn(resource)
    }

    public async Save(grant: Grant): Promise<void>
    {
        await Promise.resolve()
        await this.Inner.Save(grant)
    }

    public async Revoke(grant: Grant): Promise<void>
    {
        await Promise.resolve()
        await this.Inner.Revoke(grant)
    }
}

test('concurrent revokes of the last two administrators: exactly one succeeds, one administrator remains', async () =>
{
    const f = new AdminFixture()
    const racy = new RacyGrantStore()
    const root = f.TenantRoot()
    await racy.Inner.Save(new Grant('u2', Role.Owner, root))
    await racy.Inner.Save(new Grant('u3', Role.Owner, root))
    const racing = new AdminService(racy, f.Audit, f.Config, f.Tenant, async () => undefined, f.Accounts, f.Registrar, f.Tokens, f.Packs, f.Reload)
    const results = await Promise.allSettled([
        racing.RevokeRole('u1', 'u2', Role.Owner, root),
        racing.RevokeRole('u1', 'u3', Role.Owner, root),
    ])
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0].reason instanceof LastAdministratorError)
    assert.equal((await racy.Inner.GrantsOn(root)).length, 1)
})

test('concurrent revokes via two AdminService instances on one tenant serialize: one succeeds, one administrator remains', async () =>
{
    const f = new AdminFixture()
    const racy = new RacyGrantStore()
    const root = f.TenantRoot()
    await racy.Inner.Save(new Grant('u2', Role.Owner, root))
    await racy.Inner.Save(new Grant('u3', Role.Owner, root))
    const first = new AdminService(racy, f.Audit, f.Config, f.Tenant, async () => undefined, f.Accounts, f.Registrar, f.Tokens, f.Packs, f.Reload)
    const second = new AdminService(racy, f.Audit, f.Config, f.Tenant, async () => undefined, f.Accounts, f.Registrar, f.Tokens, f.Packs, f.Reload)
    const results = await Promise.allSettled([
        first.RevokeRole('u1', 'u2', Role.Owner, root),
        second.RevokeRole('u1', 'u3', Role.Owner, root),
    ])
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0].reason instanceof LastAdministratorError)
    assert.equal((await racy.Inner.GrantsOn(root)).length, 1)
})

test('RevokeRole invalidates the subject live connections once', async () =>
{
    const f = new AdminFixture()
    const inv = new RecordingInvalidator()
    const svc = f.WiredService(inv, new RecordingSessions())
    await f.Seed('u1', Role.Owner)
    await f.Seed('u2', Role.Editor)
    await svc.RevokeRole('u1', 'u2', Role.Editor, f.TenantRoot())
    assert.deepEqual(inv.Calls, [[f.Tenant.Id, 'u2']])
})

test('RevokeToken invalidates the token principal live connections', async () =>
{
    const f = new AdminFixture()
    const inv = new RecordingInvalidator()
    const svc = f.WiredService(inv, new RecordingSessions())
    const issued = await svc.IssueToken('u1', 'bob', ['read'], null)
    assert.equal(inv.Calls.length, 0)
    await svc.RevokeToken('u1', issued.Grant.TokenRef)
    assert.deepEqual(inv.Calls, [[f.Tenant.Id, 'bob']])
})

test('DisableAccount revokes sessions and invalidates live connections', async () =>
{
    const f = new AdminFixture()
    const inv = new RecordingInvalidator()
    const sessions = new RecordingSessions()
    const svc = f.WiredService(inv, sessions)
    await svc.CreateAccount('u1', 'a@x.io', 'p9', new PresentedSecret('pw'))
    await svc.DisableAccount('u1', 'p9')
    assert.equal(sessions.Revoked.length, 1)
    assert.equal(sessions.Revoked[0][0].Id, f.Tenant.Id)
    assert.equal(sessions.Revoked[0][1], 'p9')
    assert.deepEqual(inv.Calls, [[f.Tenant.Id, 'p9']])
})

test('revokes without invalidator or sessions still complete', async () =>
{
    const f = new AdminFixture()
    await f.Seed('u1', Role.Owner)
    await f.Seed('u2', Role.Editor)
    await f.Service.RevokeRole('u1', 'u2', Role.Editor, f.TenantRoot())
    const issued = await f.Service.IssueToken('u1', 'bob', ['read'], null)
    await f.Service.RevokeToken('u1', issued.Grant.TokenRef)
    await f.Service.CreateAccount('u1', 'a@x.io', 'p9', new PresentedSecret('pw'))
    await f.Service.DisableAccount('u1', 'p9')
    assert.equal((await f.Service.ListAccounts())[0].Disabled, true)
})

test('a blocked revoke does not invalidate live connections', async () =>
{
    const f = new AdminFixture()
    const inv = new RecordingInvalidator()
    const svc = f.WiredService(inv, new RecordingSessions())
    await f.Seed('u1', Role.Owner)
    await assert.rejects(svc.RevokeRole('u1', 'u1', Role.Owner, f.TenantRoot()), AdminSelfLockoutError)
    assert.equal(inv.Calls.length, 0)
})
