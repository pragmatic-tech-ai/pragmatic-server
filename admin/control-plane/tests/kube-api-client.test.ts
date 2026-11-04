import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    InClusterServiceAccount, KubeApiClient, KubeApiError, KubeContentType, KubeMethod,
    KubeResourceCatalog, UnsupportedKubeKindError,
} from '../kube-api-client.js'
import type { IKubeTransport, KubeResponse } from '../kube-api-client.js'

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

test('PathOf builds core, grouped, namespaced and cluster paths', () =>
{
    assert.equal(KubeResourceCatalog.PathOf({ apiVersion: 'v1', kind: 'Namespace' }, undefined, 'pragmatic-env-a'), '/api/v1/namespaces/pragmatic-env-a')
    assert.equal(KubeResourceCatalog.PathOf({ apiVersion: 'apps/v1', kind: 'Deployment' }, 'pragmatic-env-a', 'x'), '/apis/apps/v1/namespaces/pragmatic-env-a/deployments/x')
    assert.equal(KubeResourceCatalog.PathOf({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole' }, undefined, 'r'), '/apis/rbac.authorization.k8s.io/v1/clusterroles/r')
    assert.equal(KubeResourceCatalog.PathOf({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' }, 'n'), '/apis/networking.k8s.io/v1/namespaces/n/ingresses')
})

test('PathOf refuses an unknown kind', () =>
{
    assert.throws(() => KubeResourceCatalog.PathOf({ apiVersion: 'example.com/v1', kind: 'Widget' }, 'n'), UnsupportedKubeKindError)
})

test('ParseResource reads kubectl shorthands', () =>
{
    assert.deepEqual(KubeResourceCatalog.ParseResource('svc/a'), { type: { apiVersion: 'v1', kind: 'Service' }, name: 'a' })
    assert.equal(KubeResourceCatalog.ParseResource('deployment/a').type.kind, 'Deployment')
    assert.deepEqual(KubeResourceCatalog.ParseResource('secret/a-env-secrets'), { type: { apiVersion: 'v1', kind: 'Secret' }, name: 'a-env-secrets' })
    const bare = KubeResourceCatalog.ParseResource('deployments')
    assert.equal(bare.type.kind, 'Deployment')
    assert.equal(bare.name, undefined)
    assert.equal(KubeResourceCatalog.ParseResource('statefulset/x').type.kind, 'StatefulSet')
    assert.equal(KubeResourceCatalog.ParseResource('serviceaccount').type.kind, 'ServiceAccount')
    assert.throws(() => KubeResourceCatalog.ParseResource('widget/x'), UnsupportedKubeKindError)
})

test('Get answers undefined on 404 and parses JSON on 200', async () =>
{
    const fake = new FakeKubeTransport([{ status: 404, body: '{}' }, { status: 200, body: '{"a":1}' }])
    const client = new KubeApiClient(fake)
    assert.equal(await client.Get('/api/v1/namespaces/x'), undefined)
    assert.deepEqual(await client.Get('/api/v1/namespaces/x'), { a: 1 })
})

test('Create answers false on 409 and Delete answers false on 404', async () =>
{
    const fake = new FakeKubeTransport([{ status: 409, body: '{}' }, { status: 201, body: '{}' }, { status: 404, body: '{}' }, { status: 200, body: '{}' }])
    const client = new KubeApiClient(fake)
    assert.equal(await client.Create('/api/v1/namespaces', {}), false)
    assert.equal(await client.Create('/api/v1/namespaces', {}), true)
    assert.equal(await client.Delete('/api/v1/namespaces/x'), false)
    assert.equal(await client.Delete('/api/v1/namespaces/x'), true)
})

test('List returns items and appends the encoded label selector', async () =>
{
    const fake = new FakeKubeTransport([{ status: 200, body: '{"items":[{"a":1}]}' }])
    const items = await new KubeApiClient(fake).List('/api/v1/namespaces', 'a=b,c in (d)')
    assert.deepEqual(items, [{ a: 1 }])
    assert.equal(fake.Calls[0]![1], '/api/v1/namespaces?labelSelector=' + encodeURIComponent('a=b,c in (d)'))
})

test('Apply sends server-side apply with the console field manager', async () =>
{
    const fake = new FakeKubeTransport()
    await new KubeApiClient(fake).Apply('/api/v1/namespaces/x', { kind: 'Namespace' })
    const [method, path, contentType] = fake.Calls[0]!
    assert.equal(method, KubeMethod.Patch)
    assert.ok(path.endsWith('?fieldManager=pragmatic-tenant-console&force=true'))
    assert.equal(contentType, KubeContentType.ApplyPatch)
})

test('a failed call redacts the API message', async () =>
{
    const token = 'abcdefabcdefabcdefabcdefabcdefabcdef'
    const fake = new FakeKubeTransport([{ status: 422, body: JSON.stringify({ message: 'token: ' + token }) }])
    await assert.rejects(new KubeApiClient(fake).Create('/api/v1/namespaces/x/secrets', {}), (error: unknown) =>
    {
        assert.ok(error instanceof KubeApiError)
        assert.equal(error.Status, 422)
        assert.ok(error.message.includes('[REDACTED]'))
        assert.ok(!error.message.includes(token))
        assert.ok(error.message.includes('POST secrets failed with status 422'))
        return true
    })
})

test('Detect needs KUBERNETES_SERVICE_HOST and both files', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'kube-sa-'))
    try
    {
        writeFileSync(join(dir, 'token'), 't')
        assert.equal(InClusterServiceAccount.Detect({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, dir), undefined)
        writeFileSync(join(dir, 'ca.crt'), 'c')
        const account = InClusterServiceAccount.Detect({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, dir)
        assert.equal(account?.TokenPath, join(dir, 'token'))
        assert.equal(account?.CaPath, join(dir, 'ca.crt'))
        assert.equal(InClusterServiceAccount.Detect({}, dir), undefined)
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})
