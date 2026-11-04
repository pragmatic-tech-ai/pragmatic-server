import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevCa } from '../../../src/idp/dev-ca.js'
import {
    HttpsKubeTransport, InClusterServiceAccount, KubeApiClient, KubeApiError, KubeContentType, KubeMethod,
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

test('PathOf knows the cluster-scoped admission policy kinds', () =>
{
    const group = 'admissionregistration.k8s.io/v1'
    assert.equal(KubeResourceCatalog.PathOf({ apiVersion: group, kind: 'ValidatingAdmissionPolicy' }, 'ignored', 'p'), '/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/p')
    assert.equal(KubeResourceCatalog.PathOf({ apiVersion: group, kind: 'ValidatingAdmissionPolicyBinding' }, undefined, 'b'), '/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/b')
    assert.equal(KubeResourceCatalog.IsNamespaced({ apiVersion: group, kind: 'ValidatingAdmissionPolicy' }), false)
    assert.equal(KubeResourceCatalog.ParseResource('validatingadmissionpolicybinding/b').type.kind, 'ValidatingAdmissionPolicyBinding')
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
        assert.ok(error.message.startsWith('kubernetes API POST /api/v1/namespaces/x/secrets failed with status 422: '))
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

test('a failed call names the method and path and carries no query', async () =>
{
    const fake = new FakeKubeTransport([{ status: 403, body: '{"message":"forbidden"}' }, { status: 500, body: 'not json' }])
    const client = new KubeApiClient(fake)
    await assert.rejects(client.Apply('/api/v1/namespaces/x/secrets/roles', {}), { message: 'kubernetes API PATCH /api/v1/namespaces/x/secrets/roles failed with status 403: forbidden' })
    await assert.rejects(client.Delete('/api/v1/namespaces/x'), { message: 'kubernetes API DELETE /api/v1/namespaces/x failed with status 500' })
})

test('a failed call redacts a Bearer credential in the API message', async () =>
{
    const fake = new FakeKubeTransport([{ status: 401, body: JSON.stringify({ message: 'bad header Bearer s3cr3t-value' }) }])
    await assert.rejects(new KubeApiClient(fake).Get('/api/v1/namespaces/x'), (error: unknown) =>
    {
        assert.ok(error instanceof KubeApiError)
        assert.ok(!error.message.includes('s3cr3t-value'))
        assert.ok(error.message.includes('[REDACTED]'))
        return true
    })
})

test('a 2xx with a non-JSON body fails with a fixed message that never echoes the body', async () =>
{
    const fake = new FakeKubeTransport([{ status: 200, body: 'SECRETBODY{' }, { status: 200, body: 'SECRETBODY{' }])
    const client = new KubeApiClient(fake)
    for (const call of [() => client.Get('/api/v1/namespaces/x/secrets/a'), () => client.List('/api/v1/namespaces/x/secrets')])
    {
        await assert.rejects(call(), (error: unknown) =>
        {
            assert.ok(error instanceof Error)
            assert.ok(!error.message.includes('SECRETBODY'))
            assert.equal(error.message, 'kubernetes API GET response was not valid JSON')
            return true
        })
    }
})

test('ParseResource accepts only exact kind names plus svc', () =>
{
    assert.throws(() => KubeResourceCatalog.ParseResource('sts/x'), UnsupportedKubeKindError)
    assert.throws(() => KubeResourceCatalog.ParseResource('cm/x'), UnsupportedKubeKindError)
})

class ApiServerFixture
{
    public readonly Seen: Array<{ auth: string | undefined; method: string | undefined; url: string | undefined }> = []
    public Port = 0
    public Dir = ''
    public Account: InClusterServiceAccount | undefined
    private server: Server | undefined
    private hang = false

    public async Start(): Promise<void>
    {
        this.Dir = mkdtempSync(join(tmpdir(), 'kube-https-'))
        const files = DevCa.EnsureAt(this.Dir, 'localhost')
        writeFileSync(join(this.Dir, 'token'), 'first-token')
        this.Account = new InClusterServiceAccount(join(this.Dir, 'token'), files.caFile)
        this.server = createServer({ key: readFileSync(files.keyFile), cert: readFileSync(files.certFile) }, (req, res) =>
        {
            this.Seen.push({ auth: req.headers.authorization, method: req.method, url: req.url })
            if (this.hang)
            {
                return
            }
            res.statusCode = 200
            res.end('{"ok":true}')
        })
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
        this.Port = (this.server.address() as { port: number }).port
    }

    public Hang(): void
    {
        this.hang = true
    }

    public async Stop(): Promise<void>
    {
        this.server?.closeAllConnections()
        await new Promise<void>(resolve => this.server!.close(() => resolve()))
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

test('HttpsKubeTransport rereads the token on every request and trusts the service-account CA', async () =>
{
    const fixture = new ApiServerFixture()
    await fixture.Start()
    try
    {
        const transport = new HttpsKubeTransport(fixture.Account!, 5000, 'localhost', fixture.Port)
        const first = await transport.Send(KubeMethod.Get, '/x', undefined, KubeContentType.Json)
        writeFileSync(fixture.Account!.TokenPath, 'second-token')
        await transport.Send(KubeMethod.Get, '/x', undefined, KubeContentType.Json)
        assert.equal(first.status, 200)
        assert.deepEqual(fixture.Seen.map(s => s.auth), ['Bearer first-token', 'Bearer second-token'])
    }
    finally
    {
        await fixture.Stop()
    }
})

test('HttpsKubeTransport timeout fails with a fixed message that holds no token', async () =>
{
    const fixture = new ApiServerFixture()
    await fixture.Start()
    fixture.Hang()
    try
    {
        const transport = new HttpsKubeTransport(fixture.Account!, 200, 'localhost', fixture.Port)
        await assert.rejects(transport.Send(KubeMethod.Get, '/x', undefined, KubeContentType.Json), (error: unknown) =>
        {
            assert.ok(error instanceof Error)
            assert.equal(error.message, 'kubernetes API request timed out')
            assert.ok(!error.message.includes('first-token'))
            return true
        })
    }
    finally
    {
        await fixture.Stop()
    }
})
