import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OciRegistryClient, OciResponseError, type OciFetch } from '../oci-registry-client.js'
import { FakeOciRegistry } from './fake-oci-registry.js'

const Base = 'https://registry.test'
const User = 'napryaglo'
const Token = 'ghp_super_secret_token_value'
const IndexType = 'application/vnd.oci.image.index.v1+json'

class Fixtures
{
    public static Bearered(): FakeOciRegistry
    {
        const fake = new FakeOciRegistry(Base)
        fake.RequireBearer(User, Token)
        return fake
    }
}

test('a Bearer challenge is answered with Basic auth at the realm, then the request is retried with the issued bearer across two tag pages', async () =>
{
    const fake = Fixtures.Bearered()
    fake.SetTags('pragmatic-release', ['1.0.0', '1.0.1', '1.1.0'])
    fake.PaginateTags(2)
    const client = new OciRegistryClient(Base, fake.Fetch, { username: User, token: Token })

    assert.deepEqual(await client.ListTags('pragmatic-release'), ['1.0.0', '1.0.1', '1.1.0'])

    const tokenCall = fake.Requests.find(r => r.url.startsWith(Base + '/token'))
    assert.ok(tokenCall !== undefined)
    assert.equal(tokenCall.headers.Authorization, 'Basic ' + Buffer.from(`${User}:${Token}`).toString('base64'))
    assert.match(tokenCall.url, /scope=repository%3Apragmatic-release%3Apull%2Cpush/)
    assert.match(tokenCall.url, /service=registry\.test/)
    const listCalls = fake.Requests.filter(r => r.url.includes('/tags/list'))
    assert.equal(listCalls[0].headers.Authorization, undefined)
    assert.equal(listCalls[1].headers.Authorization, 'Bearer ' + fake.IssuedBearer)
    assert.equal(listCalls[2].headers.Authorization, 'Bearer ' + fake.IssuedBearer)
    assert.equal(fake.Requests.filter(r => r.url.startsWith(Base + '/token')).length, 1)
})

test('ListTags returns an empty list when the repository does not exist', async () =>
{
    const client = new OciRegistryClient(Base, new FakeOciRegistry(Base).Fetch)
    assert.deepEqual(await client.ListTags('absent'), [])
})

test('HeadManifest sends the four manifest media types and returns the digest of an OCI index', async () =>
{
    const fake = new FakeOciRegistry(Base)
    const bytes = new TextEncoder().encode('{"schemaVersion":2,"manifests":[]}')
    const digest = fake.PutManifest('pragmatic-env-server', '1.2.3', bytes, IndexType)
    const client = new OciRegistryClient(Base, fake.Fetch)

    assert.equal(await client.HeadManifest('pragmatic-env-server', '1.2.3'), digest)

    const head = fake.Requests.find(r => r.method === 'HEAD')
    assert.ok(head !== undefined)
    const accept = head.headers.Accept.split(', ')
    assert.deepEqual(accept, [
        IndexType,
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.docker.distribution.manifest.v2+json',
    ])
    assert.match(digest, /^sha256:[0-9a-f]{64}$/)
})

test('HeadManifest returns undefined on 404', async () =>
{
    const client = new OciRegistryClient(Base, new FakeOciRegistry(Base).Fetch)
    assert.equal(await client.HeadManifest('pragmatic-env-server', '9.9.9'), undefined)
})

test('PushArtifact then PullArtifactLayer round-trips the layer bytes, digest and annotations', async () =>
{
    const fake = Fixtures.Bearered()
    const client = new OciRegistryClient(Base, fake.Fetch, { username: User, token: Token })
    const layer = new TextEncoder().encode('{"release":"1.2.3"}')
    const annotations = { 'org.opencontainers.image.version': '1.2.3', 'io.pragmatic.note': 'x' }

    const manifestDigest = await client.PushArtifact('pragmatic-release', '1.2.3', 'application/vnd.pragmatic.release.v1+json', 'application/json', layer, annotations)
    const pulled = await client.PullArtifactLayer('pragmatic-release', '1.2.3')

    assert.deepEqual(Array.from(pulled.layer), Array.from(layer))
    assert.equal(pulled.layerDigest, OciRegistryClient.DigestOf(layer))
    assert.deepEqual(pulled.annotations, annotations)
    assert.equal(await client.HeadManifest('pragmatic-release', '1.2.3'), manifestDigest)
    assert.ok(fake.HasBlob('pragmatic-release', OciRegistryClient.DigestOf(new TextEncoder().encode('{}'))))
})

test('PullArtifactLayer rejects layer bytes that do not match the manifest digest', async () =>
{
    const fake = new FakeOciRegistry(Base)
    const client = new OciRegistryClient(Base, fake.Fetch)
    await client.PushArtifact('pragmatic-release', '1.2.3', 'application/vnd.x', 'application/json', new TextEncoder().encode('real'), {})
    fake.TamperBlobs(true)

    await assert.rejects(client.PullArtifactLayer('pragmatic-release', '1.2.3'), (e: unknown) => e instanceof OciResponseError)
})

test('a refused credential fails with a 401 OciResponseError that never contains the token', async () =>
{
    const fake = Fixtures.Bearered()
    const client = new OciRegistryClient(Base, fake.Fetch, { username: User, token: 'wrong-' + Token })

    await assert.rejects(client.ListTags('pragmatic-release'), (e: unknown) =>
    {
        assert.ok(e instanceof OciResponseError)
        assert.equal(e.status, 401)
        assert.equal(e.message, 'The OCI registry refused the credential')
        assert.ok(!e.message.includes(Token))
        assert.ok(!e.message.includes(Buffer.from(`${User}:wrong-${Token}`).toString('base64')))
        return true
    })
})

test('a second 401 after the bearer retry is refused, without looping', async () =>
{
    let calls = 0
    const stubborn: OciFetch = async (url) =>
    {
        calls++
        return url.includes('/token')
            ? new Response(JSON.stringify({ token: 'b' }), { status: 200 })
            : new Response(null, { status: 401, headers: { 'WWW-Authenticate': `Bearer realm="${Base}/token",service="s",scope="repository:r:pull"` } })
    }
    const client = new OciRegistryClient(Base, stubborn, { username: User, token: Token })

    await assert.rejects(client.ListTags('r'), (e: unknown) => e instanceof OciResponseError && e.status === 401 && !e.message.includes(Token))
    assert.equal(calls, 3)
})

test('a 401 without any credential is refused', async () =>
{
    const client = new OciRegistryClient(Base, Fixtures.Bearered().Fetch)
    await assert.rejects(client.ListTags('pragmatic-release'), (e: unknown) => e instanceof OciResponseError && e.status === 401)
})
