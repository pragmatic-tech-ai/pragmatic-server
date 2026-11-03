import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveBootstrapBundle } from '../hive-bootstrap-bundle.js'
import { InvalidRecordIdError } from '../platform-records.js'

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

    it('the removal manifest names every bundle object but the shared Namespace, plus the token Secret, and carries no spec or data', () =>
    {
        const bundle = HiveBootstrapBundle.For('acme-hive', 'http://host.docker.internal:7001')
        const removal = JSON.parse(HiveBootstrapBundle.RemovalManifest('acme-hive')) as { kind: string; items: Record<string, unknown>[] }
        assert.equal(removal.kind, 'List')
        const rendered = (JSON.parse(bundle.manifest) as { items: { kind: string; apiVersion: string; metadata: { name: string; namespace?: string } }[] }).items
            .filter(i => i.kind !== 'Namespace')
            .map(i => ({ apiVersion: i.apiVersion, kind: i.kind, metadata: i.metadata.namespace === undefined ? { name: i.metadata.name } : { name: i.metadata.name, namespace: i.metadata.namespace } }))
        assert.deepEqual(removal.items, [
            ...rendered,
            { apiVersion: 'v1', kind: 'Secret', metadata: { name: bundle.tokenSecretName, namespace: bundle.namespace } },
        ])
        assert.deepEqual(removal.items.map(i => i.kind), ['ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Deployment', 'Secret'])
        assert.ok(!HiveBootstrapBundle.RemovalManifest('acme-hive').includes('"spec"'))
    })

    it('refuses an id that is not a valid label value: the manual rotation command restarts by its selector', () =>
    {
        assert.throws(() => HiveBootstrapBundle.For('=b', 'http://host.docker.internal:7001'), InvalidRecordIdError)
        assert.throws(() => HiveBootstrapBundle.For('b ', 'http://host.docker.internal:7001'), InvalidRecordIdError)
    })

    it('carries the automatic-install flag it is given', () =>
    {
        assert.equal(HiveBootstrapBundle.For('acme-hive', 'http://host.docker.internal:7001', true).autoInstall, true)
    })
})
