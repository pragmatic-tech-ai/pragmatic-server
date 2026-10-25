import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { TenantAdminWorkloadSpec } from '../tenant-admin-workload.js'

class TenantAdminFixture
{
    public static readonly TokenValue = 'raw-agent-token-value'

    public static Spec(): TenantAdminWorkloadSpec
    {
        return {
            tenantId: 'acme',
            hiveId: 'hive-a',
            image: 'pragmatic-server:dev',
            port: 8443,
            baseDomain: 'tenants.test',
            externalScheme: 'https',
            seedSecretName: 'acme-tenant-admin-seed',
            agentTokenSecretName: 'agent-token-secret',
            rolloutUrl: 'http://channel.example:7000',
        }
    }

    public static Items(spec: TenantAdminWorkloadSpec = TenantAdminFixture.Spec()): any[]
    {
        const doc = JSON.parse(new K8sManifestBuilder().RenderTenantAdmin(spec))
        assert.equal(doc.apiVersion, 'v1')
        assert.equal(doc.kind, 'List')
        return doc.items
    }

    public static Of(kind: string): any
    {
        const found = TenantAdminFixture.Items().filter(i => i.kind === kind)
        assert.equal(found.length, 1)
        return found[0]
    }
}

describe('K8sManifestBuilder.RenderTenantAdmin', () =>
{
    it('emits the shared Namespace first (unlabeled), then SA, PVC, Deployment and Service; no RBAC', () =>
    {
        const items = TenantAdminFixture.Items()
        assert.deepEqual(items.map(i => i.kind), ['Namespace', 'ServiceAccount', 'PersistentVolumeClaim', 'Deployment', 'Service'])
        assert.equal(items[0].metadata.name, 'pragmatic-system')
        assert.equal(items[0].metadata.labels, undefined)
        for (const i of items.slice(1))
        {
            assert.equal(i.metadata.namespace, 'pragmatic-system')
            assert.equal(i.metadata.labels['pragmatic/hive'], 'hive-a')
            assert.equal(i.metadata.labels['pragmatic/environment'], undefined)
        }
    })

    it('names the objects by tenant', () =>
    {
        assert.equal(K8sManifestBuilder.TenantAdminNameOf('acme'), 'pragmatic-tenant-admin-acme')
        assert.equal(TenantAdminFixture.Of('Deployment').metadata.name, 'pragmatic-tenant-admin-acme')
        assert.equal(TenantAdminFixture.Of('Service').metadata.name, 'pragmatic-tenant-admin-acme')
    })

    it('runs the tenant-admin entrypoint hardened: non-root, no caps, seccomp, read-only rootfs, no API token', () =>
    {
        const pod = TenantAdminFixture.Of('Deployment').spec.template.spec
        const c = pod.containers[0]
        assert.deepEqual(c.command, ['node', 'dist-tenant-admin/src/bin/pragmatic-tenant-admind.js'])
        assert.equal(c.securityContext.runAsNonRoot, true)
        assert.equal(c.securityContext.allowPrivilegeEscalation, false)
        assert.deepEqual(c.securityContext.capabilities, { drop: ['ALL'] })
        assert.deepEqual(c.securityContext.seccompProfile, { type: 'RuntimeDefault' })
        assert.equal(c.securityContext.readOnlyRootFilesystem, true)
        assert.equal(pod.automountServiceAccountToken, false)
        assert.equal(pod.securityContext.fsGroup, c.securityContext.runAsUser)
    })

    it('env carries data root, port, bind, domain, scheme, secure cookie, rollout url and hive; token only by Secret ref', () =>
    {
        const c = TenantAdminFixture.Of('Deployment').spec.template.spec.containers[0]
        const literal = (n: string): string | undefined => c.env.find((e: any) => e.name === n)?.value
        assert.equal(literal('PRAGMATIC_TENANT_ADMIN_DATA_ROOT'), '/data')
        assert.equal(literal('PRAGMATIC_TENANT_ADMIN_PORT'), '8443')
        assert.equal(literal('PRAGMATIC_TENANT_ADMIN_BIND'), '0.0.0.0')
        assert.equal(literal('PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'), 'tenants.test')
        assert.equal(literal('PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME'), 'https')
        assert.equal(literal('PRAGMATIC_TENANT_ADMIN_SECURE_COOKIE'), 'true')
        assert.equal(literal('PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL'), 'http://channel.example:7000')
        assert.equal(literal('PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID'), 'hive-a')
        const token = c.env.find((e: any) => e.name === 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN')
        assert.equal(token.value, undefined)
        assert.deepEqual(token.valueFrom, { secretKeyRef: { name: 'agent-token-secret', key: 'token' } })
    })

    it('secure cookie is off for a plain-http scheme', () =>
    {
        const c = TenantAdminFixture.Items({ ...TenantAdminFixture.Spec(), externalScheme: 'http' })[3].spec.template.spec.containers[0]
        assert.equal(c.env.find((e: any) => e.name === 'PRAGMATIC_TENANT_ADMIN_SECURE_COOKIE').value, 'false')
    })

    it('mounts the seed Secret read-only (0440) and an init container copies it into the PVC-backed data root', () =>
    {
        const pod = TenantAdminFixture.Of('Deployment').spec.template.spec
        const seedVol = pod.volumes.find((v: any) => v.secret?.secretName === 'acme-tenant-admin-seed')
        assert.equal(seedVol.secret.defaultMode, 0o440)
        const dataVol = pod.volumes.find((v: any) => v.persistentVolumeClaim !== undefined)
        assert.equal(dataVol.persistentVolumeClaim.claimName, K8sManifestBuilder.TenantAdminClaimNameOf('acme'))
        assert.equal(TenantAdminFixture.Of('PersistentVolumeClaim').metadata.name, K8sManifestBuilder.TenantAdminClaimNameOf('acme'))
        const init = pod.initContainers[0]
        assert.equal(init.volumeMounts.find((m: any) => m.name === seedVol.name).readOnly, true)
        assert.ok(init.volumeMounts.some((m: any) => m.name === dataVol.name && m.mountPath === '/data'))
        assert.equal(init.securityContext.runAsNonRoot, true)
        assert.ok(pod.containers[0].volumeMounts.some((m: any) => m.name === dataVol.name && m.mountPath === '/data'))
    })

    it('readiness probes the SPA root with the tenant Host header', () =>
    {
        const probe = TenantAdminFixture.Of('Deployment').spec.template.spec.containers[0].readinessProbe
        assert.equal(probe.httpGet.path, '/')
        assert.equal(probe.httpGet.port, 8443)
        assert.deepEqual(probe.httpGet.httpHeaders, [{ name: 'Host', value: 'acme.tenants.test' }])
    })

    it('Service is a ClusterIP on the tenant port selecting the deployment', () =>
    {
        const svc = TenantAdminFixture.Of('Service')
        assert.equal(svc.spec.type, 'ClusterIP')
        assert.deepEqual(svc.spec.ports, [{ port: 8443, targetPort: 8443 }])
        assert.deepEqual(svc.spec.selector, TenantAdminFixture.Of('Deployment').spec.selector.matchLabels)
    })

    it('adds imagePullSecrets only when a pull credential is named', () =>
    {
        assert.equal(TenantAdminFixture.Of('Deployment').spec.template.spec.imagePullSecrets, undefined)
        const withPull = TenantAdminFixture.Items({ ...TenantAdminFixture.Spec(), imagePullSecretName: 'pull-cred' })[3]
        assert.deepEqual(withPull.spec.template.spec.imagePullSecrets, [{ name: 'pull-cred' }])
    })

    it('never inlines secret values: no Secret object, and the raw token never appears', () =>
    {
        const text = new K8sManifestBuilder().RenderTenantAdmin(TenantAdminFixture.Spec())
        assert.ok(!text.includes(TenantAdminFixture.TokenValue))
        assert.ok(!JSON.parse(text).items.some((i: any) => i.kind === 'Secret'))
    })
})
