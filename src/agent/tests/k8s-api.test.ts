import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InClusterK8sApi } from '../k8s-api.js'

class FakeSendK8sApi extends InClusterK8sApi
{
    public readonly Paths: string[] = []

    public constructor(private readonly responseBody: unknown)
    {
        super()
    }

    protected override Send(method: string, path: string): Promise<{ status: number; body: string }>
    {
        this.Paths.push(method + ' ' + path)
        return Promise.resolve({ status: 200, body: JSON.stringify(this.responseBody) })
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
    assert.deepEqual(api.Paths, ['GET /apis/apps/v1/deployments?labelSelector=app%3Da%2Cb%3Dc'])
})
