import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveBootstrapBundle } from '../hive-bootstrap-bundle.js'

describe('HiveBootstrapBundle', () =>
{
    it('renders the agent objects for the hive, pointed at the channel, with the token Secret named but never filled', () =>
    {
        const bundle = HiveBootstrapBundle.For('acme-hive', 'http://host.docker.internal:7001')
        assert.equal(bundle.fileName, 'bootstrap-acme-hive.json')
        assert.equal(bundle.namespace, 'pragmatic-system')
        assert.equal(bundle.agentName, 'pragmatic-hive-acme-hive-agent')
        assert.equal(bundle.tokenSecretName, 'pragmatic-hive-acme-hive-agent-token')
        assert.equal(bundle.tokenSecretKey, 'token')
        assert.equal(bundle.hiveSelector, 'pragmatic/hive=acme-hive')
        // The selector picks the agent: its Deployment carries that label.
        assert.ok(bundle.manifest.includes('"pragmatic/hive": "acme-hive"'))
        const list = JSON.parse(bundle.manifest) as { kind: string; items: { kind: string }[] }
        assert.equal(list.kind, 'List')
        assert.deepEqual(list.items.map(i => i.kind), ['Namespace', 'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Deployment'])
        assert.ok(bundle.manifest.includes('http://host.docker.internal:7001'))
        assert.ok(bundle.manifest.includes(bundle.tokenSecretName))
        assert.ok(!list.items.some(i => i.kind === 'Secret'))
        assert.equal(bundle.autoInstall, false)
    })

    it('carries the automatic-install flag it is given', () =>
    {
        assert.equal(HiveBootstrapBundle.For('acme-hive', 'http://host.docker.internal:7001', true).autoInstall, true)
    })
})
