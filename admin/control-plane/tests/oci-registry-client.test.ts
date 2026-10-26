import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OciRegistryClient, OciResponseError, OciUnavailableError, type OciFetch } from '../oci-registry-client.js'

interface Recorded
{
    url: string
    method: string
    headers?: Record<string, string>
    body?: Uint8Array | string
}

class FakeRegistry
{
    public readonly requests: Recorded[] = []

    public constructor(private readonly responder: (r: Recorded) => Response)
    {
    }

    public get Fetch(): OciFetch
    {
        return async (url, init) =>
        {
            const r: Recorded = { url, method: init.method, headers: init.headers, body: init.body }
            this.requests.push(r)
            return this.responder(r)
        }
    }

    public static Upload(location: string): FakeRegistry
    {
        return new FakeRegistry(r => r.method === 'POST'
            ? new Response(null, { status: 202, headers: { Location: location } })
            : new Response(null, { status: 201 }))
    }
}

const Base = 'http://registry.test:5000'
const Bytes = new Uint8Array([1, 2, 3, 4, 5])

test('PushBlob does POST uploads then PUT ?digest= and returns the sha256 digest', async () =>
{
    const fake = FakeRegistry.Upload('/v2/app/blobs/uploads/abc')
    const digest = await new OciRegistryClient(Base, fake.Fetch).PushBlob('app', Bytes)
    assert.equal(digest, OciRegistryClient.DigestOf(Bytes))
    assert.match(digest, /^sha256:[0-9a-f]{64}$/)
    assert.equal(fake.requests.length, 2)
    assert.equal(fake.requests[0].method, 'POST')
    assert.equal(fake.requests[0].url, Base + '/v2/app/blobs/uploads/')
    const put = fake.requests[1]
    assert.equal(put.method, 'PUT')
    assert.equal(new URL(put.url).searchParams.get('digest'), digest)
    assert.equal(new URL(put.url).pathname, '/v2/app/blobs/uploads/abc')
    assert.equal(put.headers?.['Content-Type'], 'application/octet-stream')
    assert.deepEqual(put.body, Bytes)
})

test('PushBlob appends ?digest onto a Location that already has a query string', async () =>
{
    const fake = FakeRegistry.Upload('/v2/app/blobs/uploads/abc?_state=x')
    const digest = await new OciRegistryClient(Base, fake.Fetch).PushBlob('app', Bytes)
    const url = new URL(fake.requests[1].url)
    assert.equal(url.searchParams.get('_state'), 'x')
    assert.equal(url.searchParams.get('digest'), digest)
    assert.match(url.search, /^\?_state=x&digest=/)
})

test('PushBlob resolves an absolute Location against the base', async () =>
{
    const fake = FakeRegistry.Upload('http://other.test/v2/app/blobs/uploads/q')
    await new OciRegistryClient(Base, fake.Fetch).PushBlob('app', Bytes)
    assert.equal(new URL(fake.requests[1].url).host, 'other.test')
})

test('PushBlob without a Location raises OciResponseError', async () =>
{
    const fake = new FakeRegistry(() => new Response(null, { status: 202 }))
    await assert.rejects(() => new OciRegistryClient(Base, fake.Fetch).PushBlob('app', Bytes), OciResponseError)
})

test('PullBlob GETs /v2/<repo>/blobs/<digest> and returns the bytes', async () =>
{
    const fake = new FakeRegistry(() => new Response(new Uint8Array(Bytes), { status: 200 }))
    const digest = OciRegistryClient.DigestOf(Bytes)
    const got = await new OciRegistryClient(Base, fake.Fetch).PullBlob('app', digest)
    assert.equal(fake.requests[0].method, 'GET')
    assert.equal(fake.requests[0].url, Base + '/v2/app/blobs/' + digest)
    assert.ok(Buffer.from(got).equals(Buffer.from(Bytes)))
})

test('PushManifest PUTs /v2/<repo>/manifests/<ref> with the OCI manifest media type and returns the digest', async () =>
{
    const fake = new FakeRegistry(() => new Response(null, { status: 201 }))
    const manifest = new TextEncoder().encode('{"schemaVersion":2}')
    const digest = await new OciRegistryClient(Base, fake.Fetch).PushManifest('app', 'v1', manifest)
    assert.equal(digest, OciRegistryClient.DigestOf(manifest))
    const r = fake.requests[0]
    assert.equal(r.method, 'PUT')
    assert.equal(r.url, Base + '/v2/app/manifests/v1')
    assert.equal(r.headers?.['Content-Type'], 'application/vnd.oci.image.manifest.v1+json')
    assert.deepEqual(r.body, manifest)
})

test('PullManifest GETs /v2/<repo>/manifests/<ref> and returns the bytes', async () =>
{
    const fake = new FakeRegistry(() => new Response(new Uint8Array(Bytes), { status: 200 }))
    const got = await new OciRegistryClient(Base, fake.Fetch).PullManifest('app', 'v1')
    assert.equal(fake.requests[0].url, Base + '/v2/app/manifests/v1')
    assert.ok(Buffer.from(got).equals(Buffer.from(Bytes)))
})

test('a non-2xx response raises OciResponseError carrying the status and no body', async () =>
{
    const fake = new FakeRegistry(() => new Response('secret-body-text', { status: 500 }))
    await assert.rejects(() => new OciRegistryClient(Base, fake.Fetch).PullBlob('app', 'sha256:00'), (err: unknown) =>
    {
        assert.ok(err instanceof OciResponseError)
        assert.equal(err.status, 500)
        assert.match(err.message, /500/)
        assert.doesNotMatch(err.message, /secret-body-text/)
        return true
    })
})

test('a thrown fetch raises OciUnavailableError', async () =>
{
    const fake = new FakeRegistry(() =>
    {
        throw new Error('ECONNREFUSED secret-host')
    })
    await assert.rejects(() => new OciRegistryClient(Base, fake.Fetch).PullManifest('app', 'v1'), (err: unknown) =>
    {
        assert.ok(err instanceof OciUnavailableError)
        assert.doesNotMatch(err.message, /secret-host/)
        return true
    })
})
