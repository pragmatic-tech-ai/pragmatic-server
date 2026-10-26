import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { EnvServerSeedSource } from '../env-server-seed.js'
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
            environmentId: 'env-dev1-id',
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
        assert.deepEqual(items.map(i => i.kind), ['Namespace', 'Deployment', 'Service', 'StatefulSet', 'Service', 'PersistentVolumeClaim'])
        const server = items[2]!
        assert.equal(server.spec.type, 'ClusterIP')
        assert.equal(server.spec.ports[0].port, 8080)
        const pgSvc = items[4]!
        assert.equal(pgSvc.spec.clusterIP, 'None')
    })

    it('renders only namespace, deployment and service without a database', () =>
    {
        assert.deepEqual(Fixture.Items(false).map(i => i.kind), ['Namespace', 'Deployment', 'Service', 'PersistentVolumeClaim'])
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
        assert.deepEqual(c.env.map((e: any) => e.name), ['PRAGMATIC_PORT', 'OTHER', 'PRAGMATIC_BASE_DIR', 'PRAGMATIC_TENANTS_FILE', 'PRAGMATIC_MASTER_KEY_FILE', 'PRAGMATIC_PROVISIONED_SECRETS_FILE', 'PRAGMATIC_DEPLOYMENT_MODE'])
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

describe('K8sManifestBuilder server boot wiring', () =>
{
    const pod = (items: K8sObject[]) => items.find(i => i.kind === 'Deployment')!.spec.template.spec

    it('injects the five boot env vars, three server mounts and four volumes (incl. init-only seed)', () =>
    {
        const spec = pod(Fixture.Items(false))
        const c = spec.containers[0]
        const val = (n: string) => c.env.find((e: any) => e.name === n).value
        assert.equal(val('PRAGMATIC_PORT'), '8080')
        assert.equal(val('PRAGMATIC_BASE_DIR'), '/pragmatic/data')
        assert.equal(val('PRAGMATIC_TENANTS_FILE'), '/pragmatic/config/tenants.json')
        assert.equal(val('PRAGMATIC_MASTER_KEY_FILE'), '/pragmatic/secrets/master.key')
        assert.equal(val('PRAGMATIC_PROVISIONED_SECRETS_FILE'), '/pragmatic/secrets/provisioned-secrets.json')
        assert.equal(val('PRAGMATIC_DEPLOYMENT_MODE'), 'local')
        assert.deepEqual(c.volumeMounts.map((m: any) => m.mountPath), ['/pragmatic/config', '/pragmatic/secrets', '/pragmatic/data'])
        assert.equal(spec.volumes.length, 4)
        assert.equal(spec.volumes[0].configMap.name, EnvServerSeedSource.ConfigMapNameOf('dev1'))
        assert.equal(spec.volumes[1].secret.secretName, EnvServerSeedSource.SecretNameOf('dev1'))
        assert.equal(spec.volumes[2].persistentVolumeClaim.claimName, K8sManifestBuilder.ServerDataClaimNameOf('dev1'))
        assert.deepEqual(c.volumeMounts.map((m: any) => m.name), spec.volumes.slice(0, 3).map((v: any) => v.name))
    })

    it('sets fsGroup so the non-root server reads the 0440 secrets and writes the data PVC', () =>
    {
        const spec = pod(Fixture.Items(false))
        assert.equal(spec.securityContext.fsGroup, 10001)
        assert.equal(spec.volumes[1].secret.defaultMode, 0o440)
    })

    it('backs the base dir with a standalone PVC, not volumeClaimTemplates, and keeps the db password ref', () =>
    {
        const items = Fixture.Items(true)
        const pvc = items.find(i => i.kind === 'PersistentVolumeClaim')!
        assert.equal(pvc.metadata.name, K8sManifestBuilder.ServerDataClaimNameOf('dev1'))
        assert.equal(pvc.metadata.namespace, K8sManifestBuilder.NamespaceOf('dev1'))
        assert.deepEqual(pvc.spec.accessModes, ['ReadWriteOnce'])
        const dep = items.find(i => i.kind === 'Deployment')!
        assert.equal(dep.spec.volumeClaimTemplates, undefined)
        const sts = items.find(i => i.kind === 'StatefulSet')!
        const pw = sts.spec.template.spec.containers[0].env.find((e: any) => e.name === 'POSTGRES_PASSWORD')
        assert.equal(pw.valueFrom.secretKeyRef.name, 'db-pass-ref')
        assert.equal(sts.spec.volumeClaimTemplates.length, 1)
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

    it('with baseDomain the IdP Deployment env serves the split: BASE_URL=browser, INTERNAL_URL=internal', () =>
    {
        const dep = JSON.parse(new K8sManifestBuilder().RenderIdp({ ...Spec, baseDomain: 'd.localtest' })).items.find((i: any) => i.kind === 'Deployment')
        const env = dep.spec.template.spec.containers[0].env as { name: string; value: string }[]
        const val = (n: string): string | undefined => env.find(e => e.name === n)?.value
        assert.equal(val('PRAGMATIC_IDP_BASE_URL'), K8sManifestBuilder.IdpBrowserUrlOf('t1', 'd.localtest'))
        assert.equal(val('PRAGMATIC_IDP_INTERNAL_URL'), K8sManifestBuilder.IdpBaseUrlOf('t1', 9443))
    })

    it('without baseDomain the IdP Deployment env is single-host: BASE_URL=internal, no INTERNAL_URL', () =>
    {
        const dep = Items().find((i: any) => i.kind === 'Deployment')
        const env = dep.spec.template.spec.containers[0].env as { name: string; value: string }[]
        const val = (n: string): string | undefined => env.find(e => e.name === n)?.value
        assert.equal(val('PRAGMATIC_IDP_BASE_URL'), K8sManifestBuilder.IdpBaseUrlOf('t1', 9443))
        assert.equal(val('PRAGMATIC_IDP_INTERNAL_URL'), undefined)
    })

    it('with baseDomain emits exactly one ssl-passthrough nginx Ingress routing the browser host to the IdP Service', () =>
    {
        const items = JSON.parse(new K8sManifestBuilder().RenderIdp({ ...Spec, baseDomain: 'd.localtest' })).items
        const ingresses = items.filter((i: any) => i.kind === 'Ingress')
        assert.equal(ingresses.length, 1)
        const ing = ingresses[0]
        assert.equal(ing.apiVersion, 'networking.k8s.io/v1')
        assert.equal(ing.metadata.namespace, 'pragmatic-idp-t1')
        assert.equal(ing.metadata.annotations['nginx.ingress.kubernetes.io/ssl-passthrough'], 'true')
        assert.equal(ing.spec.ingressClassName, 'nginx')
        assert.equal(ing.spec.rules.length, 1)
        assert.equal(ing.spec.rules[0].host, 'idp-t1.d.localtest')
        const path = ing.spec.rules[0].http.paths[0]
        assert.equal(path.path, '/')
        assert.equal(path.pathType, 'Prefix')
        assert.equal(path.backend.service.name, 'pragmatic-idp-t1')
        assert.equal(path.backend.service.port.number, 9443)
    })

    it('without baseDomain emits no Ingress', () =>
    {
        const items = Items()
        assert.ok(items.every((i: any) => i.kind !== 'Ingress'))
        assert.equal(items.length, 5)
    })

    it('IdpBrowserUrlOf is the idp-<tenant>.<baseDomain> browser origin, distinct from the internal base', () =>
    {
        assert.equal(K8sManifestBuilder.IdpBrowserUrlOf('t1', 'd.localtest'), 'https://idp-t1.d.localtest')
        assert.equal(K8sManifestBuilder.IdpBrowserUrlOf('t1', 'd.localtest', 8443), 'https://idp-t1.d.localtest:8443')
        assert.notEqual(K8sManifestBuilder.IdpBrowserUrlOf('t1', 'd.localtest'), K8sManifestBuilder.IdpBaseUrlOf('t1', 9443))
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

describe('K8sManifestBuilder server seed init-container', () =>
{
    class SeedFixture
    {
        public static Pod(): any
        {
            const deployment = Fixture.Items(false).find(i => i.kind === 'Deployment')!
            return deployment.spec.template.spec
        }
    }

    it('renders a hardened init-container keyed on environmentId, not environmentName', () =>
    {
        const pod = SeedFixture.Pod()
        assert.equal(pod.initContainers.length, 1)
        const init = pod.initContainers[0]
        assert.equal(init.image, pod.containers[0].image)
        const dest = '/pragmatic/data/env-dev1-id'
        assert.ok(init.command.includes(dest))
        assert.ok(!init.command.some((c: string) => c.includes('/pragmatic/data/dev1')))
        const seedMount = init.volumeMounts.find((m: any) => m.mountPath === '/pragmatic/seed')
        assert.equal(seedMount.readOnly, true)
        const dataMount = init.volumeMounts.find((m: any) => m.mountPath === '/pragmatic/data')
        assert.equal(dataMount.readOnly, undefined)
        const dataVolume = pod.volumes.find((v: any) => v.name === dataMount.name)
        assert.equal(dataVolume.persistentVolumeClaim.claimName, K8sManifestBuilder.ServerDataClaimNameOf('dev1'))
        assert.equal(init.securityContext.runAsUser, 10001)
        assert.equal(init.securityContext.readOnlyRootFilesystem, true)
        assert.deepEqual(init.securityContext.capabilities.drop, ['ALL'])
    })

    it('guards the unpack on the .env-seeded marker', () =>
    {
        const init = SeedFixture.Pod().initContainers[0]
        const script = init.command.find((c: string) => c.includes('.env-seeded'))
        assert.ok(script)
        assert.ok(script.includes('existsSync'))
        assert.equal(init.command[init.command.length - 1], `/pragmatic/seed/${EnvServerSeedSource.SeedKey}`)
    })

    it('mounts a volume referencing the seed Secret', () =>
    {
        const pod = SeedFixture.Pod()
        const init = pod.initContainers[0]
        const mount = init.volumeMounts.find((m: any) => m.mountPath === '/pragmatic/seed')
        const volume = pod.volumes.find((v: any) => v.name === mount.name)
        assert.equal(volume.secret.secretName, EnvServerSeedSource.SeedSecretNameOf('dev1'))
    })
})

describe('K8sManifestBuilder seed script behaviour', () =>
{
    class ScriptFixture
    {
        public static Run(dest: string, seed: string): ReturnType<typeof spawnSync>
        {
            return spawnSync(process.execPath, ['-e', K8sManifestBuilder.ServerSeedScript, dest, seed], { encoding: 'utf8' })
        }

        public static Seed(root: string, entries: Record<string, string>): string
        {
            const map: Record<string, string> = {}
            for (const [k, v] of Object.entries(entries))
            {
                map[k] = Buffer.from(v).toString('base64')
            }
            const path = join(root, 'seed.json')
            writeFileSync(path, JSON.stringify(map))
            return path
        }
    }

    it('unpacks nested entries and writes the marker on first run, then leaves modified files alone', () =>
    {
        const root = mkdtempSync(join(tmpdir(), 'seed-'))
        const dest = join(root, 'data', 'env-1')
        const seed = ScriptFixture.Seed(root, { 'packages/x/0.1.0/model.json': 'A', 'applications/x/application.json': 'B' })
        assert.equal(ScriptFixture.Run(dest, seed).status, 0)
        assert.equal(readFileSync(join(dest, 'packages/x/0.1.0/model.json'), 'utf8'), 'A')
        assert.equal(readFileSync(join(dest, 'applications/x/application.json'), 'utf8'), 'B')
        assert.ok(existsSync(join(dest, '.env-seeded')))
        writeFileSync(join(dest, 'packages/x/0.1.0/model.json'), 'LIVE')
        assert.equal(ScriptFixture.Run(dest, seed).status, 0)
        assert.equal(readFileSync(join(dest, 'packages/x/0.1.0/model.json'), 'utf8'), 'LIVE')
    })

    it('rejects an escaping entry and writes no marker', () =>
    {
        const root = mkdtempSync(join(tmpdir(), 'seed-'))
        const dest = join(root, 'data', 'env-1')
        const seed = ScriptFixture.Seed(root, { '../escape': 'X' })
        const result = ScriptFixture.Run(dest, seed)
        assert.notEqual(result.status, 0)
        assert.ok(!existsSync(join(dest, '.env-seeded')))
        assert.ok(!existsSync(join(root, 'data', 'escape')))
    })
})

class FederatedEnv
{
    public static Items(): any[]
    {
        return JSON.parse(new K8sManifestBuilder().Render({ ...Fixture.Workload(false), federation: { baseDomain: 'hive.test', caSecretName: 'dev1-idp-ca' } })).items
    }
}

describe('K8sManifestBuilder federated served environment', () =>
{
    it('mounts a ca.crt-only Secret read-only and sets NODE_EXTRA_CA_CERTS to it (never the IdP server key)', () =>
    {
        const deployment = FederatedEnv.Items().find((i: any) => i.kind === 'Deployment')
        const pod = deployment.spec.template.spec
        const container = pod.containers[0]
        assert.equal(container.env.find((e: any) => e.name === 'NODE_EXTRA_CA_CERTS').value, '/etc/idp-ca/ca.crt')
        const mount = container.volumeMounts.find((m: any) => m.mountPath === '/etc/idp-ca')
        assert.equal(mount.readOnly, true)
        const volume = pod.volumes.find((v: any) => v.name === mount.name)
        assert.equal(volume.secret.secretName, 'dev1-idp-ca')
        assert.deepEqual(volume.secret.items, [{ key: 'ca.crt', path: 'ca.crt' }])
        assert.ok(!JSON.stringify(deployment).includes('server.key'))
    })

    it('renders one TLS-TERMINATING Ingress for <environmentId>.<baseDomain> to the HTTP env Service', () =>
    {
        const ingresses = FederatedEnv.Items().filter((i: any) => i.kind === 'Ingress')
        assert.equal(ingresses.length, 1)
        const ing = ingresses[0]
        // The env server speaks HTTP, so the ingress must TERMINATE TLS (tls section), NOT passthrough
        // (passthrough would hand raw TLS to an HTTP backend and break the browser handshake).
        assert.equal(ing.metadata.annotations?.['nginx.ingress.kubernetes.io/ssl-passthrough'], undefined)
        assert.deepEqual(ing.spec.tls, [{ hosts: ['env-dev1-id.hive.test'] }])
        assert.equal(ing.spec.ingressClassName, 'nginx')
        assert.equal(ing.spec.rules[0].host, 'env-dev1-id.hive.test')
        assert.equal(ing.spec.rules[0].http.paths[0].backend.service.name, K8sManifestBuilder.ServerDeploymentOf('dev1'))
        assert.equal(ing.spec.rules[0].http.paths[0].backend.service.port.number, 8080)
    })

    it('a non-federated env has no Ingress, no CA mount and no NODE_EXTRA_CA_CERTS', () =>
    {
        const items = Fixture.Items(false)
        assert.ok(items.every((i: any) => i.kind !== 'Ingress'))
        const text = JSON.stringify(items)
        assert.ok(!text.includes('NODE_EXTRA_CA_CERTS'))
        assert.ok(!text.includes('/etc/idp-ca'))
    })
})
