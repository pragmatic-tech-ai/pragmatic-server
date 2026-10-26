import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, IdentityConfig, DelegationDepth, PrivilegeAction, AccessLevel, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { ITenantConfigStore, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { TenantReadAuthorization, AllowAllReadFilterSource } from '../read-filter-source.js'

class FakeStore implements ITenantConfigStore
{
    private static readonly FailureMessage = 'store unavailable'

    public gets = 0
    constructor(public model: ISecurityModelConfig | undefined, private readonly returnNull = false, private readonly failFirst = false) {}
    public async Get(): Promise<IdentityConfig | null>
    {
        this.gets++
        if (this.failFirst && this.gets === 1)
        {
            throw new Error(FakeStore.FailureMessage)
        }
        if (this.returnNull) return null
        return new IdentityConfig('local', DelegationDepth.FullAuthz, new Map(), new Map(), new Map(), this.model)
    }
    public async Save(): Promise<void> {}
    public async List(): Promise<readonly string[]> { return [] }
}

class ReadFilterFixture
{
    public static readonly Concept = 'Widget'
    public static readonly PrincipalId = 'p1'
    public static readonly TenantId = 't1'
    public static readonly RootBusinessUnit = 'root'
    public static readonly ReaderRoleId = 'reader'
    public static readonly Widget = { Concept: ReadFilterFixture.Concept, Field: () => undefined }

    public static Context(principalId: string, tenantId: string = ReadFilterFixture.TenantId): AccessContext
    {
        const tenant = new Tenant(tenantId, TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal(principalId, tenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(principalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, tenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static OrgModel(principalId: string): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: ReadFilterFixture.RootBusinessUnit, name: 'Root' }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId, homeBusinessUnit: ReadFilterFixture.RootBusinessUnit, teams: [] }] },
            ownershipRules: [{ concept: ReadFilterFixture.Concept, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: ReadFilterFixture.RootBusinessUnit } }],
            roles: [{ id: ReadFilterFixture.ReaderRoleId, name: 'Reader', privileges: [{ action: PrivilegeAction.Read, concept: ReadFilterFixture.Concept, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId, roles: [ReadFilterFixture.ReaderRoleId] }], teamRoles: [] },
        }
    }
}

test('TenantReadAuthorization allows under a granting SecurityModel', async () =>
{
    const auth = new TenantReadAuthorization(new FakeStore(ReadFilterFixture.OrgModel(ReadFilterFixture.PrincipalId)))
    const filter = await auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId))
    assert.equal(filter.Keep(ReadFilterFixture.Widget), true)
})

test('TenantReadAuthorization denies all when SecurityModel is absent', async () =>
{
    const auth = new TenantReadAuthorization(new FakeStore(undefined))
    const filter = await auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId))
    assert.equal(filter.Keep(ReadFilterFixture.Widget), false)
})

test('TenantReadAuthorization denies all when Get returns null', async () =>
{
    const auth = new TenantReadAuthorization(new FakeStore(undefined, true))
    const filter = await auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId))
    assert.equal(filter.Keep(ReadFilterFixture.Widget), false)
})

test('TenantReadAuthorization builds the evaluator once per tenant', async () =>
{
    const store = new FakeStore(ReadFilterFixture.OrgModel(ReadFilterFixture.PrincipalId))
    const auth = new TenantReadAuthorization(store)
    await auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId))
    await auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId))
    assert.equal(store.gets, 1)
})

test('TenantReadAuthorization builds a separate evaluator per tenant', async () =>
{
    const store = new FakeStore(ReadFilterFixture.OrgModel(ReadFilterFixture.PrincipalId))
    const auth = new TenantReadAuthorization(store)
    await auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId))
    await auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId))
    await auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId, 't2'))
    assert.equal(store.gets, 2)
})

test('TenantReadAuthorization retries after a failed build', async () =>
{
    const store = new FakeStore(ReadFilterFixture.OrgModel(ReadFilterFixture.PrincipalId), false, true)
    const auth = new TenantReadAuthorization(store)
    await assert.rejects(auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId)))
    const filter = await auth.ReadFilterFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId))
    assert.equal(filter.Keep(ReadFilterFixture.Widget), true)
})

test('TenantReadAuthorization denies a principal with no role assignment', async () =>
{
    const auth = new TenantReadAuthorization(new FakeStore(ReadFilterFixture.OrgModel(ReadFilterFixture.PrincipalId)))
    const filter = await auth.ReadFilterFor(ReadFilterFixture.Context('p2'))
    assert.equal(filter.Keep(ReadFilterFixture.Widget), false)
})

test('AllowAllReadFilterSource keeps everything', async () =>
{
    const filter = await AllowAllReadFilterSource.Instance.ReadFilterFor()
    assert.equal(filter.Keep(ReadFilterFixture.Widget), true)
})

test('TenantReadAuthorization.GovernedConceptsFor returns the concepts the model governs', async () =>
{
    const auth = new TenantReadAuthorization(new FakeStore(ReadFilterFixture.OrgModel(ReadFilterFixture.PrincipalId)))
    const governed = await auth.GovernedConceptsFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId))
    assert.equal(governed.has(ReadFilterFixture.Concept), true)
})

test('TenantReadAuthorization.GovernedConceptsFor reuses the cached evaluator (no second store read)', async () =>
{
    const store = new FakeStore(ReadFilterFixture.OrgModel(ReadFilterFixture.PrincipalId))
    const auth = new TenantReadAuthorization(store)
    const context = ReadFilterFixture.Context(ReadFilterFixture.PrincipalId)
    await auth.ReadFilterFor(context)
    await auth.GovernedConceptsFor(context)
    assert.equal(store.gets, 1)
})

test('TenantReadAuthorization.GovernedConceptsFor reflects an updated model after Invalidate', async () =>
{
    const store = new FakeStore(undefined)
    const auth = new TenantReadAuthorization(store)
    const context = ReadFilterFixture.Context(ReadFilterFixture.PrincipalId)
    assert.equal((await auth.GovernedConceptsFor(context)).size, 0)
    store.model = ReadFilterFixture.OrgModel(ReadFilterFixture.PrincipalId)
    auth.Invalidate(ReadFilterFixture.TenantId)
    assert.equal((await auth.GovernedConceptsFor(context)).has(ReadFilterFixture.Concept), true)
})

test('AllowAllReadFilterSource.GovernedConceptsFor returns an empty set', async () =>
{
    const governed = await AllowAllReadFilterSource.Instance.GovernedConceptsFor()
    assert.equal(governed.size, 0)
})

test('TenantReadAuthorization.HasSecurityModelFor is false with no model (fail-closed) and true once one is set', async () =>
{
    const store = new FakeStore(undefined)
    const auth = new TenantReadAuthorization(store)
    const context = ReadFilterFixture.Context(ReadFilterFixture.PrincipalId)
    assert.equal(await auth.HasSecurityModelFor(context), false)
    store.model = ReadFilterFixture.OrgModel(ReadFilterFixture.PrincipalId)
    auth.Invalidate(ReadFilterFixture.TenantId)
    assert.equal(await auth.HasSecurityModelFor(context), true)
})

test('TenantReadAuthorization.HasSecurityModelFor is false when the tenant has no stored config', async () =>
{
    const auth = new TenantReadAuthorization(new FakeStore(undefined, true))
    assert.equal(await auth.HasSecurityModelFor(ReadFilterFixture.Context(ReadFilterFixture.PrincipalId)), false)
})

test('AllowAllReadFilterSource.HasSecurityModelFor is true (the depth axis is inactive)', async () =>
{
    assert.equal(await AllowAllReadFilterSource.Instance.HasSecurityModelFor(), true)
})
