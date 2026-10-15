import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, IdentityConfig, DelegationDepth, PrivilegeAction, AccessLevel, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { ITenantConfigStore, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { TenantReadAuthorization, AllowAllReadFilterSource } from '../read-filter-source.js'

class FakeStore implements ITenantConfigStore
{
    public gets = 0
    constructor(private readonly model: ISecurityModelConfig | undefined, private readonly returnNull = false) {}
    public async Get(): Promise<IdentityConfig | null>
    {
        this.gets++
        if (this.returnNull) return null
        return new IdentityConfig('local', DelegationDepth.FullAuthz, new Map(), new Map(), new Map(), this.model)
    }
    public async Save(): Promise<void> {}
    public async List(): Promise<readonly string[]> { return [] }
}

class ReadFilterFixture
{
    public static readonly Concept = 'Widget'
    public static readonly Widget = { Concept: ReadFilterFixture.Concept, Field: () => undefined }

    public static Context(principalId: string): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal(principalId, 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant(principalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static OrgModel(principalId: string): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: 'root', name: 'Root' }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId, homeBusinessUnit: 'root', teams: [] }] },
            ownershipRules: [{ concept: ReadFilterFixture.Concept, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: 'root' } }],
            roles: [{ id: 'reader', name: 'Reader', privileges: [{ action: PrivilegeAction.Read, concept: ReadFilterFixture.Concept, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId, roles: ['reader'] }], teamRoles: [] },
        }
    }
}

test('TenantReadAuthorization allows under a granting SecurityModel', async () =>
{
    const auth = new TenantReadAuthorization(new FakeStore(ReadFilterFixture.OrgModel('p1')))
    const filter = await auth.ReadFilterFor(ReadFilterFixture.Context('p1'))
    assert.equal(filter.Keep(ReadFilterFixture.Widget), true)
})

test('TenantReadAuthorization denies all when SecurityModel is absent', async () =>
{
    const auth = new TenantReadAuthorization(new FakeStore(undefined))
    const filter = await auth.ReadFilterFor(ReadFilterFixture.Context('p1'))
    assert.equal(filter.Keep(ReadFilterFixture.Widget), false)
})

test('TenantReadAuthorization denies all when Get returns null', async () =>
{
    const auth = new TenantReadAuthorization(new FakeStore(undefined, true))
    const filter = await auth.ReadFilterFor(ReadFilterFixture.Context('p1'))
    assert.equal(filter.Keep(ReadFilterFixture.Widget), false)
})

test('TenantReadAuthorization builds the evaluator once per tenant', async () =>
{
    const store = new FakeStore(ReadFilterFixture.OrgModel('p1'))
    const auth = new TenantReadAuthorization(store)
    await auth.ReadFilterFor(ReadFilterFixture.Context('p1'))
    await auth.ReadFilterFor(ReadFilterFixture.Context('p1'))
    assert.equal(store.gets, 1)
})

test('AllowAllReadFilterSource keeps everything', async () =>
{
    const filter = await AllowAllReadFilterSource.Instance.ReadFilterFor(ReadFilterFixture.Context('p1'))
    assert.equal(filter.Keep(ReadFilterFixture.Widget), true)
})
