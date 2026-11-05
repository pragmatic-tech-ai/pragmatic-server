import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiKubectl, RolloutTimeoutError } from '../api-kubectl.js'
import { KubectlError } from '../kubectl.js'
import { HiveAgentUninstaller, AgentUninstallError } from '../hive-agent-uninstaller.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import type { IInstallOrchestratorSource } from '../hive-agent-installer.js'
import { KubeApiClient, KubeApiError, KubeContentType, KubeMethod, type IKubeTransport, type KubeResponse } from '../kube-api-client.js'
import type { IInstallClock } from '../hive-agent-installer.js'

class FakeKubeTransport implements IKubeTransport
{
    public readonly Calls: Array<[KubeMethod, string, KubeContentType, string | undefined]> = []

    public constructor(private readonly responses: KubeResponse[] = [])
    {
    }

    public Send(method: KubeMethod, path: string, body: string | undefined, contentType: KubeContentType): Promise<KubeResponse>
    {
        this.Calls.push([method, path, contentType, body])
        return Promise.resolve(this.responses.shift() ?? { status: 200, body: '{}' })
    }
}

class FakeClock implements IInstallClock
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

class Fixture
{
    public static readonly Empty: KubeResponse = { status: 200, body: '{}' }
    public static readonly Gone: KubeResponse = { status: 404, body: '{}' }

    public static Ok(body: object): KubeResponse
    {
        return { status: 200, body: JSON.stringify(body) }
    }

    public static Make(responses: KubeResponse[], rollout = { attempts: 5, intervalMs: 0 }): { fake: FakeKubeTransport; kubectl: ApiKubectl; clock: FakeClock }
    {
        const fake = new FakeKubeTransport(responses)
        const clock = new FakeClock()
        return { fake, kubectl: new ApiKubectl(new KubeApiClient(fake), clock, rollout), clock }
    }

    public static Deployment(observed: number, updated: number, available: number): KubeResponse
    {
        return Fixture.Ok({
            metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: observed, replicas: updated, updatedReplicas: updated, availableReplicas: available },
        })
    }
}

test('Apply applies each List item server-side in order', async () =>
{
    const { fake, kubectl } = Fixture.Make([])
    const list = {
        apiVersion: 'v1', kind: 'List', items: [
            { apiVersion: 'v1', kind: 'Service', metadata: { name: 's', namespace: 'ns' } },
            { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'd', namespace: 'ns' } },
        ],
    }
    await kubectl.Apply(JSON.stringify(list))
    assert.equal(fake.Calls.length, 2)
    assert.equal(fake.Calls[0]![0], KubeMethod.Patch)
    assert.ok(fake.Calls[0]![1].startsWith('/api/v1/namespaces/ns/services/s?'))
    assert.ok(fake.Calls[1]![1].startsWith('/apis/apps/v1/namespaces/ns/deployments/d?'))
    assert.equal(fake.Calls[0]![2], KubeContentType.ApplyPatch)
})

test('ApplyServerSide applies a single object', async () =>
{
    const { fake, kubectl } = Fixture.Make([])
    await kubectl.ApplyServerSide(JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'x' } }))
    assert.ok(fake.Calls[0]![1].startsWith('/api/v1/namespaces/x?'))
})

test('Apply reports bad JSON without echoing the manifest', async () =>
{
    const { kubectl } = Fixture.Make([])
    await assert.rejects(() => kubectl.Apply('{"data":{"pw":"hunter2" oops'), (e: Error) => !e.message.includes('hunter2'))
})

test('Get reads a Secret by kubectl shorthand', async () =>
{
    const { fake, kubectl } = Fixture.Make([{ status: 200, body: '{"a":1}' }, Fixture.Gone, Fixture.Gone])
    assert.equal(await kubectl.Get('pragmatic-env-a', 'secret/a-env-secrets'), '{"a":1}')
    assert.equal(fake.Calls[0]![1], '/api/v1/namespaces/pragmatic-env-a/secrets/a-env-secrets')
    await assert.rejects(() => kubectl.Get('pragmatic-env-a', 'secret/a-env-secrets'), (e: unknown) => e instanceof KubeApiError && e.Status === 404)
    assert.equal(await kubectl.Find('pragmatic-env-a', 'secret/a-env-secrets'), undefined)
})

test('SetImage sends a strategic merge of the one container', async () =>
{
    const { fake, kubectl } = Fixture.Make([])
    await kubectl.SetImage('ns', 'd', 'server', 'img:2')
    assert.equal(fake.Calls[0]![1], '/apis/apps/v1/namespaces/ns/deployments/d')
    assert.equal(fake.Calls[0]![2], KubeContentType.StrategicMerge)
    assert.deepEqual(JSON.parse(fake.Calls[0]![3]!), { spec: { template: { spec: { containers: [{ name: 'server', image: 'img:2' }] } } } })
})

test('Scale patches the scale subresource', async () =>
{
    const { fake, kubectl } = Fixture.Make([])
    await kubectl.Scale('ns', 'd', 0)
    assert.equal(fake.Calls[0]![1], '/apis/apps/v1/namespaces/ns/deployments/d/scale')
    assert.equal(fake.Calls[0]![2], KubeContentType.MergePatch)
    assert.deepEqual(JSON.parse(fake.Calls[0]![3]!), { spec: { replicas: 0 } })
    await kubectl.ScaleStatefulSet('ns', 's', 1)
    assert.equal(fake.Calls[1]![1], '/apis/apps/v1/namespaces/ns/statefulsets/s/scale')
})

test('RolloutStatus waits for the observed generation and available replicas', async () =>
{
    const { fake, kubectl } = Fixture.Make([Fixture.Deployment(1, 1, 1), Fixture.Deployment(2, 1, 0), Fixture.Deployment(2, 1, 1)])
    await kubectl.RolloutStatus('ns', 'd')
    assert.equal(fake.Calls.length, 3)
    const never = Fixture.Make([Fixture.Deployment(1, 0, 0), Fixture.Deployment(1, 0, 0), Fixture.Deployment(1, 0, 0)], { attempts: 2, intervalMs: 0 })
    await assert.rejects(() => never.kubectl.RolloutStatus('ns', 'd'), RolloutTimeoutError)
    assert.equal(never.fake.Calls.length, 2)
    assert.equal(never.clock.Delays, 1)
})

test('RolloutStatus treats zero replicas as done', async () =>
{
    const { kubectl } = Fixture.Make([Fixture.Ok({ metadata: { generation: 1 }, spec: { replicas: 0 }, status: { observedGeneration: 1 } })])
    await kubectl.RolloutStatus('ns', 'd')
})

test('RolloutRestart stamps restartedAt from the clock', async () =>
{
    const { fake, kubectl } = Fixture.Make([])
    await kubectl.RolloutRestart('ns', 'd')
    assert.equal(fake.Calls[0]![2], KubeContentType.StrategicMerge)
    assert.deepEqual(JSON.parse(fake.Calls[0]![3]!), {
        spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date(new FakeClock().Now()).toISOString() } } } },
    })
})

test('RolloutRestartSelector restarts every matching deployment', async () =>
{
    const { fake, kubectl } = Fixture.Make([Fixture.Ok({ items: [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }] })])
    await kubectl.RolloutRestartSelector('ns', 'app=x')
    assert.equal(fake.Calls.length, 3)
    assert.equal(fake.Calls[1]![1], '/apis/apps/v1/namespaces/ns/deployments/a')
    assert.equal(fake.Calls[2]![1], '/apis/apps/v1/namespaces/ns/deployments/b')
})

test('DeleteNamespace tolerates a missing namespace', async () =>
{
    const { fake, kubectl } = Fixture.Make([Fixture.Gone])
    await kubectl.DeleteNamespace('gone')
    assert.deepEqual([fake.Calls[0]![0], fake.Calls[0]![1]], [KubeMethod.Delete, '/api/v1/namespaces/gone'])
    assert.equal(fake.Calls.length, 1)
})

test('DeleteNamespace waits until the namespace is gone', async () =>
{
    const { fake, kubectl, clock } = Fixture.Make([Fixture.Empty, Fixture.Ok({}), Fixture.Ok({}), Fixture.Gone])
    await kubectl.DeleteNamespace('ns')
    assert.deepEqual(fake.Calls.map(c => c[0]), [KubeMethod.Delete, KubeMethod.Get, KubeMethod.Get, KubeMethod.Get])
    assert.equal(clock.Delays, 2)
})

test('DeleteNamespace times out when the namespace never goes away', async () =>
{
    const { fake, kubectl, clock } = Fixture.Make([Fixture.Empty, Fixture.Ok({}), Fixture.Ok({})], { attempts: 2, intervalMs: 0 })
    await assert.rejects(() => kubectl.DeleteNamespace('ns'), (e: unknown) => e instanceof KubectlError && e.message === 'Resource namespace/ns was not deleted in time.')
    assert.equal(fake.Calls.length, 3)
    assert.equal(clock.Delays, 1)
})

test('DeleteManifest tolerates objects already gone', async () =>
{
    const { fake, kubectl } = Fixture.Make([Fixture.Gone, Fixture.Empty])
    const list = {
        kind: 'List', items: [
            { apiVersion: 'v1', kind: 'Service', metadata: { name: 's', namespace: 'ns' } },
            { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'd', namespace: 'ns' } },
        ],
    }
    await kubectl.DeleteManifest(JSON.stringify(list))
    assert.equal(fake.Calls.length, 2)
})

test('DeleteNamespacesBySelector lists namespaces by label and deletes only those inside the prefix', async () =>
{
    const { fake, kubectl } = Fixture.Make([
        Fixture.Ok({ items: [{ metadata: { name: 'pragmatic-env-a' } }, { metadata: { name: 'default' } }] }),
        Fixture.Empty, Fixture.Gone,
    ])
    assert.deepEqual(await kubectl.DeleteNamespacesBySelector('pragmatic/hive=h1', 'pragmatic-env-'), [])
    assert.deepEqual(fake.Calls.map(c => [c[0], c[1]]), [
        [KubeMethod.Get, '/api/v1/namespaces?labelSelector=' + encodeURIComponent('pragmatic/hive=h1')],
        [KubeMethod.Delete, '/api/v1/namespaces/pragmatic-env-a'],
        [KubeMethod.Get, '/api/v1/namespaces/pragmatic-env-a'],
    ])
})

test('ListNamespacesBySelector lists by label and keeps only names inside the prefix', async () =>
{
    const { fake, kubectl } = Fixture.Make([Fixture.Ok({ items: [{ metadata: { name: 'pragmatic-env-a' } }, { metadata: { name: 'default' } }] })])
    assert.deepEqual(await kubectl.ListNamespacesBySelector('pragmatic/hive=h1', 'pragmatic-env-'), ['pragmatic-env-a'])
    assert.deepEqual(fake.Calls.map(c => [c[0], c[1]]), [[KubeMethod.Get, '/api/v1/namespaces?labelSelector=' + encodeURIComponent('pragmatic/hive=h1')]])
})

test('ServesResource reads the group version and finds the resource; an absent group version is false', async () =>
{
    const { fake, kubectl } = Fixture.Make([Fixture.Ok({ resources: [{ name: 'validatingadmissionpolicies' }] }), Fixture.Ok({ resources: [] }), Fixture.Gone])
    assert.equal(await kubectl.ServesResource('admissionregistration.k8s.io/v1', 'validatingadmissionpolicies'), true)
    assert.equal(await kubectl.ServesResource('v1', 'namespaces'), false)
    assert.equal(await kubectl.ServesResource('example.test/v9', 'things'), false)
    assert.deepEqual(fake.Calls.map(c => [c[0], c[1]]), [
        [KubeMethod.Get, '/apis/admissionregistration.k8s.io/v1'],
        [KubeMethod.Get, '/api/v1'],
        [KubeMethod.Get, '/apis/example.test/v9'],
    ])
})

test('DeleteNamespacesBySelector reports a namespace whose delete failed and goes on', async () =>
{
    const { kubectl } = Fixture.Make([
        Fixture.Ok({ items: [{ metadata: { name: 'pragmatic-env-a' } }, { metadata: { name: 'pragmatic-env-b' } }] }),
        { status: 403, body: '{}' },
        Fixture.Empty, Fixture.Gone,
    ])
    assert.deepEqual(await kubectl.DeleteNamespacesBySelector('pragmatic/hive=h1', 'pragmatic-env-'), ['pragmatic-env-a'])
})

test('DeleteBySelector lists then deletes every match per resource', async () =>
{
    const { fake, kubectl } = Fixture.Make([
        Fixture.Ok({ items: [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }] }), Fixture.Empty, Fixture.Empty,
        Fixture.Gone, Fixture.Gone,
        Fixture.Ok({ items: [{ metadata: { name: 's' } }] }), Fixture.Empty, Fixture.Gone,
    ])
    await kubectl.DeleteBySelector('ns', 'deployment,service', 'app=x')
    assert.deepEqual(fake.Calls.map(c => [c[0], c[1].split('?')[0]]), [
        [KubeMethod.Get, '/apis/apps/v1/namespaces/ns/deployments'],
        [KubeMethod.Delete, '/apis/apps/v1/namespaces/ns/deployments/a'],
        [KubeMethod.Delete, '/apis/apps/v1/namespaces/ns/deployments/b'],
        [KubeMethod.Get, '/apis/apps/v1/namespaces/ns/deployments/a'],
        [KubeMethod.Get, '/apis/apps/v1/namespaces/ns/deployments/b'],
        [KubeMethod.Get, '/api/v1/namespaces/ns/services'],
        [KubeMethod.Delete, '/api/v1/namespaces/ns/services/s'],
        [KubeMethod.Get, '/api/v1/namespaces/ns/services/s'],
    ])
})

test('RolloutRestartSelector with no matches restarts nothing', async () =>
{
    const { fake, kubectl } = Fixture.Make([Fixture.Ok({ items: [] })])
    await kubectl.RolloutRestartSelector('ns', 'app=x')
    assert.equal(fake.Calls.length, 1)
})

test('Find propagates a non-404 error', async () =>
{
    const { kubectl } = Fixture.Make([{ status: 500, body: '{}' }])
    await assert.rejects(() => kubectl.Find('ns', 'secret/s'), (e: unknown) => e instanceof KubeApiError && e.Status === 500)
})

test('Get resolves pods', async () =>
{
    const { fake, kubectl } = Fixture.Make([Fixture.Ok({})])
    await kubectl.Get('ns', 'pod/p')
    assert.equal(fake.Calls[0]![1], '/api/v1/namespaces/ns/pods/p')
})

test('Client exposes the API client', () =>
{
    const client = new KubeApiClient(new FakeKubeTransport())
    assert.equal(new ApiKubectl(client).Client, client)
})

test('RolloutStatus fails fast on a missing Deployment', async () =>
{
    const { fake, kubectl, clock } = Fixture.Make([Fixture.Gone])
    await assert.rejects(() => kubectl.RolloutStatus('ns', 'nope'), (e: unknown) => e instanceof KubeApiError && e.Status === 404)
    assert.equal(fake.Calls.length, 1)
    assert.equal(clock.Delays, 0)
})

test('RolloutStatus waits while old replicas remain, and accepts surplus availability', async () =>
{
    const surge = Fixture.Ok({ metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 2, replicas: 2, updatedReplicas: 1, availableReplicas: 2 } })
    const { fake, kubectl } = Fixture.Make([surge, Fixture.Deployment(2, 1, 1)])
    await kubectl.RolloutStatus('ns', 'd')
    assert.equal(fake.Calls.length, 2)
    const over = Fixture.Make([Fixture.Ok({ metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 2 } })])
    await over.kubectl.RolloutStatus('ns', 'd')
    assert.equal(over.fake.Calls.length, 1)
})

test('Apply refuses a namespaced object without a namespace, naming it', async () =>
{
    const { fake, kubectl } = Fixture.Make([])
    await assert.rejects(
        () => kubectl.Apply(JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'my-secret' } })),
        (e: unknown) => e instanceof KubectlError && e.message.includes('Secret/my-secret'))
    assert.equal(fake.Calls.length, 0)
})

test('every ApiKubectl failure is a KubectlError', async () =>
{
    const api = Fixture.Make([{ status: 403, body: '{"message":"forbidden"}' }])
    await assert.rejects(() => api.kubectl.Scale('ns', 'd', 1), (e: unknown) => e instanceof KubectlError && e instanceof KubeApiError && e.Status === 403)
    await assert.rejects(() => Fixture.Make([]).kubectl.Apply('nope'), (e: unknown) => e instanceof KubectlError)
    await assert.rejects(() => Fixture.Make([]).kubectl.Get('ns', 'widget/x'), (e: unknown) => e instanceof KubectlError)
    await assert.rejects(() => Fixture.Make([Fixture.Deployment(1, 0, 0)], { attempts: 1, intervalMs: 0 }).kubectl.RolloutStatus('ns', 'd'),
        (e: unknown) => e instanceof KubectlError && e instanceof RolloutTimeoutError)
})

test('a non-forced uninstall over ApiKubectl fails as AgentUninstallError', async () =>
{
    const { kubectl } = Fixture.Make([{ status: 500, body: '{"message":"boom"}' }])
    const source = { For: () => ({ Kubectl: kubectl }) } as unknown as IInstallOrchestratorSource
    const hive: HiveRecord = { id: 'h1', tenantId: 't1', displayName: 'h1', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision }, createdAt: '2026-01-01T00:00:00.000Z' }
    await assert.rejects(() => new HiveAgentUninstaller(source).Uninstall(hive), (e: unknown) => e instanceof AgentUninstallError && e.message.includes('status 500'))
})
