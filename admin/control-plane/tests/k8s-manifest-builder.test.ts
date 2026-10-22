import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { EnvironmentWorkload } from '../environment-workload.js'

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

describe('K8sManifestBuilder.RenderAgent', () =>
{
    const Registry = 'http://host.docker.internal:7000'
    const TokenSecret = 'agent-token-secret'

    class AgentFixture
    {
        public static Text(): string
        {
            return new K8sManifestBuilder().RenderAgent(Fixture.Workload(false), Registry, TokenSecret)
        }

        public static Items(): K8sObject[]
        {
            const doc = JSON.parse(AgentFixture.Text())
            assert.equal(doc.apiVersion, 'v1')
            assert.equal(doc.kind, 'List')
            return doc.items
        }

        public static Of(kind: string): K8sObject
        {
            return AgentFixture.Items().find(i => i.kind === kind)!
        }
    }

    it('emits the four agent objects in the env namespace', () =>
    {
        const items = AgentFixture.Items()
        assert.deepEqual(items.map(i => i.kind), ['ServiceAccount', 'Role', 'RoleBinding', 'Deployment'])
        for (const i of items)
        {
            assert.equal(i.metadata.namespace, K8sManifestBuilder.NamespaceOf('dev1'))
        }
    })

    it('name helpers match rendered names', () =>
    {
        assert.equal(AgentFixture.Of('ServiceAccount').metadata.name, K8sManifestBuilder.AgentServiceAccountOf('dev1'))
        assert.equal(AgentFixture.Of('Role').metadata.name, K8sManifestBuilder.AgentRoleOf('dev1'))
        assert.equal(AgentFixture.Of('RoleBinding').metadata.name, K8sManifestBuilder.AgentRoleBindingOf('dev1'))
        assert.equal(AgentFixture.Of('Deployment').metadata.name, K8sManifestBuilder.AgentDeploymentOf('dev1'))
    })

    it('Role is least-privilege: get/patch on the one server deployment', () =>
    {
        const role = AgentFixture.Of('Role') as any
        assert.equal(role.apiVersion, 'rbac.authorization.k8s.io/v1')
        assert.equal(role.rules.length, 1)
        const rule = role.rules[0]
        assert.deepEqual(rule.apiGroups, ['apps'])
        assert.deepEqual(rule.resources, ['deployments'])
        assert.deepEqual(rule.verbs, ['get', 'patch'])
        assert.deepEqual(rule.resourceNames, [K8sManifestBuilder.ServerDeploymentOf('dev1')])
        assert.ok(!JSON.stringify(role).includes('*'))
        assert.notEqual(role.kind, 'ClusterRole')
    })

    it('RoleBinding binds the service account to the role', () =>
    {
        const rb = AgentFixture.Of('RoleBinding') as any
        assert.equal(rb.apiVersion, 'rbac.authorization.k8s.io/v1')
        assert.deepEqual(rb.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: K8sManifestBuilder.AgentRoleOf('dev1') })
        assert.deepEqual(rb.subjects, [{ kind: 'ServiceAccount', name: K8sManifestBuilder.AgentServiceAccountOf('dev1'), namespace: K8sManifestBuilder.NamespaceOf('dev1') }])
    })

    it('agent deployment runs pragmatic-agentd and references the token by secretKeyRef only', () =>
    {
        const dep = AgentFixture.Of('Deployment')
        assert.equal(dep.spec.replicas, 1)
        const pod = dep.spec.template.spec
        assert.equal(pod.serviceAccountName, K8sManifestBuilder.AgentServiceAccountOf('dev1'))
        const c = pod.containers[0]
        assert.equal(c.image, 'pragmatic-server:dev')
        assert.equal(c.imagePullPolicy, 'IfNotPresent')
        assert.deepEqual(c.command, ['node', 'dist/bin/pragmatic-agentd.js'])
        const byName = (n: string) => c.env.find((e: any) => e.name === n)
        assert.equal(byName('PRAGMATIC_AGENT_REGISTRY_URL').value, Registry)
        assert.equal(byName('PRAGMATIC_AGENT_HIVE_ID').value, 'hive-a')
        assert.equal(byName('PRAGMATIC_AGENT_ENV_NAME').value, 'dev1')
        const token = byName('PRAGMATIC_AGENT_TOKEN')
        assert.equal(token.value, undefined)
        assert.equal(token.valueFrom.secretKeyRef.name, TokenSecret)
        assert.ok(token.valueFrom.secretKeyRef.key)
        assert.ok(!AgentFixture.Text().includes(Fixture.SecretValue))
    })

    it('leaves Render unchanged', () =>
    {
        assert.deepEqual(Fixture.Items(false).map(i => i.kind), ['Namespace', 'Deployment', 'Service'])
    })
})
