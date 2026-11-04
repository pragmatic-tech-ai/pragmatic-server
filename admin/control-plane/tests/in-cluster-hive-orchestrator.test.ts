import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InClusterHiveOrchestrator, InvalidTlsSourceSecretError } from '../in-cluster-hive-orchestrator.js'
import type { InClusterOrchestration } from '../in-cluster-hive-orchestrator.js'
import { EnvNamespaceRefusedError } from '../env-namespace-guard.js'
import { PinnedImageVerifier } from '../pinned-image-verifier.js'
import { ImageVerificationError } from '../image-verifier.js'
import { EffectiveRegistry } from '../effective-registry.js'
import { KubeApiClient, KubeApiError, KubeContentType, KubeMethod } from '../kube-api-client.js'
import type { IKubeTransport, KubeResponse } from '../kube-api-client.js'
import type { IInstallClock } from '../hive-agent-installer.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { IngressTlsSource } from '../ingress-tls.js'
import type { IngressTls } from '../ingress-tls.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { EnvironmentWorkload } from '../environment-workload.js'

type SentCall = { method: KubeMethod; path: string; type: KubeContentType; body: string | undefined }

/** Answers by a scripted responder (first match wins; one-shot entries are consumed), default 200 '{}'. */
class FakeKubeTransport implements IKubeTransport
{
    public readonly Calls: SentCall[] = []
    private readonly script: Array<{ method: KubeMethod; prefix: string; response: KubeResponse; times: number }> = []

    public On(method: KubeMethod, prefix: string, response: KubeResponse, times: number = Number.POSITIVE_INFINITY): this
    {
        this.script.push({ method, prefix, response, times })
        return this
    }

    public Send(method: KubeMethod, path: string, body: string | undefined, type: KubeContentType): Promise<KubeResponse>
    {
        this.Calls.push({ method, path, type, body })
        const entry = this.script.find(e => e.method === method && path.startsWith(e.prefix) && e.times > 0)
        if (entry === undefined)
        {
            return Promise.resolve({ status: 200, body: '{}' })
        }
        entry.times--
        return Promise.resolve(entry.response)
    }

    public Paths(method: KubeMethod): string[]
    {
        return this.Calls.filter(c => c.method === method).map(c => c.path.split('?')[0])
    }
}

class ImmediateClock implements IInstallClock
{
    public Delays = 0

    public Now(): number
    {
        return 1700000000000
    }

    public Delay(): Promise<void>
    {
        this.Delays++
        return Promise.resolve()
    }
}

class OrchestratorFixture
{
    public static readonly Tenant = 'acme'
    public static readonly Hive = 'h1'
    public static readonly Ns = 'pragmatic-env-a'
    public static readonly NamespacesPath = '/api/v1/namespaces'
    public static readonly NsPath = '/api/v1/namespaces/pragmatic-env-a'
    public static readonly BindingsPath = '/apis/rbac.authorization.k8s.io/v1/namespaces/pragmatic-env-a/rolebindings'
    public static readonly Ref = 'reg:5000/srv:1'

    public static Workload(ingressTls?: IngressTls): EnvironmentWorkload
    {
        const w: EnvironmentWorkload = { environmentName: 'a', environmentId: 'a-id', hiveId: OrchestratorFixture.Hive, image: 'srv:1', serverPort: 8080, env: {}, secretRefs: [] }
        if (ingressTls !== undefined)
        {
            w.federation = { baseDomain: 'example.test', caSecretName: 'pragmatic-env-a-idp-ca', ingressTls }
        }
        return w
    }

    public static Make(verified: string[] = [OrchestratorFixture.Ref]): { t: FakeKubeTransport; clock: ImmediateClock; o: InClusterHiveOrchestrator }
    {
        const t = new FakeKubeTransport()
        const clock = new ImmediateClock()
        const setup: InClusterOrchestration = {
            client: new KubeApiClient(t),
            identity: { tenantId: OrchestratorFixture.Tenant, hiveId: OrchestratorFixture.Hive },
            verifier: new PinnedImageVerifier(verified.map(imageRef => ({ imageRef }))),
        }
        const registry = EffectiveRegistry.For({
            id: OrchestratorFixture.Hive, tenantId: OrchestratorFixture.Tenant, displayName: 'H',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach },
            registry: { mode: InfraMode.Attach, endpoint: 'reg:5000' },
            createdAt: '2026-11-04T00:00:00.000Z',
        })
        return { t, clock, o: new InClusterHiveOrchestrator(setup, registry, 'root-1', clock, { attempts: 3, intervalMs: 0 }) }
    }

    public static Json(status: number, body: object): KubeResponse
    {
        return { status, body: JSON.stringify(body) }
    }

    public static Namespace(labels: Record<string, string> | undefined): KubeResponse
    {
        return OrchestratorFixture.Json(200, { metadata: { name: OrchestratorFixture.Ns, labels } })
    }

    public static Body(call: SentCall | undefined): any
    {
        return JSON.parse(call?.body ?? 'null')
    }
}

test('Apply creates the namespace, then the console RoleBinding, then the rest', async () =>
{
    const { t, o } = OrchestratorFixture.Make()
    await o.Apply(OrchestratorFixture.Workload())
    assert.equal(t.Calls[0].method, KubeMethod.Post)
    assert.equal(t.Calls[0].path, OrchestratorFixture.NamespacesPath)
    assert.equal(t.Calls[1].method, KubeMethod.Post)
    assert.equal(t.Calls[1].path, OrchestratorFixture.BindingsPath)
    const patches = t.Paths(KubeMethod.Patch)
    assert.ok(patches.length > 0)
    assert.ok(!patches.includes(OrchestratorFixture.NsPath))
    assert.ok(patches.every(p => p.includes('/namespaces/pragmatic-env-a/')))
    assert.ok(patches.some(p => p.endsWith('/deployments/pragmatic-env-a-server')))
})

test('the created namespace satisfies the console admission fence', async () =>
{
    const { t, o } = OrchestratorFixture.Make()
    await o.Apply(OrchestratorFixture.Workload())
    const ns = OrchestratorFixture.Body(t.Calls[0])
    assert.equal(ns.apiVersion, 'v1')
    assert.equal(ns.kind, 'Namespace')
    assert.equal(ns.metadata.name, OrchestratorFixture.Ns)
    assert.ok(ns.metadata.name.startsWith(K8sManifestBuilder.EnvNamespacePrefix))
    assert.equal(ns.metadata.labels['pragmatic/hive'], OrchestratorFixture.Hive)
    assert.ok(['baseline', 'restricted'].includes(ns.metadata.labels['pod-security.kubernetes.io/enforce']))
})

test('RoleBinding binds the console ServiceAccount to the env ClusterRole', async () =>
{
    const { t, o } = OrchestratorFixture.Make()
    await o.Apply(OrchestratorFixture.Workload())
    const rb = OrchestratorFixture.Body(t.Calls[1])
    assert.equal(rb.metadata.name, 'pragmatic-tenant-console')
    assert.equal(rb.metadata.namespace, OrchestratorFixture.Ns)
    assert.deepEqual(rb.metadata.labels, { 'pragmatic/hive': OrchestratorFixture.Hive })
    assert.deepEqual(rb.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'pragmatic-tenant-admin-acme-env' })
    assert.deepEqual(rb.subjects, [{ kind: 'ServiceAccount', name: 'pragmatic-tenant-admin-acme', namespace: 'pragmatic-system' }])
})

test('Apply over an existing own namespace and binding (409) carries on without patching the namespace', async () =>
{
    const { t, o } = OrchestratorFixture.Make()
    t.On(KubeMethod.Post, OrchestratorFixture.NamespacesPath, OrchestratorFixture.Json(409, {}), 1)
    t.On(KubeMethod.Get, OrchestratorFixture.NsPath, OrchestratorFixture.Namespace({ 'pragmatic/hive': OrchestratorFixture.Hive }))
    t.On(KubeMethod.Post, OrchestratorFixture.BindingsPath, OrchestratorFixture.Json(409, {}))
    await o.Apply(OrchestratorFixture.Workload())
    assert.ok(t.Paths(KubeMethod.Patch).length > 0)
    assert.ok(!t.Paths(KubeMethod.Patch).includes(OrchestratorFixture.NsPath))
})

test('Apply retries a 403 right after binding', async () =>
{
    const once = OrchestratorFixture.Make()
    once.t.On(KubeMethod.Patch, '/', OrchestratorFixture.Json(403, { message: 'forbidden' }), 1)
    await once.o.Apply(OrchestratorFixture.Workload())
    assert.equal(once.clock.Delays, 1)

    const always = OrchestratorFixture.Make()
    always.t.On(KubeMethod.Patch, '/', OrchestratorFixture.Json(403, { message: 'forbidden' }))
    await assert.rejects(always.o.Apply(OrchestratorFixture.Workload()), (e: unknown) => e instanceof KubeApiError && e.Status === 403)
    assert.equal(always.t.Paths(KubeMethod.Patch).length, InClusterHiveOrchestrator.BindingRetry.attempts)
    assert.equal(always.clock.Delays, InClusterHiveOrchestrator.BindingRetry.attempts - 1)
})

test('Apply does not retry a failure other than 403', async () =>
{
    const { t, o } = OrchestratorFixture.Make()
    t.On(KubeMethod.Patch, '/', OrchestratorFixture.Json(422, { message: 'invalid' }))
    await assert.rejects(o.Apply(OrchestratorFixture.Workload()), (e: unknown) => e instanceof KubeApiError && e.Status === 422)
    assert.equal(t.Paths(KubeMethod.Patch).length, 1)
})

test('Apply refuses an existing namespace not labelled for this hive', async () =>
{
    for (const labels of [{ 'pragmatic/hive': 'other' }, undefined])
    {
        const { t, o } = OrchestratorFixture.Make()
        t.On(KubeMethod.Post, OrchestratorFixture.NamespacesPath, OrchestratorFixture.Json(409, {}))
        t.On(KubeMethod.Get, OrchestratorFixture.NsPath, OrchestratorFixture.Namespace(labels))
        await assert.rejects(o.Apply(OrchestratorFixture.Workload()), (e: unknown) =>
            e instanceof EnvNamespaceRefusedError && e.message.includes(OrchestratorFixture.Ns))
        assert.deepEqual(t.Paths(KubeMethod.Patch), [])
        assert.deepEqual(t.Paths(KubeMethod.Post), [OrchestratorFixture.NamespacesPath])
    }
})

test('Apply refuses a workload of another hive before any API call', async () =>
{
    const { t, o } = OrchestratorFixture.Make()
    await assert.rejects(o.Apply({ ...OrchestratorFixture.Workload(), hiveId: 'other' }), EnvNamespaceRefusedError)
    assert.deepEqual(t.Calls, [])
})

test('Apply refuses an image the platform did not verify', async () =>
{
    const { t, o } = OrchestratorFixture.Make([])
    await assert.rejects(o.Apply(OrchestratorFixture.Workload()), (e: unknown) =>
        e instanceof ImageVerificationError && e.ImageRef === OrchestratorFixture.Ref)
    assert.deepEqual(t.Calls, [])
})

test('copies the TLS Secret into a federated namespace for development and existing-secret only', async () =>
{
    const source = OrchestratorFixture.Json(200, {
        metadata: { name: 'ignored', namespace: 'pragmatic-system', resourceVersion: '7' },
        type: 'kubernetes.io/tls',
        data: { 'tls.crt': 'Y2VydA==', 'tls.key': 'a2V5', 'ca.crt': 'Y2E=' },
    })
    const cases: Array<{ tls: IngressTls; from: string; to: string }> = [
        { tls: { source: IngressTlsSource.Development }, from: 'pragmatic-tenant-admin-acme-dev-tls', to: 'pragmatic-dev-tls' },
        { tls: { source: IngressTlsSource.ExistingSecret, secretName: 'acme-wildcard' }, from: 'acme-wildcard', to: 'acme-wildcard' },
    ]
    for (const c of cases)
    {
        const { t, o } = OrchestratorFixture.Make()
        const fromPath = '/api/v1/namespaces/pragmatic-system/secrets/' + c.from
        const toPath = '/api/v1/namespaces/pragmatic-env-a/secrets/' + c.to
        t.On(KubeMethod.Get, fromPath, source)
        await o.Apply(OrchestratorFixture.Workload(c.tls))
        assert.deepEqual(t.Paths(KubeMethod.Get).filter(p => p.includes('/secrets/')), [fromPath])
        const write = t.Calls.find(c2 => c2.method === KubeMethod.Patch && c2.path.split('?')[0] === toPath)
        assert.ok(write !== undefined)
        assert.equal(write.type, KubeContentType.ApplyPatch)
        const body = OrchestratorFixture.Body(write)
        assert.deepEqual(body, {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: c.to, namespace: OrchestratorFixture.Ns },
            type: 'kubernetes.io/tls',
            data: { 'tls.crt': 'Y2VydA==', 'tls.key': 'a2V5' },
        })
        const getIndex = t.Calls.findIndex(c2 => c2.method === KubeMethod.Get && c2.path === fromPath)
        assert.ok(getIndex > 1)
    }

    const managed = OrchestratorFixture.Make()
    await managed.o.Apply(OrchestratorFixture.Workload({ source: IngressTlsSource.CertManager, clusterIssuer: 'letsencrypt' }))
    assert.deepEqual(managed.t.Paths(KubeMethod.Get).filter(p => p.includes('/secrets/')), [])
    assert.ok(!managed.t.Paths(KubeMethod.Patch).some(p => p.includes('/secrets/')))
})

test('refuses a TLS source Secret that is not kubernetes.io/tls', async () =>
{
    const bad: KubeResponse[] = [
        OrchestratorFixture.Json(200, { type: 'Opaque', data: { 'tls.crt': 'U0VDUkVUQ0VSVA==', 'tls.key': 'U0VDUkVUS0VZ' } }),
        OrchestratorFixture.Json(200, { type: 'kubernetes.io/tls', data: { 'tls.crt': 'U0VDUkVUQ0VSVA==' } }),
        { status: 404, body: '{}' },
    ]
    for (const response of bad)
    {
        const { t, o } = OrchestratorFixture.Make()
        t.On(KubeMethod.Get, '/api/v1/namespaces/pragmatic-system/secrets/', response)
        await assert.rejects(o.Apply(OrchestratorFixture.Workload({ source: IngressTlsSource.ExistingSecret, secretName: 'acme-wildcard' })), (e: unknown) =>
            e instanceof InvalidTlsSourceSecretError
            && e.message.includes('acme-wildcard')
            && !e.message.includes('U0VDUkVU'))
        assert.ok(!t.Paths(KubeMethod.Patch).some(p => p.includes('/secrets/')))
    }
})

test('Teardown refuses a namespace labelled for another hive', async () =>
{
    for (const labels of [{ 'pragmatic/hive': 'other' }, undefined])
    {
        const { t, o } = OrchestratorFixture.Make()
        t.On(KubeMethod.Get, OrchestratorFixture.NsPath, OrchestratorFixture.Namespace(labels))
        await assert.rejects(o.Teardown(OrchestratorFixture.Workload()), EnvNamespaceRefusedError)
        assert.deepEqual(t.Paths(KubeMethod.Delete), [])
    }
})

test('Teardown deletes its own namespace', async () =>
{
    const { t, o } = OrchestratorFixture.Make()
    t.On(KubeMethod.Get, OrchestratorFixture.NsPath, OrchestratorFixture.Namespace({ 'pragmatic/hive': OrchestratorFixture.Hive }), 1)
    t.On(KubeMethod.Get, OrchestratorFixture.NsPath, { status: 404, body: '{}' })
    await o.Teardown(OrchestratorFixture.Workload())
    assert.deepEqual(t.Paths(KubeMethod.Delete), [OrchestratorFixture.NsPath])
})

test('Teardown of an absent namespace is a no-op', async () =>
{
    const { t, o } = OrchestratorFixture.Make()
    t.On(KubeMethod.Get, OrchestratorFixture.NsPath, { status: 404, body: '{}' })
    await o.Teardown(OrchestratorFixture.Workload())
    assert.deepEqual(t.Paths(KubeMethod.Delete), [])
    assert.deepEqual(t.Calls.map(c => c.method), [KubeMethod.Get])
})

test('Kubectl is the guarded API kubectl and the other verbs go through it', async () =>
{
    const { t, o } = OrchestratorFixture.Make()
    await assert.rejects(o.Kubectl.Get('pragmatic-system', 'secret/x'), EnvNamespaceRefusedError)
    await o.Scale(OrchestratorFixture.Workload(), 0)
    assert.deepEqual(t.Paths(KubeMethod.Patch), ['/apis/apps/v1/namespaces/pragmatic-env-a/deployments/pragmatic-env-a-server/scale'])
    await o.PrepareAgent('pragmatic-server:dev')
    assert.equal(t.Calls.length, 1)
})
