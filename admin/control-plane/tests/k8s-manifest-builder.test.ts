import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import type { IdpWorkloadSpec } from '../idp-workload-driver.js'

type K8sObject = {
    kind: string
    metadata: { name: string; namespace?: string; labels?: Record<string, string> }
    spec: any
}

class Fixture
{
    public static readonly SecretValue = 's3cr3t-value-token'

    public static Workload(withDb: boolean): EnvironmentWorkload
    {
        const workload: EnvironmentWorkload = {
            environmentName: 'dev1',
            hiveId: 'hive-a',
            image: 'pragmatic-server:dev',
            serverPort: 8080,
            env: { PRAGMATIC_PORT: '8080', OTHER: 'x' },
            secretRefs: ['admin-secret'],
        }
        if (withDb)
        {
            workload.database = { image: 'postgres:16', user: 'app', database: 'appdb', passwordRef: 'db-pass-ref' }
        }
        return workload
    }

    public static Items(withDb: boolean): K8sObject[]
    {
        const doc = JSON.parse(new K8sManifestBuilder().Render(Fixture.Workload(withDb)))
        assert.equal(doc.apiVersion, 'v1')
        assert.equal(doc.kind, 'List')
        return doc.items
    }
}

describe('K8sManifestBuilder', () =>
{
    it('renders all five objects when a database is present', () =>
    {
        const items = Fixture.Items(true)
        assert.deepEqual(items.map(i => i.kind), ['Namespace', 'Deployment', 'Service', 'StatefulSet', 'Service'])
        const server = items[2]!
        assert.equal(server.spec.type, 'ClusterIP')
        assert.equal(server.spec.ports[0].port, 8080)
        const pgSvc = items[4]!
        assert.equal(pgSvc.spec.clusterIP, 'None')
    })

    it('renders only namespace, deployment and service without a database', () =>
    {
        assert.deepEqual(Fixture.Items(false).map(i => i.kind), ['Namespace', 'Deployment', 'Service'])
    })

    it('labels the namespace', () =>
    {
        const ns = Fixture.Items(false)[0]!
        assert.equal(ns.metadata.name, 'pragmatic-env-dev1')
        assert.equal(ns.metadata.name, K8sManifestBuilder.NamespaceOf('dev1'))
        assert.equal(ns.metadata.labels!['pragmatic/environment'], 'dev1')
        assert.equal(ns.metadata.labels!['pragmatic/hive'], 'hive-a')
    })

    it('renders the server deployment', () =>
    {
        const dep = Fixture.Items(false)[1]!
        assert.equal(dep.metadata.name, K8sManifestBuilder.ServerDeploymentOf('dev1'))
        assert.equal(dep.metadata.namespace, K8sManifestBuilder.NamespaceOf('dev1'))
        assert.equal(dep.spec.replicas, 1)
        const c = dep.spec.template.spec.containers[0]
        assert.equal(c.name, K8sManifestBuilder.ServerContainerName)
        assert.equal(c.image, 'pragmatic-server:dev')
        assert.equal(c.imagePullPolicy, 'IfNotPresent')
        assert.equal(c.ports[0].containerPort, 8080)
        assert.deepEqual(c.env.map((e: any) => e.name), ['PRAGMATIC_PORT', 'OTHER'])
        assert.equal(c.readinessProbe.httpGet.path, '/healthz')
        assert.equal(c.readinessProbe.httpGet.port, 8080)
    })

    it('references the postgres password by secretKeyRef only', () =>
    {
        const text = new K8sManifestBuilder().Render(Fixture.Workload(true))
        assert.ok(!text.includes(Fixture.SecretValue))
        const sts = (JSON.parse(text).items as K8sObject[])[3]!
        const c = sts.spec.template.spec.containers[0]
        assert.equal(c.image, 'postgres:16')
        const byName = (n: string) => c.env.find((e: any) => e.name === n)
        assert.equal(byName('POSTGRES_USER').value, 'app')
        assert.equal(byName('POSTGRES_DB').value, 'appdb')
        const pw = byName('POSTGRES_PASSWORD')
        assert.equal(pw.value, undefined)
        assert.equal(pw.valueFrom.secretKeyRef.name, 'db-pass-ref')
        assert.ok(sts.spec.volumeClaimTemplates[0].spec.resources.requests.storage)
    })
})

describe('K8sManifestBuilder.RenderHiveAgent', () =>
{
    const Registry = 'http://host.docker.internal:7000'
    const TokenSecret = 'agent-token-secret'
    const HiveId = 'hive-a'

    class HiveFixture
    {
        public static Items(): any[]
        {
            const doc = JSON.parse(new K8sManifestBuilder().RenderHiveAgent(HiveId, Registry, TokenSecret))
            assert.equal(doc.apiVersion, 'v1')
            assert.equal(doc.kind, 'List')
            return doc.items
        }

        public static Of(kind: string): any
        {
            const found = HiveFixture.Items().filter(i => i.kind === kind)
            assert.equal(found.length, 1)
            return found[0]
        }
    }

    it('emits Namespace, SA, ClusterRole, ClusterRoleBinding and Deployment; all but the shared Namespace hive-labeled', () =>
    {
        const items = HiveFixture.Items()
        assert.deepEqual(items.map(i => i.kind), ['Namespace', 'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Deployment'])
        assert.equal(items[0].metadata.labels, undefined)
        for (const i of items.slice(1))
        {
            assert.equal(i.metadata.labels['pragmatic/hive'], HiveId)
            assert.equal(i.metadata.labels['pragmatic/environment'], undefined)
        }
        assert.equal(HiveFixture.Of('ClusterRole').metadata.namespace, undefined)
        assert.equal(HiveFixture.Of('ClusterRoleBinding').metadata.namespace, undefined)
    })

    it('ClusterRole allows only get/list/patch on apps/deployments', () =>
    {
        const role = HiveFixture.Of('ClusterRole')
        assert.equal(role.rules.length, 1)
        assert.deepEqual(role.rules[0], { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'patch'] })
    })

    it('ClusterRoleBinding binds the ClusterRole to the service account', () =>
    {
        const crb = HiveFixture.Of('ClusterRoleBinding')
        const sa = HiveFixture.Of('ServiceAccount')
        const role = HiveFixture.Of('ClusterRole')
        assert.deepEqual(crb.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: role.metadata.name })
        assert.deepEqual(crb.subjects, [{ kind: 'ServiceAccount', name: sa.metadata.name, namespace: sa.metadata.namespace }])
        assert.equal(sa.metadata.name, K8sManifestBuilder.HiveAgentNameOf(HiveId))
        assert.equal(role.metadata.name, K8sManifestBuilder.HiveAgentNameOf(HiveId))
    })

    it('deployment env has hive id, registry url, secret token and no env name', () =>
    {
        const dep = HiveFixture.Of('Deployment')
        const pod = dep.spec.template.spec
        assert.equal(pod.serviceAccountName, K8sManifestBuilder.HiveAgentNameOf(HiveId))
        const c = pod.containers[0]
        assert.deepEqual(c.command, ['node', 'dist/bin/pragmatic-agentd.js'])
        const byName = (n: string) => c.env.find((e: any) => e.name === n)
        assert.equal(byName('PRAGMATIC_AGENT_HIVE_ID').value, HiveId)
        assert.equal(byName('PRAGMATIC_AGENT_REGISTRY_URL').value, Registry)
        assert.equal(byName('PRAGMATIC_AGENT_ENV_NAME'), undefined)
        const token = byName('PRAGMATIC_AGENT_TOKEN')
        assert.equal(token.value, undefined)
        assert.equal(token.valueFrom.secretKeyRef.name, TokenSecret)
    })

    it('env server deployment carries the hive and environment labels on its metadata', () =>
    {
        const dep = Fixture.Items(false)[1]!
        assert.equal(dep.metadata.labels!['pragmatic/hive'], HiveId)
        assert.equal(dep.metadata.labels!['pragmatic/environment'], 'dev1')
    })
})

describe('K8sManifestBuilder.RenderIdp', () =>
{
    const Spec: IdpWorkloadSpec = {
        tenantId: 't1', hiveId: 'hive-a', image: 'pragmatic-server:dev', port: 9443,
        adminTokenSecretName: 'idp-admin-secret', adminTokenRef: 'admin-token', tlsSecretName: 'idp-tls-secret'
    }

    const Items = (): any[] => JSON.parse(new K8sManifestBuilder().RenderIdp(Spec)).items

    it('emits Namespace, ServiceAccount, PVC, Deployment and Service, all hive-labeled', () =>
    {
        const items = Items()
        assert.deepEqual(items.map(i => i.kind), ['Namespace', 'ServiceAccount', 'PersistentVolumeClaim', 'Deployment', 'Service'])
        for (const i of items)
        {
            assert.equal(i.metadata.labels['pragmatic/hive'], 'hive-a', i.kind)
            assert.equal(i.metadata.labels['pragmatic/environment'], undefined, i.kind)
        }
        assert.equal(items[0].metadata.name, 'pragmatic-idp-t1')
    })

    it('Service is ClusterIP and its DNS name matches IdpBaseUrlOf', () =>
    {
        const svc = Items()[4]
        assert.equal(svc.spec.type, 'ClusterIP')
        assert.equal(svc.spec.ports[0].port, 9443)
        assert.equal(K8sManifestBuilder.IdpBaseUrlOf('t1', 9443), `https://${svc.metadata.name}.${svc.metadata.namespace}.svc.cluster.local:9443`)
    })

    it('carries secrets only as volume refs, never inline, and runs least-privilege', () =>
    {
        const raw = new K8sManifestBuilder().RenderIdp(Spec)
        const dep = Items()[3]
        const pod = dep.spec.template.spec
        const secretNames = pod.volumes.filter((v: any) => v.secret).map((v: any) => v.secret.secretName).sort()
        assert.deepEqual(secretNames, ['idp-admin-secret', 'idp-tls-secret'])
        assert.equal(pod.automountServiceAccountToken, false)
        assert.equal(pod.securityContext.fsGroup, 1000)
        assert.equal(pod.volumes.find((v: any) => v.secret).secret.defaultMode, 0o440)
        const sc = pod.containers[0].securityContext
        assert.equal(sc.runAsNonRoot, true)
        assert.equal(sc.runAsUser, 1000)
        assert.deepEqual(sc.capabilities.drop, ['ALL'])
        assert.equal(sc.seccompProfile.type, 'RuntimeDefault')
        assert.equal(pod.containers[0].securityContext.allowPrivilegeEscalation, false)
        assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true)
        const env = pod.containers[0].env
        assert.ok(env.every((e: any) => e.valueFrom === undefined))
        assert.equal(env.find((e: any) => e.name === 'PRAGMATIC_IDP_ADMIN_TOKEN_REF').value, 'admin-token')
        assert.equal(env.find((e: any) => e.name === 'PRAGMATIC_IDP_BASE_URL').value, K8sManifestBuilder.IdpBaseUrlOf('t1', 9443))
        assert.ok(!raw.includes('ClusterRole') && !raw.includes('RoleBinding'))
    })
})
