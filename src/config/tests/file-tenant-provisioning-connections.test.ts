import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FileTenantProvisioning } from '../file-tenant-provisioning.js'
import { FileConnectionResolver } from '../../host/file-connection-resolver.js'

test('a connections block yields a FileConnectionResolver and collects distinct secret refs', () =>
{
    const json = JSON.stringify({ tenants: { acme: { displayName: 'Acme', connections: {
        crm: { settings: { host: 'h', database: 'crm' }, secretRef: 'acme/crm/pw' },
        billing: { settings: { database: 'bill' }, secretRef: 'acme/crm/pw' },
    } } } })
    const provisioning = FileTenantProvisioning.FromText(json)
    const tenant = provisioning.OptionsFor('acme')
    assert.ok(tenant !== null)
    assert.ok(tenant.connectors?.connectionResolver instanceof FileConnectionResolver)
    assert.deepEqual([...tenant.connectorSecretRefs ?? []], ['acme/crm/pw'])
})

test('a tenant with no connections leaves connectors and connectorSecretRefs unset', () =>
{
    const provisioning = FileTenantProvisioning.FromText(JSON.stringify({ tenants: { acme: { displayName: 'Acme' } } }))
    const tenant = provisioning.OptionsFor('acme')
    assert.ok(tenant !== null)
    assert.equal(tenant.connectors, undefined)
    assert.equal(tenant.connectorSecretRefs, undefined)
})

test('connections with non-object settings fail closed with a sanitized shape error (Review Focus 4)', () =>
{
    const json = JSON.stringify({ tenants: { acme: { displayName: 'Acme', connections: { crm: { settings: 'nope' } } } } })
    assert.throws(() => FileTenantProvisioning.FromText(json), /tenants file has an invalid shape/)
})

test('connections with a non-string setting value fail closed naming no value (Review Focus 4)', () =>
{
    const json = JSON.stringify({ tenants: { acme: { displayName: 'Acme', connections: { crm: { settings: { port: 5432 } } } } } })
    assert.throws(() => FileTenantProvisioning.FromText(json), (e: unknown) =>
    {
        const message = (e as Error).message
        assert.match(message, /tenants file has an invalid shape/)
        assert.doesNotMatch(message, /5432/)
        return true
    })
})

test('connections with a non-string secretRef fail closed', () =>
{
    const json = JSON.stringify({ tenants: { acme: { displayName: 'Acme', connections: { crm: { settings: { database: 'd' }, secretRef: 5 } } } } })
    assert.throws(() => FileTenantProvisioning.FromText(json), /tenants file has an invalid shape/)
})
