import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { AllowAllInstanceFilter } from '@pragmatic-tech-ai/todl-identity-engine'
import type { TenantReadAuthorization } from '../cypher/read-filter-source.js'
import { AllowAllFieldReadMask } from '../cypher/field-masked-graph-query.js'
import { ConnectorReadAuthorizations, ConnectorPrincipalDigest } from '../connector-read-authorization.js'

class Fx
{
    public static readonly Secret = 'tok-SECRET-123'

    public static Context(id: string, role: Role, groups: string[] = []): AccessContext
    {
        const principal = new Principal(id, 't1', PrincipalKind.User, new Map([['token', Fx.Secret]]), groups)
        const grants = [new Grant(id, role, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, new Tenant('t1', TenantKind.SelfHosted, 'Tenant One'), grants, new ResourceAuthorizationPolicy())
    }
}

test('From returns the filter and mask the authorization produces', async () =>
{
    const filter = new AllowAllInstanceFilter()
    const mask = AllowAllFieldReadMask.Instance
    const auth = { ReadFilterFor: async () => filter, FieldReadMaskFor: async () => mask } as unknown as TenantReadAuthorization
    const bundle = await ConnectorReadAuthorizations.From(auth, Fx.Context('p1', Role.Owner))
    assert.equal(bundle.Filter, filter)
    assert.equal(bundle.FieldMask, mask)
})

test('AllowAll keeps every view and masks no field', () =>
{
    const bundle = ConnectorReadAuthorizations.AllowAll()
    assert.equal(bundle.Filter.Keep({} as never), true)
    assert.equal(bundle.FieldMask.CanRead('shop.Customer', 'name'), true)
})

test('Digest is stable per principal+roles, differs otherwise, and carries no secret', () =>
{
    const a = ConnectorPrincipalDigest.Of(Fx.Context('p1', Role.Owner, ['g2', 'g1']))
    assert.equal(ConnectorPrincipalDigest.Of(Fx.Context('p1', Role.Owner, ['g1', 'g2'])), a)
    assert.notEqual(ConnectorPrincipalDigest.Of(Fx.Context('p2', Role.Owner, ['g1', 'g2'])), a)
    assert.notEqual(ConnectorPrincipalDigest.Of(Fx.Context('p1', Role.Viewer, ['g1', 'g2'])), a)
    assert.equal(a.includes(Fx.Secret), false)
})
