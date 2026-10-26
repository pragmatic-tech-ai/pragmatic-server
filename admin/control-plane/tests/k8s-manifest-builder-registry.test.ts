import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { InClusterRegistry } from '../in-cluster-registry.js'

describe('K8sManifestBuilder.RenderRegistry', () =>
{
    const items = JSON.parse(new K8sManifestBuilder().RenderRegistry('hive-1')).items as any[]
    const dep = items.find(o => o.kind === 'Deployment')
    const svc = items.find(o => o.kind === 'Service')
    const pvc = items.find(o => o.kind === 'PersistentVolumeClaim')

    it('renders a registry:2 Deployment in pragmatic-system with a /v2/ readiness probe', () =>
    {
        assert.equal(items[0].kind, 'Namespace')
        assert.equal(dep.metadata.namespace, 'pragmatic-system')
        assert.equal(dep.metadata.labels['pragmatic/hive'], 'hive-1')
        const c = dep.spec.template.spec.containers[0]
        assert.equal(c.image, 'registry:2')
        assert.equal(c.readinessProbe.httpGet.path, '/v2/')
        assert.equal(c.readinessProbe.httpGet.port, 5000)
    })
    it('exposes a NodePort Service whose nodePort matches InClusterRegistry.NodePort', () =>
    {
        assert.equal(svc.spec.type, 'NodePort')
        const p = svc.spec.ports[0]
        assert.equal(p.port, 5000)
        assert.equal(p.targetPort, 5000)
        assert.equal(p.nodePort, InClusterRegistry.NodePort)
    })
    it('backs the registry with a PVC the Deployment mounts', () =>
    {
        assert.equal(pvc.metadata.name, InClusterRegistry.DataClaimName)
        const vols = dep.spec.template.spec.volumes
        assert.ok(vols.some((v: any) => v.persistentVolumeClaim?.claimName === InClusterRegistry.DataClaimName))
    })
})
