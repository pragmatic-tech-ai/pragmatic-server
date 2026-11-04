import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiKubectl, RolloutTimeoutError } from '../api-kubectl.js'
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
    public Now(): number
    {
        return 1700000000000
    }

    public Delay(): Promise<void>
    {
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

    public static Make(responses: KubeResponse[], rollout = { attempts: 5, intervalMs: 0 }): { fake: FakeKubeTransport; kubectl: ApiKubectl }
    {
        const fake = new FakeKubeTransport(responses)
        return { fake, kubectl: new ApiKubectl(new KubeApiClient(fake), new FakeClock(), rollout) }
    }

    public static Deployment(observed: number, updated: number, available: number): KubeResponse
    {
        return Fixture.Ok({
            metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: observed, updatedReplicas: updated, availableReplicas: available },
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

test('DeleteBySelector lists then deletes every match per resource', async () =>
{
    const { fake, kubectl } = Fixture.Make([
        Fixture.Ok({ items: [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }] }), Fixture.Empty, Fixture.Empty,
        Fixture.Ok({ items: [{ metadata: { name: 's' } }] }),
    ])
    await kubectl.DeleteBySelector('ns', 'deployment,service', 'app=x')
    assert.deepEqual(fake.Calls.map(c => [c[0], c[1].split('?')[0]]), [
        [KubeMethod.Get, '/apis/apps/v1/namespaces/ns/deployments'],
        [KubeMethod.Delete, '/apis/apps/v1/namespaces/ns/deployments/a'],
        [KubeMethod.Delete, '/apis/apps/v1/namespaces/ns/deployments/b'],
        [KubeMethod.Get, '/api/v1/namespaces/ns/services'],
        [KubeMethod.Delete, '/api/v1/namespaces/ns/services/s'],
    ])
})
