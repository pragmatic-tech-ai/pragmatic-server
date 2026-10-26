import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { InClusterRegistry } from '../in-cluster-registry.js'

const HiveId = 'hive-1'
const HiveLabel = 'pragmatic/hive'
const NodePortType = 'NodePort'
const NamespaceKind = 'Namespace'
const DeploymentKind = 'Deployment'
const ServiceKind = 'Service'
const ClaimKind = 'PersistentVolumeClaim'

describe('K8sManifestBuilder.RenderRegistry', () =>
{
    let items: any[]
    let dep: any
    let svc: any
    let pvc: any

    before(() =>
    {
        items = JSON.parse(new K8sManifestBuilder().RenderRegistry(HiveId)).items as any[]
        dep = items.find(o => o.kind === DeploymentKind)
        svc = items.find(o => o.kind === ServiceKind)
        pvc = items.find(o => o.kind === ClaimKind)
    })

    it('renders the registry Namespace first, matching the builder system namespace', () =>
    {
        assert.equal(items[0].kind, NamespaceKind)
        assert.equal(items[0].metadata.name, InClusterRegistry.Namespace)
        assert.equal(K8sManifestBuilder.SystemNamespace, InClusterRegistry.Namespace)
    })
    it('renders a registry Deployment in the registry namespace with a /v2/ readiness probe', () =>
    {
        assert.equal(dep.metadata.namespace, InClusterRegistry.Namespace)
        assert.equal(dep.metadata.labels[HiveLabel], HiveId)
        const c = dep.spec.template.spec.containers[0]
        assert.equal(c.image, InClusterRegistry.Image)
        assert.equal(c.readinessProbe.httpGet.path, InClusterRegistry.V2Path)
        assert.equal(c.readinessProbe.httpGet.port, InClusterRegistry.ServicePort)
    })
    it('exposes a NodePort Service whose nodePort matches InClusterRegistry.NodePort', () =>
    {
        assert.equal(svc.spec.type, NodePortType)
        const p = svc.spec.ports[0]
        assert.equal(p.port, InClusterRegistry.ServicePort)
        assert.equal(p.targetPort, InClusterRegistry.ServicePort)
        assert.equal(p.nodePort, InClusterRegistry.NodePort)
    })
    it('backs the registry with a PVC the Deployment mounts', () =>
    {
        assert.equal(pvc.metadata.name, InClusterRegistry.DataClaimName)
        const vols = dep.spec.template.spec.volumes
        assert.ok(vols.some((v: any) => v.persistentVolumeClaim?.claimName === InClusterRegistry.DataClaimName))
    })
})
