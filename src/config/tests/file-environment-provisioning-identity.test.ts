import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DelegationDepth, IdentityConfig, Role } from '@pragmatic-tech-ai/pragmatic-identity'
import { FileEnvironmentProvisioning } from '../file-environment-provisioning.js'

const Secret = 'super-secret-value'

class Fixture
{
    public static Environment(extra: Record<string, unknown>): string
    {
        return JSON.stringify({ environments: { acme: { displayName: 'Acme', ...extra } } })
    }
}

test('an identity block yields an IdentityConfig and a MachinePrincipalMap', () =>
{
    const json = Fixture.Environment({ identity: {
        pack: 'entra',
        delegationDepth: 'external-grants',
        providerSettings: { aadTenantId: 'T', clientId: 'C', redirectUri: 'R', secretRef: 'acme/oidc' },
        groupRoleMap: { admins: 'admin' },
        claimsMapping: { groups: 'roles' },
        machine: { 'aa:bb': { principalId: 'svc', groups: ['robots'] } },
    } })
    const environment = FileEnvironmentProvisioning.FromText(json).OptionsFor('acme')
    assert.ok(environment !== null)
    assert.ok(environment.identity instanceof IdentityConfig)
    assert.equal(environment.identity.PackId, 'entra')
    assert.equal(environment.identity.DelegationDepth, DelegationDepth.ExternalGrants)
    assert.equal(environment.identity.ProviderSettings.get('aadTenantId'), 'T')
    assert.equal(environment.identity.GroupRoleMap.get('admins'), Role.Admin)
    assert.equal(environment.identity.ClaimsMapping.get('groups'), 'roles')
    assert.equal(environment.machine?.Lookup('aabb')?.PrincipalId, 'svc')
    assert.deepEqual([...environment.machine?.Lookup('aabb')?.Groups ?? []], ['robots'])
})

test('a legacy flat oidc block with no identity synthesizes a generic-oidc IdentityConfig', () =>
{
    const oidc = { issuer: 'https://i', clientId: 'cid', clientSecretRef: 'acme/sec', discoveryUrl: 'https://i/.well-known', redirectUri: 'https://r', provider: 'generic' }
    const environment = FileEnvironmentProvisioning.FromText(Fixture.Environment({ oidc })).OptionsFor('acme')
    assert.ok(environment !== null)
    assert.equal(environment.identity?.PackId, 'generic-oidc')
    assert.equal(environment.identity?.DelegationDepth, DelegationDepth.AuthnDirectory)
    assert.equal(environment.identity?.ProviderSettings.get('issuer'), 'https://i')
    assert.equal(environment.identity?.ProviderSettings.get('clientId'), 'cid')
    assert.equal(environment.identity?.ProviderSettings.get('secretRef'), 'acme/sec')
    assert.equal(environment.identity?.ProviderSettings.get('discoveryUrl'), 'https://i/.well-known')
    assert.equal(environment.identity?.ProviderSettings.get('redirectUri'), 'https://r')
    assert.deepEqual(environment.oidc, oidc)
})

test('an explicit identity wins over a flat oidc block', () =>
{
    const oidc = { issuer: 'i', clientId: 'c', clientSecretRef: 's', discoveryUrl: 'd', redirectUri: 'r', provider: 'generic' }
    const environment = FileEnvironmentProvisioning.FromText(Fixture.Environment({ oidc, identity: { pack: 'entra' } })).OptionsFor('acme')
    assert.equal(environment?.identity?.PackId, 'entra')
})

test('an environment with neither leaves identity and machine unset', () =>
{
    const environment = FileEnvironmentProvisioning.FromText(Fixture.Environment({})).OptionsFor('acme')
    assert.equal(environment?.identity, undefined)
    assert.equal(environment?.machine, undefined)
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
        assert.throws(() => FileEnvironmentProvisioning.FromText(Fixture.Environment({ identity })), (error: Error) =>
            error.message.includes(field) && !error.message.includes(Secret))
    })
}

const MoreMalformed: [string, Record<string, unknown>, string][] = [
    ['null identity', { identity: null }, 'pack'],
    ['string identity', { identity: Secret }, 'pack'],
    ['non-string delegationDepth', { identity: { pack: 'p', delegationDepth: 7, providerSettings: { a: Secret } } }, 'delegationDepth'],
    ['non-string claimsMapping value', { identity: { pack: 'p', claimsMapping: { g: 5, s: Secret } } }, 'claimsMapping'],
    ['machine groups not strings', { identity: { pack: 'p', machine: { aa: { principalId: 'x', groups: [Secret, 5] } } } }, 'machine.groups'],
    ['machine groups not an array', { identity: { pack: 'p', machine: { aa: { principalId: 'x', groups: Secret } } } }, 'machine.groups'],
    ['non-record machine', { identity: { pack: 'p', machine: Secret } }, 'machine'],
    ['legacy oidc missing discoveryUrl', { oidc: { issuer: 'i', clientId: 'c', clientSecretRef: Secret, redirectUri: 'r', provider: 'generic' } }, 'oidc.discoveryUrl'],
    ['legacy oidc non-string clientId', { oidc: { issuer: 'i', clientId: 5, clientSecretRef: Secret, discoveryUrl: 'd', redirectUri: 'r', provider: 'generic' } }, 'oidc.clientId'],
]

for (const [name, extra, field] of MoreMalformed)
{
    test(`malformed environment (${name}) fails closed naming the field without leaking values`, () =>
    {
        assert.throws(() => FileEnvironmentProvisioning.FromText(Fixture.Environment(extra)), (error: Error) =>
            error.message.includes(field) && !error.message.includes('Secret') && !error.message.includes(Secret))
    })
}

test('a legacy-only tenant has the generic-oidc identity and no machine map', () =>
{
    const oidc = { issuer: 'i', clientId: 'c', clientSecretRef: 's', discoveryUrl: 'd', redirectUri: 'r', provider: 'generic' }
    const environment = FileEnvironmentProvisioning.FromText(Fixture.Environment({ oidc })).OptionsFor('acme')
    assert.equal(environment?.machine, undefined)
    assert.equal(environment?.identity?.PackId, 'generic-oidc')
})
