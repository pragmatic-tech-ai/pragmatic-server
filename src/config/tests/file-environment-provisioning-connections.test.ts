import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FileEnvironmentProvisioning } from '../file-environment-provisioning.js'
import { FileConnectionResolver } from '../../host/file-connection-resolver.js'

test('a connections block yields a FileConnectionResolver and collects distinct secret refs', () =>
{
    const json = JSON.stringify({ environments: { acme: { displayName: 'Acme', connections: {
        crm: { settings: { host: 'h', database: 'crm' }, secretRef: 'acme/crm/pw' },
        billing: { settings: { database: 'bill' }, secretRef: 'acme/crm/pw' },
    } } } })
    const provisioning = FileEnvironmentProvisioning.FromText(json)
    const environment = provisioning.OptionsFor('acme')
    assert.ok(environment !== null)
    assert.ok(environment.connectors?.connectionResolver instanceof FileConnectionResolver)
    assert.deepEqual([...environment.connectorSecretRefs ?? []], ['acme/crm/pw'])
})

test('an environment with no connections leaves connectors and connectorSecretRefs unset', () =>
{
    const provisioning = FileEnvironmentProvisioning.FromText(JSON.stringify({ environments: { acme: { displayName: 'Acme' } } }))
    const environment = provisioning.OptionsFor('acme')
    assert.ok(environment !== null)
    assert.equal(environment.connectors, undefined)
    assert.equal(environment.connectorSecretRefs, undefined)
})

test('connections with non-object settings fail closed with a sanitized shape error (Review Focus 4)', () =>
{
    const json = JSON.stringify({ environments: { acme: { displayName: 'Acme', connections: { crm: { settings: 'nope' } } } } })
    assert.throws(() => FileEnvironmentProvisioning.FromText(json), /environments file has an invalid shape/)
})

test('connections with a non-string setting value fail closed naming no value (Review Focus 4)', () =>
{
    const json = JSON.stringify({ environments: { acme: { displayName: 'Acme', connections: { crm: { settings: { port: 5432 } } } } } })
    assert.throws(() => FileEnvironmentProvisioning.FromText(json), (e: unknown) =>
    {
        const message = (e as Error).message
        assert.match(message, /environments file has an invalid shape/)
        assert.doesNotMatch(message, /5432/)
        return true
    })
})

test('connections with a non-string secretRef fail closed', () =>
{
    const json = JSON.stringify({ environments: { acme: { displayName: 'Acme', connections: { crm: { settings: { database: 'd' }, secretRef: 5 } } } } })
    assert.throws(() => FileEnvironmentProvisioning.FromText(json), /environments file has an invalid shape/)
})

test('connections with a non-string tokenEnvVar fail closed', () =>
{
    const json = JSON.stringify({ environments: { acme: { displayName: 'Acme', connections: { crm: { settings: { database: 'd' }, tokenEnvVar: 7 } } } } })
    assert.throws(() => FileEnvironmentProvisioning.FromText(json), /environments file has an invalid shape/)
})

test('an empty-string secretRef is not collected', () =>
{
    const json = JSON.stringify({ environments: { acme: { displayName: 'Acme', connections: { crm: { settings: { database: 'd' }, secretRef: '' } } } } })
    const environment = FileEnvironmentProvisioning.FromText(json).OptionsFor('acme')
    assert.deepEqual([...environment?.connectorSecretRefs ?? []], [])
})

test('distinct secret refs across connections are all collected in order', () =>
{
    const json = JSON.stringify({ environments: { acme: { displayName: 'Acme', connections: {
        crm: { settings: { database: 'c' }, secretRef: 'acme/crm/pw' },
        billing: { settings: { database: 'b' }, secretRef: 'acme/billing/pw' },
    } } } })
    const environment = FileEnvironmentProvisioning.FromText(json).OptionsFor('acme')
    assert.deepEqual([...environment?.connectorSecretRefs ?? []], ['acme/crm/pw', 'acme/billing/pw'])
})
