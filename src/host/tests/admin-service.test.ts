import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Tenant, TenantKind, Role, ResourceKind, ResourceRef, IdentityConfig, DelegationDepth, AuditEventKind, PresentedSecret, LocalAccountNotFoundError } from '@pragmatic-tech-ai/todl-identity'
import { Grant } from '@pragmatic-tech-ai/todl-identity'
import type { IAuditSink, AuditEvent, ITenantConfigStore, IRoleGrantStore } from '@pragmatic-tech-ai/todl-identity'
import { InMemoryRoleGrantStore, LocalAccountStore, ServiceTokenStore, LocalAccountRegistrar, EncryptedSecretStore, Argon2PasswordHasher } from '@pragmatic-tech-ai/todl-identity-local'
import { AdminService, AdminSelfLockoutError, AdminConfigMissingError } from '../admin-service.js'
import { AdminEnums, AdminEnumError } from '../admin-enums.js'

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
    public readonly Service: AdminService

    public constructor()
    {
        this.Service = this.ServiceFor(this.Tenant, this.Audit, async () => { this.Config.Calls.push('evict') })
    }

    public ServiceFor(tenant: Tenant, audit: IAuditSink, evict: () => Promise<void>): AdminService
    {
        return new AdminService(this.Grants, audit, this.Config, tenant, evict, this.Accounts, this.Registrar, this.Tokens)
    }

    public TenantRoot(): ResourceRef
    {
        return new ResourceRef(ResourceKind.Tenant, this.Tenant.Id, [])
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
    await f.Service.RevokeRole('u1', 'u2', Role.Owner, f.TenantRoot())
    assert.equal(f.Grants.Touched, 1)
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

test('RevokeToken on an unknown or other-tenant tokenRef has no effect on other tenants', async () =>
{
    const f = new AdminFixture()
    const other = f.ServiceFor(new Tenant('t2', TenantKind.SelfHosted, 'T2'), f.Audit, async () => {})
    const issued = await other.IssueToken('u1', 'p1', ['read'], null)
    // The store treats an unknown / foreign ref as an idempotent no-op (does not throw).
    await f.Service.RevokeToken('u1', 'missing')
    await f.Service.RevokeToken('u1', issued.Grant.TokenRef)
    assert.equal((await other.ListTokens())[0].Revoked, false)
})
