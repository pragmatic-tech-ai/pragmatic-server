import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InClusterK8sApi } from '../k8s-api.js'

class FakeSendK8sApi extends InClusterK8sApi
{
    public readonly Paths: string[] = []

    public readonly Bodies: Array<string | undefined> = []

    public constructor(private readonly responseBody: unknown, private readonly status: number = 200)
    {
        super()
    }

    protected override Send(method: string, path: string, body: string | undefined): Promise<{ status: number; body: string }>
    {
        this.Bodies.push(body)
        this.Paths.push(method + ' ' + path)
        return Promise.resolve({ status: this.status, body: JSON.stringify(this.responseBody) })
    }
}

test('ListServerDeployments maps namespace, name, image and readiness', async () =>
{
    const list = {
        items: [
            {
                metadata: { namespace: 'ns-a', name: 'dep-a' },
                spec: { template: { spec: { containers: [{ name: 'sidecar', image: 'side:1' }, { name: 'server', image: 'srv:1' }] } } },
                status: { replicas: 2, readyReplicas: 2 },
            },
            {
                metadata: { namespace: 'ns-b', name: 'dep-b' },
                spec: { template: { spec: { containers: [{ name: 'main', image: 'main:2' }] } } },
                status: { replicas: 1 },
            },
            {
                metadata: { namespace: 'ns-c', name: 'dep-c' },
                spec: { template: { spec: { containers: [{ name: 'server', image: 'srv:3' }] } } },
                status: { replicas: 0, readyReplicas: 0 },
            },
        ],
    }
    const api = new FakeSendK8sApi(list)
    const result = await api.ListServerDeployments('app=a,b=c')
    assert.deepEqual(result, [
        { namespace: 'ns-a', deployment: 'dep-a', container: 'server', runningImage: 'srv:1', ready: true },
        { namespace: 'ns-b', deployment: 'dep-b', container: 'main', runningImage: 'main:2', ready: false },
        { namespace: 'ns-c', deployment: 'dep-c', container: 'server', runningImage: 'srv:3', ready: false },
    ])
    assert.deepEqual(api.Bodies, [undefined])
    assert.deepEqual(api.Paths, ['GET /apis/apps/v1/deployments?labelSelector=app%3Da%2Cb%3Dc'])
})

test('ListServerDeployments returns empty for missing or empty items', async () =>
{
    assert.deepEqual(await new FakeSendK8sApi({}).ListServerDeployments('a=b'), [])
    assert.deepEqual(await new FakeSendK8sApi({ items: [] }).ListServerDeployments('a=b'), [])
})

test('ListServerDeployments rejects on non-2xx', async () =>
{
    await assert.rejects(new FakeSendK8sApi({}, 500).ListServerDeployments('a=b'))
})

test('ListServerDeployments uses first container when no server container', async () =>
{
    const list = { items: [{
        metadata: { namespace: 'n', name: 'd' },
        spec: { template: { spec: { containers: [{ name: 'first', image: 'f:1' }, { name: 'second', image: 's:1' }] } } },
        status: { replicas: 1, readyReplicas: 1 },
    }] }
    const result = await new FakeSendK8sApi(list).ListServerDeployments('a=b')
    assert.deepEqual(result, [{ namespace: 'n', deployment: 'd', container: 'first', runningImage: 'f:1', ready: true }])
})
