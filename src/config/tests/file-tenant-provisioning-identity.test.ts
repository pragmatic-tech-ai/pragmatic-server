import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DelegationDepth, IdentityConfig, Role } from '@pragmatic-tech-ai/todl-identity'
import { FileTenantProvisioning } from '../file-tenant-provisioning.js'

const Secret = 'super-secret-value'

class Fixture
{
    public static Tenant(extra: Record<string, unknown>): string
    {
        return JSON.stringify({ tenants: { acme: { displayName: 'Acme', ...extra } } })
    }
}

test('an identity block yields an IdentityConfig and a MachinePrincipalMap', () =>
{
    const json = Fixture.Tenant({ identity: {
        pack: 'entra',
        delegationDepth: 'external-grants',
        providerSettings: { aadTenantId: 'T', clientId: 'C', redirectUri: 'R', secretRef: 'acme/oidc' },
        groupRoleMap: { admins: 'admin' },
        claimsMapping: { groups: 'roles' },
        machine: { 'aa:bb': { principalId: 'svc', groups: ['robots'] } },
    } })
    const tenant = FileTenantProvisioning.FromText(json).OptionsFor('acme')
    assert.ok(tenant !== null)
    assert.ok(tenant.identity instanceof IdentityConfig)
    assert.equal(tenant.identity.PackId, 'entra')
    assert.equal(tenant.identity.DelegationDepth, DelegationDepth.ExternalGrants)
    assert.equal(tenant.identity.ProviderSettings.get('aadTenantId'), 'T')
    assert.equal(tenant.identity.GroupRoleMap.get('admins'), Role.Admin)
    assert.equal(tenant.identity.ClaimsMapping.get('groups'), 'roles')
    assert.equal(tenant.machine?.Lookup('aabb')?.PrincipalId, 'svc')
    assert.deepEqual([...tenant.machine?.Lookup('aabb')?.Groups ?? []], ['robots'])
})

test('a legacy flat oidc block with no identity synthesizes a generic-oidc IdentityConfig', () =>
{
    const oidc = { issuer: 'https://i', clientId: 'cid', clientSecretRef: 'acme/sec', discoveryUrl: 'https://i/.well-known', redirectUri: 'https://r', provider: 'generic' }
    const tenant = FileTenantProvisioning.FromText(Fixture.Tenant({ oidc })).OptionsFor('acme')
    assert.ok(tenant !== null)
    assert.equal(tenant.identity?.PackId, 'generic-oidc')
    assert.equal(tenant.identity?.DelegationDepth, DelegationDepth.AuthnDirectory)
    assert.equal(tenant.identity?.ProviderSettings.get('issuer'), 'https://i')
    assert.equal(tenant.identity?.ProviderSettings.get('clientId'), 'cid')
    assert.equal(tenant.identity?.ProviderSettings.get('secretRef'), 'acme/sec')
    assert.equal(tenant.identity?.ProviderSettings.get('discoveryUrl'), 'https://i/.well-known')
    assert.equal(tenant.identity?.ProviderSettings.get('redirectUri'), 'https://r')
    assert.deepEqual(tenant.oidc, oidc)
})

test('an explicit identity wins over a flat oidc block', () =>
{
    const oidc = { issuer: 'i', clientId: 'c', clientSecretRef: 's', discoveryUrl: 'd', redirectUri: 'r', provider: 'generic' }
    const tenant = FileTenantProvisioning.FromText(Fixture.Tenant({ oidc, identity: { pack: 'entra' } })).OptionsFor('acme')
    assert.equal(tenant?.identity?.PackId, 'entra')
})

test('a tenant with neither leaves identity and machine unset', () =>
{
    const tenant = FileTenantProvisioning.FromText(Fixture.Tenant({})).OptionsFor('acme')
    assert.equal(tenant?.identity, undefined)
    assert.equal(tenant?.machine, undefined)
})

const Malformed: [string, Record<string, unknown>, string][] = [
    ['missing pack', { providerSettings: { a: Secret } }, 'pack'],
    ['unknown delegationDepth', { pack: 'p', delegationDepth: 'bogus' }, 'delegationDepth'],
    ['non-string providerSetting', { pack: 'p', providerSettings: { clientId: 5, secretRef: Secret } }, 'providerSettings'],
    ['unknown role', { pack: 'p', groupRoleMap: { g: 'god' } }, 'groupRoleMap'],
    ['machine entry missing principalId', { pack: 'p', machine: { aa: { groups: [Secret] } } }, 'principalId'],
]

for (const [name, identity, field] of Malformed)
{
    test(`malformed identity (${name}) fails closed naming the field without leaking values`, () =>
    {
        assert.throws(() => FileTenantProvisioning.FromText(Fixture.Tenant({ identity })), (error: Error) =>
            error.message.includes(field) && !error.message.includes(Secret))
    })
}
