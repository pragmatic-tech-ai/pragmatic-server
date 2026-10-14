import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Tenant, TenantKind, Role, ResourceKind, ResourceRef, IdentityConfig, DelegationDepth, AuditEventKind } from '@pragmatic-tech-ai/todl-identity'
import type { IAuditSink, AuditEvent, ITenantConfigStore, IRoleGrantStore, Grant } from '@pragmatic-tech-ai/todl-identity'
import { InMemoryRoleGrantStore } from '@pragmatic-tech-ai/todl-identity-local'
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
    public readonly Service: AdminService

    public constructor()
    {
        this.Service = new AdminService(this.Grants, this.Audit, this.Config, this.Tenant, async () => { this.Config.Calls.push('evict') })
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
    const failing = new AdminService(f.Grants, new FailingAuditSink(), f.Config, f.Tenant, async () => {})
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
    const failing = new AdminService(f.Grants, new FailingAuditSink(), f.Config, f.Tenant, async () => {})
    await assert.rejects(failing.RevokeRole('u1', 'u2', Role.Viewer, f.TenantRoot()), /audit down/)
    const config = new IdentityConfig('local', DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map())
    await assert.rejects(failing.SetConfig('u1', config), /audit down/)
})
