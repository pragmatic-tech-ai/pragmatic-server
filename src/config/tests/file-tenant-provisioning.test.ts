import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { FileTenantProvisioning } from '../file-tenant-provisioning.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'

class Files
{
    public static readonly Acme = JSON.stringify({
        tenants: {
            acme: {
                displayName: 'Acme Corp',
                bootstrap: { adminEmail: 'a@acme.test', adminPrincipalId: 'admin', adminPasswordRef: 'acme-admin-pw', ownerGrant: true },
                oidc: { issuer: 'i', clientId: 'c', clientSecretRef: 'acme-oidc', discoveryUrl: 'd', redirectUri: 'r', provider: 'p' },
                connectorsPolicy: { adapterAllowlist: ['sql'], catalogOnly: true, allowProviderOverride: false, providerAllowlist: [] },
            },
        },
    })
}

test('resolves a known tenant with display name, bootstrap and oidc', () =>
{
    const provisioning = FileTenantProvisioning.FromText(Files.Acme)
    const options = provisioning.OptionsFor('acme')
    assert.ok(options !== null)
    assert.equal(options.displayName, 'Acme Corp')
    assert.equal(options.bootstrap?.adminPasswordRef, 'acme-admin-pw')
    assert.equal(options.oidc?.clientSecretRef, 'acme-oidc')
})

test('reconstructs a ConnectorsPolicy with mapped DataSourceKind', () =>
{
    const provisioning = FileTenantProvisioning.FromText(Files.Acme)
    const options = provisioning.OptionsFor('acme')
    assert.ok(options?.connectorsPolicy !== undefined)
    assert.deepEqual([...options.connectorsPolicy.AdapterAllowlist], [DataSourceKind.Sql])
    assert.equal(options.connectorsPolicy.CatalogOnly, true)
})

test('returns null for an unknown tenant', () =>
{
    const provisioning = FileTenantProvisioning.FromText(Files.Acme)
    assert.equal(provisioning.OptionsFor('nobody'), null)
})

test('fails closed on malformed JSON', () =>
{
    assert.throws(() => FileTenantProvisioning.FromText('{ not json'), /tenants file/)
})

test('fails closed on an unknown adapter kind', () =>
{
    const text = JSON.stringify({ tenants: { t: { displayName: 't', connectorsPolicy: { adapterAllowlist: ['mongo'], catalogOnly: false, allowProviderOverride: false, providerAllowlist: [] } } } })
    assert.throws(() => FileTenantProvisioning.FromText(text), /adapter kind/)
})

test('a tenant without connectorsPolicy resolves with it undefined', () =>
{
    const text = JSON.stringify({ tenants: { t: { displayName: 'T' } } })
    const options = FileTenantProvisioning.FromText(text).OptionsFor('t')
    assert.equal(options?.connectorsPolicy, undefined)
})

test('fails closed when the file has no tenants object', () =>
{
    assert.throws(() => FileTenantProvisioning.FromText('{}'), /invalid shape/)
})

test('fails closed when adapterAllowlist is not an array', () =>
{
    const text = JSON.stringify({ tenants: { t: { displayName: 't', connectorsPolicy: { adapterAllowlist: 'sql', catalogOnly: false, allowProviderOverride: false, providerAllowlist: [] } } } })
    assert.throws(() => FileTenantProvisioning.FromText(text), /invalid shape/)
})

test('fails closed on an invalid tenant purpose', () =>
{
    const bad = JSON.stringify({ tenants: { acme: { displayName: 'Acme', purpose: 'nonsense' } } })
    assert.throws(() => FileTenantProvisioning.FromText(bad).OptionsFor('acme'), /invalid purpose/)
})

test('accepts a valid purpose and an absent purpose', () =>
{
    const ok = JSON.stringify({ tenants: { acme: { displayName: 'Acme', purpose: 1 }, beta: { displayName: 'Beta' } } })
    const provisioning = FileTenantProvisioning.FromText(ok)
    assert.equal(provisioning.OptionsFor('acme')?.purpose, 1)
    assert.equal(provisioning.OptionsFor('beta')?.purpose, undefined)
})

class PurposeFiles
{
    public static Of(purpose: unknown): string
    {
        return JSON.stringify({ tenants: { acme: { displayName: 'Acme', purpose } } })
    }
}

test('accepts the purpose enum name', () =>
{
    assert.equal(FileTenantProvisioning.FromText(PurposeFiles.Of('Development')).OptionsFor('acme')?.purpose, TenantPurpose.Development)
    assert.equal(FileTenantProvisioning.FromText(PurposeFiles.Of('Runtime')).OptionsFor('acme')?.purpose, TenantPurpose.Runtime)
})

test('still accepts the numeric purpose value', () =>
{
    assert.equal(FileTenantProvisioning.FromText(PurposeFiles.Of(0)).OptionsFor('acme')?.purpose, TenantPurpose.Development)
    assert.equal(FileTenantProvisioning.FromText(PurposeFiles.Of(1)).OptionsFor('acme')?.purpose, TenantPurpose.Runtime)
})

test('fails closed on an unknown purpose name, numeric string, out-of-range number, or non-primitive value', () =>
{
    for (const bad of ['Bogus', '0', 5, true, {}, null])
    {
        assert.throws(() => FileTenantProvisioning.FromText(PurposeFiles.Of(bad)).OptionsFor('acme'), /invalid purpose/)
    }
})
