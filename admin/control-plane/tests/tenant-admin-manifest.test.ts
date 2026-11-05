import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { TenantAdminWorkloadSpec } from '../tenant-admin-workload.js'
import { TenantAdminBootstrap } from '../tenant-admin-bootstrap.js'
import { IngressTlsSource, type IngressTls } from '../ingress-tls.js'
import { TenantConsoleAdmission } from '../tenant-console-admission.js'
import { InClusterIdpSeedSource } from '../in-cluster-idp-seed.js'

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
    it('emits the shared Namespace first (unlabeled), then SA, console RBAC, PVC, Deployment and Service; no Ingress', () =>
    {
        const items = TenantAdminFixture.Items()
        assert.deepEqual(items.map(i => i.kind), ['Namespace', 'ServiceAccount', 'ClusterRole', 'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'ClusterRoleBinding', 'ClusterRole', 'PersistentVolumeClaim', 'Deployment', 'Service'])
        assert.equal(items[0].metadata.name, 'pragmatic-system')
        assert.equal(items[0].metadata.labels, undefined)
        for (const i of items.slice(1))
        {
            const clusterScoped = ['ClusterRole', 'ClusterRoleBinding', 'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding'].includes(i.kind)
            assert.equal(i.metadata.namespace, clusterScoped ? undefined : 'pragmatic-system')
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

    it('runs the tenant-admin entrypoint hardened: non-root, no caps, seccomp, read-only rootfs, API token mounted for the console', () =>
    {
        const pod = TenantAdminFixture.Of('Deployment').spec.template.spec
        const c = pod.containers[0]
        assert.deepEqual(c.command, ['node', 'dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js'])
        assert.equal(c.securityContext.runAsNonRoot, true)
        assert.equal(c.securityContext.allowPrivilegeEscalation, false)
        assert.deepEqual(c.securityContext.capabilities, { drop: ['ALL'] })
        assert.deepEqual(c.securityContext.seccompProfile, { type: 'RuntimeDefault' })
        assert.equal(c.securityContext.readOnlyRootFilesystem, true)
        assert.equal(pod.automountServiceAccountToken, true)
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
        const c = TenantAdminFixture.Items({ ...TenantAdminFixture.Spec(), externalScheme: 'http' }).find(i => i.kind === 'Deployment').spec.template.spec.containers[0]
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
        const withPull = TenantAdminFixture.Items({ ...TenantAdminFixture.Spec(), imagePullSecretName: 'pull-cred' }).find(i => i.kind === 'Deployment')
        assert.deepEqual(withPull.spec.template.spec.imagePullSecrets, [{ name: 'pull-cred' }])
    })

    it('never inlines secret values: no Secret object, and the raw token never appears', () =>
    {
        const text = new K8sManifestBuilder().RenderTenantAdmin(TenantAdminFixture.Spec())
        assert.ok(!text.includes(TenantAdminFixture.TokenValue))
        assert.ok(!JSON.parse(text).items.some((i: any) => i.kind === 'Secret'))
    })
})

class IdpInjectionFixture
{
    public static readonly CaBytes = 'RAW-CA-PEM-BYTES'
    public static readonly TokenBytes = 'raw-idp-admin-token'

    public static Spec(): TenantAdminWorkloadSpec
    {
        return {
            ...TenantAdminFixture.Spec(),
            idp: {
                browserBaseUrl: 'https://idp-acme.tenants.test',
                internalBaseUrl: 'https://pragmatic-idp-acme.pragmatic-system.svc:8443',
                caSecretName: 'acme-idp-ca',
                adminTokenSecretName: 'acme-idp-admin',
            },
        }
    }
}

describe('K8sManifestBuilder.RenderTenantAdmin IdP injection', () =>
{
    it('omits all IdP env and mounts when no idp is given', () =>
    {
        const dep = TenantAdminFixture.Of('Deployment')
        const c = dep.spec.template.spec.containers[0]
        assert.equal(c.env.filter((e: any) => e.name.startsWith('PRAGMATIC_IDP_')).length, 0)
        assert.equal(dep.spec.template.spec.volumes.length, 3)
    })

    it('injects PRAGMATIC_IDP_* env and read-only Secret mounts by ref, never inline bytes', () =>
    {
        const text = new K8sManifestBuilder().RenderTenantAdmin(IdpInjectionFixture.Spec())
        assert.ok(!text.includes(IdpInjectionFixture.CaBytes))
        assert.ok(!text.includes(IdpInjectionFixture.TokenBytes))
        const dep = JSON.parse(text).items.find((i: any) => i.kind === 'Deployment')
        const pod = dep.spec.template.spec
        const c = pod.containers[0]
        const env = (n: string): string => c.env.find((e: any) => e.name === n).value
        assert.equal(env('PRAGMATIC_IDP_BROWSER_BASE_URL'), 'https://idp-acme.tenants.test')
        assert.equal(env('PRAGMATIC_IDP_BASE_URL'), 'https://pragmatic-idp-acme.pragmatic-system.svc:8443')
        assert.equal(env('PRAGMATIC_IDP_CA_FILE'), '/idp/ca/ca.crt')
        assert.equal(env('PRAGMATIC_IDP_ADMIN_TOKEN_FILE'), '/idp/token/admin-token')
        const secrets = pod.volumes.filter((v: any) => v.secret).map((v: any) => v.secret.secretName)
        assert.ok(secrets.includes('acme-idp-ca'))
        assert.ok(secrets.includes('acme-idp-admin'))
        const mounts = c.volumeMounts.filter((m: any) => m.mountPath.startsWith('/idp/'))
        assert.equal(mounts.length, 2)
        assert.ok(mounts.every((m: any) => m.readOnly === true))
        // The pod only REFERENCES Secrets by name — it never embeds a Secret object (no bytes to leak).
        assert.ok(!JSON.parse(text).items.some((i: any) => i.kind === 'Secret'))
        // SERVER-KEY SAFETY: the CA/token volumes project ONLY ca.crt / admin-token via `items`, so mounting a
        // Secret that also held server.key could still never expose it.
        const vol = (name: string): any => pod.volumes.find((v: any) => v.name === name)
        assert.deepEqual(vol('idp-ca').secret.items, [{ key: 'ca.crt', path: 'ca.crt' }])
        assert.deepEqual(vol('idp-token').secret.items, [{ key: 'admin-token', path: 'admin-token' }])
    })
})

class ConsoleFixture
{
    public static readonly Host = 'console-acme.localtest.me'
    public static readonly ExistingSecret: IngressTls = { source: IngressTlsSource.ExistingSecret, secretName: 'acme-wildcard' }

    public static Spec(ingressTls: IngressTls = { source: IngressTlsSource.Development }): TenantAdminWorkloadSpec
    {
        return { ...TenantAdminFixture.Spec(), console: { host: ConsoleFixture.Host, ingressTls } }
    }

    public static Items(spec: TenantAdminWorkloadSpec = ConsoleFixture.Spec()): any[]
    {
        return JSON.parse(new K8sManifestBuilder().RenderTenantAdmin(spec)).items
    }

    public static Env(spec: TenantAdminWorkloadSpec, name: string): string | undefined
    {
        const c = ConsoleFixture.Items(spec).find(i => i.kind === 'Deployment').spec.template.spec.containers[0]
        return c.env.find((e: any) => e.name === name)?.value
    }

    public static IdOf(item: any): string
    {
        return `${item.kind}/${item.metadata.namespace ?? '-'}/${item.metadata.name}`
    }

    public static Removal(): any[]
    {
        return JSON.parse(new K8sManifestBuilder().TenantConsoleRemovalManifest('acme', 'hive-a')).items
    }
}

describe('K8sManifestBuilder.RenderTenantAdmin console exposure and RBAC', () =>
{
    it('names the console statics', () =>
    {
        assert.equal(K8sManifestBuilder.EnvNamespacePrefix, 'pragmatic-env-')
        assert.equal(K8sManifestBuilder.NamespaceOf('e1'), 'pragmatic-env-e1')
        assert.equal(K8sManifestBuilder.TenantConsoleEnvBindingName, 'pragmatic-tenant-console')
        assert.equal(K8sManifestBuilder.FingerprintKeyFilePath, '/fingerprint/fingerprint.key')
        assert.equal(K8sManifestBuilder.ConsoleHostOf('acme', 'localtest.me'), 'console-acme.localtest.me')
        assert.equal(K8sManifestBuilder.TenantConsoleEnvRoleNameOf('acme'), 'pragmatic-tenant-admin-acme-env')
        assert.equal(K8sManifestBuilder.TenantConsoleTlsRoleNameOf('acme'), 'pragmatic-tenant-admin-acme-tls')
        assert.equal(K8sManifestBuilder.TenantConsoleFingerprintSecretNameOf('acme'), 'pragmatic-tenant-admin-acme-fingerprint')
        assert.equal(K8sManifestBuilder.TenantConsoleIdpCaSecretNameOf('acme'), 'pragmatic-tenant-admin-acme-idp-ca')
        assert.equal(K8sManifestBuilder.TenantConsoleIdpTokenSecretNameOf('acme'), 'pragmatic-tenant-admin-acme-idp-token')
        assert.equal(K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf('acme'), 'pragmatic-tenant-admin-acme-dev-tls')
        assert.equal(TenantAdminBootstrap.IdpCaSecretNameOf('acme'), K8sManifestBuilder.TenantConsoleIdpCaSecretNameOf('acme'))
        assert.equal(TenantAdminBootstrap.IdpTokenSecretNameOf('acme'), K8sManifestBuilder.TenantConsoleIdpTokenSecretNameOf('acme'))
    })

    it('renders in order: Namespace, SA, console ClusterRole, admission fence, its binding, env ClusterRole, TLS Role, PVC, Deployment, Service, Ingress', () =>
    {
        assert.deepEqual(ConsoleFixture.Items(ConsoleFixture.Spec(ConsoleFixture.ExistingSecret)).map(i => i.kind), [
            'Namespace', 'ServiceAccount', 'ClusterRole', 'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'ClusterRoleBinding', 'ClusterRole', 'Role', 'RoleBinding',
            'PersistentVolumeClaim', 'Deployment', 'Service', 'Ingress', 'NetworkPolicy',
        ])
    })

    it('with a console exposure, a NetworkPolicy admits only the ingress controller namespace to the console port (its forwarded-for header is trusted)', () =>
    {
        const items = ConsoleFixture.Items()
        const policy = items.find(i => i.kind === 'NetworkPolicy')
        const pod = items.find(i => i.kind === 'Deployment').spec.template.metadata.labels
        assert.equal(policy.apiVersion, 'networking.k8s.io/v1')
        assert.deepEqual(policy.metadata, { name: 'pragmatic-tenant-admin-acme', namespace: 'pragmatic-system', labels: { 'pragmatic/hive': 'hive-a' } })
        assert.deepEqual(policy.spec, {
            podSelector: { matchLabels: pod },
            policyTypes: ['Ingress'],
            ingress: [{
                from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' } } }],
                ports: [{ protocol: 'TCP', port: TenantAdminFixture.Spec().port }],
            }],
        })
        assert.equal(ConsoleFixture.Env(ConsoleFixture.Spec(), 'PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY'), 'true')
    })

    it('the NetworkPolicy admits the configured ingress controller namespace', () =>
    {
        const spec: TenantAdminWorkloadSpec = { ...TenantAdminFixture.Spec(), console: { host: ConsoleFixture.Host, ingressTls: { source: IngressTlsSource.Development }, ingressNamespace: 'kube-system' } }
        const policy = ConsoleFixture.Items(spec).find(i => i.kind === 'NetworkPolicy')
        assert.deepEqual(policy.spec.ingress[0].from, [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }])
    })

    it('without a console exposure there is no Ingress, no trusted proxy and no NetworkPolicy', () =>
    {
        assert.ok(!TenantAdminFixture.Items().some((i: any) => i.kind === 'NetworkPolicy' || i.kind === 'Ingress'))
    })

    it('console ServiceAccount and pod mount the token', () =>
    {
        assert.equal(TenantAdminFixture.Of('ServiceAccount').automountServiceAccountToken, true)
        assert.equal(TenantAdminFixture.Of('Deployment').spec.template.spec.automountServiceAccountToken, true)
    })

    it('console ClusterRole grants only namespaces get/create/delete, rolebindings create and bind on its env role', () =>
    {
        const items = TenantAdminFixture.Items()
        const role = items.find(i => i.kind === 'ClusterRole' && i.metadata.name === 'pragmatic-tenant-admin-acme')
        assert.equal(role.metadata.labels['pragmatic/hive'], 'hive-a')
        assert.equal(role.metadata.namespace, undefined)
        assert.deepEqual(role.rules, [
            { apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'create', 'delete'] },
            { apiGroups: ['rbac.authorization.k8s.io'], resources: ['rolebindings'], verbs: ['create'] },
            { apiGroups: ['rbac.authorization.k8s.io'], resources: ['clusterroles'], verbs: ['bind'], resourceNames: ['pragmatic-tenant-admin-acme-env'] },
        ])
        const binding = items.find(i => i.kind === 'ClusterRoleBinding')
        assert.equal(binding.metadata.name, 'pragmatic-tenant-admin-acme')
        assert.equal(binding.metadata.labels['pragmatic/hive'], 'hive-a')
        assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'pragmatic-tenant-admin-acme', namespace: 'pragmatic-system' }])
        assert.deepEqual(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'pragmatic-tenant-admin-acme' })
    })

    it('env ClusterRole carries the environment resources and is hive-labelled', () =>
    {
        const role = TenantAdminFixture.Items().find(i => i.kind === 'ClusterRole' && i.metadata.name === K8sManifestBuilder.TenantConsoleEnvRoleNameOf('acme'))
        assert.equal(role.metadata.labels['pragmatic/hive'], 'hive-a')
        assert.deepEqual(role.rules, [
            { apiGroups: [''], resources: ['secrets', 'configmaps', 'services', 'persistentvolumeclaims'], verbs: ['*'] },
            { apiGroups: ['apps'], resources: ['deployments', 'deployments/scale', 'statefulsets', 'statefulsets/scale'], verbs: ['*'] },
            { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['*'] },
        ])
    })

    it('env ClusterRole is never bound cluster-wide', () =>
    {
        const envRole = K8sManifestBuilder.TenantConsoleEnvRoleNameOf('acme')
        for (const spec of [TenantAdminFixture.Spec(), ConsoleFixture.Spec(), ConsoleFixture.Spec(ConsoleFixture.ExistingSecret)])
        {
            const items = ConsoleFixture.Items(spec)
            assert.ok(!items.some(i => i.kind === 'ClusterRoleBinding' && i.roleRef.name === envRole))
            assert.ok(!items.some(i => i.kind === 'RoleBinding' && i.roleRef.name === envRole))
        }
    })

    it('no Ingress without console exposure', () =>
    {
        const items = TenantAdminFixture.Items()
        assert.ok(!items.some(i => i.kind === 'Ingress'))
        assert.ok(!items.some(i => i.kind === 'Role' || i.kind === 'RoleBinding'))
        const spec = TenantAdminFixture.Spec()
        assert.equal(ConsoleFixture.Env(spec, 'PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST'), undefined)
        assert.equal(ConsoleFixture.Env(spec, 'PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY'), undefined)
        assert.equal(ConsoleFixture.Env(spec, 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SOURCE'), undefined)
    })

    it('Ingress on the console host', () =>
    {
        const items = ConsoleFixture.Items()
        const ingress = items.find(i => i.kind === 'Ingress')
        assert.equal(ingress.metadata.name, 'pragmatic-tenant-admin-acme')
        assert.equal(ingress.metadata.namespace, 'pragmatic-system')
        assert.equal(ingress.metadata.labels['pragmatic/hive'], 'hive-a')
        assert.equal(ingress.metadata.annotations, undefined)
        assert.equal(ingress.spec.ingressClassName, 'nginx')
        assert.deepEqual(ingress.spec.tls, [{ hosts: [ConsoleFixture.Host], secretName: 'pragmatic-tenant-admin-acme-dev-tls' }])
        assert.equal(ingress.spec.rules[0].host, ConsoleFixture.Host)
        const path = ingress.spec.rules[0].http.paths[0]
        assert.equal(path.path, '/')
        assert.equal(path.pathType, 'Prefix')
        assert.deepEqual(path.backend.service, { name: 'pragmatic-tenant-admin-acme', port: { number: 8443 } })
        // Development TLS uses this tenant's own copy, which the console also copies on, so it gets the get-only Role on it.
        assert.deepEqual(items.find(i => i.kind === 'Role').rules[0].resourceNames, ['pragmatic-tenant-admin-acme-dev-tls'])
    })

    it('cert-manager console Ingress carries the issuer and a generated Secret name', () =>
    {
        const items = ConsoleFixture.Items(ConsoleFixture.Spec({ source: IngressTlsSource.CertManager, clusterIssuer: 'letsencrypt' }))
        const ingress = items.find(i => i.kind === 'Ingress')
        assert.deepEqual(ingress.metadata.annotations, { 'cert-manager.io/cluster-issuer': 'letsencrypt' })
        assert.equal(ingress.spec.tls[0].secretName, 'pragmatic-tenant-admin-acme-ingress-tls')
        assert.ok(!items.some(i => i.kind === 'Role' || i.kind === 'RoleBinding'))
    })

    it('existing-secret renders a get-only Role on that one Secret', () =>
    {
        const items = ConsoleFixture.Items(ConsoleFixture.Spec(ConsoleFixture.ExistingSecret))
        const role = items.find(i => i.kind === 'Role')
        assert.equal(role.metadata.name, 'pragmatic-tenant-admin-acme-tls')
        assert.equal(role.metadata.namespace, 'pragmatic-system')
        assert.equal(role.metadata.labels['pragmatic/hive'], 'hive-a')
        assert.deepEqual(role.rules, [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'], resourceNames: ['acme-wildcard'] }])
        const binding = items.find(i => i.kind === 'RoleBinding')
        assert.equal(binding.metadata.name, 'pragmatic-tenant-admin-acme-tls')
        assert.equal(binding.metadata.namespace, 'pragmatic-system')
        assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'pragmatic-tenant-admin-acme', namespace: 'pragmatic-system' }])
        assert.deepEqual(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'pragmatic-tenant-admin-acme-tls' })
        assert.equal(items.find(i => i.kind === 'Ingress').spec.tls[0].secretName, 'acme-wildcard')
    })

    it('console env carries host, trusted proxy and TLS settings', () =>
    {
        const spec = ConsoleFixture.Spec(ConsoleFixture.ExistingSecret)
        assert.equal(ConsoleFixture.Env(spec, 'PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST'), ConsoleFixture.Host)
        assert.equal(ConsoleFixture.Env(spec, 'PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY'), 'true')
        assert.equal(ConsoleFixture.Env(spec, 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SOURCE'), 'existing-secret')
        assert.equal(ConsoleFixture.Env(spec, 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SECRET'), 'acme-wildcard')
        assert.equal(ConsoleFixture.Env(spec, 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_ISSUER'), undefined)
        const cm = ConsoleFixture.Spec({ source: IngressTlsSource.CertManager, clusterIssuer: 'letsencrypt' })
        assert.equal(ConsoleFixture.Env(cm, 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SOURCE'), 'cert-manager')
        assert.equal(ConsoleFixture.Env(cm, 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_ISSUER'), 'letsencrypt')
    })

    it('fingerprint key mounted read-only', () =>
    {
        assert.ok(!TenantAdminFixture.Of('Deployment').spec.template.spec.volumes.some((v: any) => v.name === 'fingerprint'))
        assert.equal(ConsoleFixture.Env(TenantAdminFixture.Spec(), 'PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE'), undefined)
        const spec: TenantAdminWorkloadSpec = { ...TenantAdminFixture.Spec(), fingerprintKeySecretName: 'pragmatic-tenant-admin-acme-fingerprint' }
        const pod = ConsoleFixture.Items(spec).find(i => i.kind === 'Deployment').spec.template.spec
        const vol = pod.volumes.find((v: any) => v.name === 'fingerprint')
        assert.equal(vol.secret.secretName, 'pragmatic-tenant-admin-acme-fingerprint')
        assert.deepEqual(vol.secret.items, [{ key: 'fingerprint.key', path: 'fingerprint.key' }])
        const mount = pod.containers[0].volumeMounts.find((m: any) => m.name === 'fingerprint')
        assert.equal(mount.mountPath, '/fingerprint')
        assert.equal(mount.readOnly, true)
        assert.equal(ConsoleFixture.Env(spec, 'PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE'), '/fingerprint/fingerprint.key')
    })

    it('removal manifest names the cluster-scoped RBAC and keeps PVC and seed', () =>
    {
        const text = new K8sManifestBuilder().TenantConsoleRemovalManifest('acme', 'hive-a')
        const doc = JSON.parse(text)
        assert.equal(doc.apiVersion, 'v1')
        assert.equal(doc.kind, 'List')
        assert.deepEqual(doc.items.map(ConsoleFixture.IdOf), [
            'ServiceAccount/pragmatic-system/pragmatic-tenant-admin-acme',
            'ClusterRole/-/pragmatic-tenant-admin-acme',
            'ValidatingAdmissionPolicy/-/pragmatic-tenant-admin-acme',
            'ValidatingAdmissionPolicyBinding/-/pragmatic-tenant-admin-acme',
            'ClusterRoleBinding/-/pragmatic-tenant-admin-acme',
            'ClusterRole/-/pragmatic-tenant-admin-acme-env',
            'Role/pragmatic-system/pragmatic-tenant-admin-acme-tls',
            'RoleBinding/pragmatic-system/pragmatic-tenant-admin-acme-tls',
            'Deployment/pragmatic-system/pragmatic-tenant-admin-acme',
            'Service/pragmatic-system/pragmatic-tenant-admin-acme',
            'Ingress/pragmatic-system/pragmatic-tenant-admin-acme',
            'NetworkPolicy/pragmatic-system/pragmatic-tenant-admin-acme',
            'Secret/pragmatic-system/pragmatic-tenant-admin-acme-fingerprint',
            'Secret/pragmatic-system/pragmatic-tenant-admin-acme-idp-ca',
            'Secret/pragmatic-system/pragmatic-tenant-admin-acme-idp-token',
            'Secret/pragmatic-system/pragmatic-tenant-admin-acme-dev-tls',
            'Deployment/pragmatic-idp-acme/pragmatic-idp-acme',
            'Service/pragmatic-idp-acme/pragmatic-idp-acme',
            'Ingress/pragmatic-idp-acme/pragmatic-idp-acme',
        ])
        for (const item of doc.items)
        {
            assert.deepEqual(Object.keys(item).sort(), ['apiVersion', 'kind', 'metadata'])
            assert.deepEqual(Object.keys(item.metadata).sort(), item.metadata.namespace === undefined ? ['name'] : ['name', 'namespace'])
        }
        assert.ok(!doc.items.some((i: any) => i.kind === 'PersistentVolumeClaim' || i.kind === 'Namespace'))
        assert.ok(!text.includes(K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme')))
    })

    it('removal manifest for a cluster that does not serve the admission policy kind names everything else, the same way', () =>
    {
        const full = ConsoleFixture.Removal().map(ConsoleFixture.IdOf)
        const old = JSON.parse(new K8sManifestBuilder().TenantConsoleRemovalManifest('acme', 'hive-a', false)).items.map(ConsoleFixture.IdOf)
        assert.deepEqual(old, full.filter((id: string) => !id.startsWith('ValidatingAdmissionPolicy')))
        assert.equal(full.length - old.length, 2)
    })

    it('removal manifest stops the in-hive IdP (Deployment, Service, Ingress) and keeps its namespace, data volume and Secrets', () =>
    {
        const removal = ConsoleFixture.Removal()
        const idp = K8sManifestBuilder.IdpNameOf('acme')
        const inIdp = removal.filter((i: any) => i.metadata.namespace === idp).map((i: any) => i.kind).sort()
        assert.deepEqual(inIdp, ['Deployment', 'Ingress', 'Service'])
        const text = JSON.stringify(removal)
        for (const kept of [K8sManifestBuilder.IdpClaimNameOf('acme'), InClusterIdpSeedSource.TlsSecretNameOf('acme'), InClusterIdpSeedSource.AdminSecretNameOf('acme')])
        {
            assert.ok(!text.includes('"' + kept + '"'), kept)
        }
        assert.ok(!removal.some((i: any) => i.kind === 'Namespace' || i.kind === 'ServiceAccount' && i.metadata.namespace === idp))
    })

    it('every rendered object except Namespace and PVC is named by the removal manifest', () =>
    {
        const removal = ConsoleFixture.Removal().map(ConsoleFixture.IdOf)
        const spec: TenantAdminWorkloadSpec = { ...ConsoleFixture.Spec(ConsoleFixture.ExistingSecret), fingerprintKeySecretName: 'x' }
        for (const item of ConsoleFixture.Items(spec).filter(i => i.kind !== 'Namespace' && i.kind !== 'PersistentVolumeClaim'))
        {
            assert.ok(removal.includes(ConsoleFixture.IdOf(item)), ConsoleFixture.IdOf(item))
        }
    })

    it('credential removal shares the console Secret identity list', () =>
    {
        const credential = K8sManifestBuilder.TenantConsoleCredentialIdentitiesOf('acme')
        const consoleSecrets = ConsoleFixture.Removal().filter((i: any) => i.kind === 'Secret' && i.metadata.name !== K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf('acme'))
        assert.deepEqual(credential, consoleSecrets)
    })

    it('never references the cluster-shared development TLS Secret', () =>
    {
        const rendered = new K8sManifestBuilder().RenderTenantAdmin(ConsoleFixture.Spec())
        const removal = new K8sManifestBuilder().TenantConsoleRemovalManifest('acme', 'hive-a')
        assert.ok(!rendered.includes('"pragmatic-dev-tls"'))
        assert.ok(!removal.includes('"pragmatic-dev-tls"'))
    })
})

class AdmissionFixture
{
    public static readonly User = "request.userInfo.username == 'system:serviceaccount:pragmatic-system:pragmatic-tenant-admin-acme'"
    public static readonly NamespaceCreate = "request.resource.resource != 'namespaces' || request.operation != 'CREATE' || (object.metadata.name.startsWith('pragmatic-env-') && has(object.metadata.labels) && 'pragmatic/hive' in object.metadata.labels && object.metadata.labels['pragmatic/hive'] == 'hive-a' && 'pod-security.kubernetes.io/enforce' in object.metadata.labels && object.metadata.labels['pod-security.kubernetes.io/enforce'] in ['baseline', 'restricted'])"
    public static readonly NamespaceChange = "request.resource.resource != 'namespaces' || request.operation == 'CREATE' || (oldObject.metadata.name.startsWith('pragmatic-env-') && has(oldObject.metadata.labels) && 'pragmatic/hive' in oldObject.metadata.labels && oldObject.metadata.labels['pragmatic/hive'] == 'hive-a')"
    public static readonly BindingNamespace = "request.resource.resource != 'rolebindings' || (request.namespace.startsWith('pragmatic-env-') && has(namespaceObject.metadata.labels) && 'pragmatic/hive' in namespaceObject.metadata.labels && namespaceObject.metadata.labels['pragmatic/hive'] == 'hive-a' && 'pod-security.kubernetes.io/enforce' in namespaceObject.metadata.labels && namespaceObject.metadata.labels['pod-security.kubernetes.io/enforce'] in ['baseline', 'restricted'])"
    public static readonly BindingName = "request.resource.resource != 'rolebindings' || object.metadata.name == 'pragmatic-tenant-console'"
    public static readonly BindingRole = "request.resource.resource != 'rolebindings' || (object.roleRef.apiGroup == 'rbac.authorization.k8s.io' && object.roleRef.kind == 'ClusterRole' && object.roleRef.name == 'pragmatic-tenant-admin-acme-env')"
    public static readonly BindingSubjects = "request.resource.resource != 'rolebindings' || (has(object.subjects) && size(object.subjects) == 1 && object.subjects[0].kind == 'ServiceAccount' && object.subjects[0].namespace == 'pragmatic-system' && object.subjects[0].name == 'pragmatic-tenant-admin-acme')"

    public static Of(kind: string): any
    {
        return TenantAdminFixture.Items().find(i => i.kind === kind)
    }
}

describe('K8sManifestBuilder.RenderTenantAdmin admission fence', () =>
{
    it('renders a hive-labelled, fail-closed ValidatingAdmissionPolicy matched to the console ServiceAccount only', () =>
    {
        const policy = AdmissionFixture.Of('ValidatingAdmissionPolicy')
        assert.equal(policy.apiVersion, 'admissionregistration.k8s.io/v1')
        assert.equal(policy.metadata.name, 'pragmatic-tenant-admin-acme')
        assert.equal(policy.metadata.namespace, undefined)
        assert.equal(policy.metadata.labels['pragmatic/hive'], 'hive-a')
        assert.equal(policy.spec.failurePolicy, 'Fail')
        assert.deepEqual(policy.spec.matchConstraints, {
            resourceRules: [
                { apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE', 'DELETE'], resources: ['namespaces'] },
                { apiGroups: ['rbac.authorization.k8s.io'], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['rolebindings'] },
            ],
        })
        assert.deepEqual(policy.spec.matchConditions, [{ name: 'console-service-account', expression: AdmissionFixture.User }])
    })

    it('validates namespaces by prefix and hive label, and role bindings by namespace, name, role and exact subject', () =>
    {
        const expressions = AdmissionFixture.Of('ValidatingAdmissionPolicy').spec.validations.map((v: any) => v.expression)
        assert.deepEqual(expressions, [
            AdmissionFixture.NamespaceCreate,
            AdmissionFixture.NamespaceChange,
            AdmissionFixture.BindingNamespace,
            AdmissionFixture.BindingName,
            AdmissionFixture.BindingRole,
            AdmissionFixture.BindingSubjects,
        ])
        for (const v of AdmissionFixture.Of('ValidatingAdmissionPolicy').spec.validations)
        {
            assert.equal(typeof v.message, 'string')
            assert.ok(v.message.length > 0)
        }
    })

    it('binds the policy cluster-wide with Deny, hive-labelled', () =>
    {
        const binding = AdmissionFixture.Of('ValidatingAdmissionPolicyBinding')
        assert.equal(binding.apiVersion, 'admissionregistration.k8s.io/v1')
        assert.equal(binding.metadata.name, 'pragmatic-tenant-admin-acme')
        assert.equal(binding.metadata.labels['pragmatic/hive'], 'hive-a')
        assert.deepEqual(binding.spec, { policyName: 'pragmatic-tenant-admin-acme', validationActions: ['Deny'] })
    })

    it('applies the fence before the cluster-wide grant', () =>
    {
        const kinds = TenantAdminFixture.Items().map(i => i.kind)
        assert.ok(kinds.indexOf('ValidatingAdmissionPolicyBinding') < kinds.indexOf('ClusterRoleBinding'))
        assert.ok(kinds.indexOf('ValidatingAdmissionPolicy') < kinds.indexOf('ValidatingAdmissionPolicyBinding'))
    })

    it('quotes CEL string literals so a value can never break out of the expression', () =>
    {
        assert.equal(TenantConsoleAdmission.CelString('hive-a'), "'hive-a'")
        assert.equal(TenantConsoleAdmission.CelString("a' || true || '"), "'a\\' || true || \\''")
        assert.equal(TenantConsoleAdmission.CelString('a\\b'), "'a\\\\b'")
    })

    it('the removal manifest names the policy and its binding', () =>
    {
        const ids = ConsoleFixture.Removal().map(ConsoleFixture.IdOf)
        assert.ok(ids.includes('ValidatingAdmissionPolicy/-/pragmatic-tenant-admin-acme'))
        assert.ok(ids.includes('ValidatingAdmissionPolicyBinding/-/pragmatic-tenant-admin-acme'))
        const policy = ConsoleFixture.Removal().find((i: any) => i.kind === 'ValidatingAdmissionPolicy')
        assert.equal(policy.apiVersion, 'admissionregistration.k8s.io/v1')
    })
})
