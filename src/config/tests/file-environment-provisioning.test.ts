import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { FileEnvironmentProvisioning } from '../file-environment-provisioning.js'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'

class Files
{
    public static readonly Acme = JSON.stringify({
        environments: {
            acme: {
                displayName: 'Acme Corp',
                bootstrap: { adminEmail: 'a@acme.test', adminPrincipalId: 'admin', adminPasswordRef: 'acme-admin-pw', ownerGrant: true },
                oidc: { issuer: 'i', clientId: 'c', clientSecretRef: 'acme-oidc', discoveryUrl: 'd', redirectUri: 'r', provider: 'p' },
                connectorsPolicy: { adapterAllowlist: ['sql'], catalogOnly: true, allowProviderOverride: false, providerAllowlist: [] },
            },
        },
    })
}

test('resolves a known environment with display name, bootstrap and oidc', () =>
{
    const provisioning = FileEnvironmentProvisioning.FromText(Files.Acme)
    const options = provisioning.OptionsFor('acme')
    assert.ok(options !== null)
    assert.equal(options.displayName, 'Acme Corp')
    assert.equal(options.bootstrap?.adminPasswordRef, 'acme-admin-pw')
    assert.equal(options.oidc?.clientSecretRef, 'acme-oidc')
})

test('reconstructs a ConnectorsPolicy with mapped DataSourceKind', () =>
{
    const provisioning = FileEnvironmentProvisioning.FromText(Files.Acme)
    const options = provisioning.OptionsFor('acme')
    assert.ok(options?.connectorsPolicy !== undefined)
    assert.deepEqual([...options.connectorsPolicy.AdapterAllowlist], [DataSourceKind.Sql])
    assert.equal(options.connectorsPolicy.CatalogOnly, true)
})

test('returns null for an unknown environment', () =>
{
    const provisioning = FileEnvironmentProvisioning.FromText(Files.Acme)
    assert.equal(provisioning.OptionsFor('nobody'), null)
})

test('reads an environments.json with root key "environments"', () =>
{
    const text = JSON.stringify({ environments: { acme: { displayName: 'Acme' } } })
    assert.equal(FileEnvironmentProvisioning.FromText(text).OptionsFor('acme')?.displayName, 'Acme')
})

test('fails closed on a pre-rename file whose root key is "tenants"', () =>
{
    const text = JSON.stringify({ tenants: { acme: { displayName: 'Acme' } } })
    assert.throws(() => FileEnvironmentProvisioning.FromText(text), /environments file has an invalid shape/)
})

test('fails closed on malformed JSON', () =>
{
    assert.throws(() => FileEnvironmentProvisioning.FromText('{ not json'), /environments file/)
})

test('fails closed on an unknown adapter kind', () =>
{
    const text = JSON.stringify({ environments: { t: { displayName: 't', connectorsPolicy: { adapterAllowlist: ['mongo'], catalogOnly: false, allowProviderOverride: false, providerAllowlist: [] } } } })
    assert.throws(() => FileEnvironmentProvisioning.FromText(text), /adapter kind/)
})

test('an environment without connectorsPolicy resolves with it undefined', () =>
{
    const text = JSON.stringify({ environments: { t: { displayName: 'T' } } })
    const options = FileEnvironmentProvisioning.FromText(text).OptionsFor('t')
    assert.equal(options?.connectorsPolicy, undefined)
})

test('fails closed when the file has no environments object', () =>
{
    assert.throws(() => FileEnvironmentProvisioning.FromText('{}'), /invalid shape/)
})

test('fails closed when adapterAllowlist is not an array', () =>
{
    const text = JSON.stringify({ environments: { t: { displayName: 't', connectorsPolicy: { adapterAllowlist: 'sql', catalogOnly: false, allowProviderOverride: false, providerAllowlist: [] } } } })
    assert.throws(() => FileEnvironmentProvisioning.FromText(text), /invalid shape/)
})

test('fails closed on an invalid environment purpose', () =>
{
    const bad = JSON.stringify({ environments: { acme: { displayName: 'Acme',purpose: 'nonsense' } } })
    assert.throws(() => FileEnvironmentProvisioning.FromText(bad).OptionsFor('acme'), /invalid purpose/)
})

test('accepts a valid purpose and an absent purpose', () =>
{
    const ok = JSON.stringify({ environments: { acme: { displayName: 'Acme',purpose: 1 }, beta: { displayName: 'Beta' } } })
    const provisioning = FileEnvironmentProvisioning.FromText(ok)
    assert.equal(provisioning.OptionsFor('acme')?.purpose, 1)
    assert.equal(provisioning.OptionsFor('beta')?.purpose, undefined)
})

class PurposeFiles
{
    public static Of(purpose: unknown): string
    {
        return JSON.stringify({ environments: { acme: { displayName: 'Acme',purpose } } })
    }
}

test('accepts the purpose enum name', () =>
{
    assert.equal(FileEnvironmentProvisioning.FromText(PurposeFiles.Of('Development')).OptionsFor('acme')?.purpose, EnvironmentPurpose.Development)
    assert.equal(FileEnvironmentProvisioning.FromText(PurposeFiles.Of('Runtime')).OptionsFor('acme')?.purpose, EnvironmentPurpose.Runtime)
})

test('still accepts the numeric purpose value', () =>
{
    assert.equal(FileEnvironmentProvisioning.FromText(PurposeFiles.Of(0)).OptionsFor('acme')?.purpose, EnvironmentPurpose.Development)
    assert.equal(FileEnvironmentProvisioning.FromText(PurposeFiles.Of(1)).OptionsFor('acme')?.purpose, EnvironmentPurpose.Runtime)
})

test('fails closed on an unknown purpose name, numeric string, out-of-range number, or wrong-typed value', () =>
{
    for (const bad of ['Bogus', '0', 5, true, {}, null])
    {
        assert.throws(() => FileEnvironmentProvisioning.FromText(PurposeFiles.Of(bad)).OptionsFor('acme'), /invalid purpose/)
    }
})
