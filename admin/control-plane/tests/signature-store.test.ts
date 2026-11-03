import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSignatureStore, SignatureStoreCorruptError } from '../signature-store.js'

class SignatureStoreFixture
{
    public static readonly Digest = 'sha256:abc123'
    public static readonly Signature = 'c2lnbmF0dXJl'
    public static readonly OtherSignature = 'b3RoZXI='
    public static readonly KeyRef = 'platform-signing'
    public static readonly OtherKeyRef = 'acme'
    public static readonly FileName = 'signatures.json'
    public static readonly TempPrefix = 'sigstore-'
    public static readonly Encoding = 'utf8'
}

describe('FileSignatureStore', () =>
{
    let dir: string
    let path: string

    beforeEach(async () =>
    {
        dir = await mkdtemp(join(tmpdir(), SignatureStoreFixture.TempPrefix))
        path = join(dir, SignatureStoreFixture.FileName)
    })

    afterEach(async () =>
    {
        await rm(dir, { recursive: true, force: true })
    })

    it('round-trips a Put then Get', async () =>
    {
        const store = new FileSignatureStore(path)
        await store.Put(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef, SignatureStoreFixture.Signature)
        assert.equal(await store.Get(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), SignatureStoreFixture.Signature)
    })

    it('keeps every signature when several are put at once', async () =>
    {
        const store = new FileSignatureStore(path)
        const digests = ['sha256:a', 'sha256:b', 'sha256:c', 'sha256:d']
        await Promise.all(digests.map(d => store.Put(d, SignatureStoreFixture.KeyRef, SignatureStoreFixture.Signature)))
        for (const d of digests)
        {
            assert.equal(await store.Get(d, SignatureStoreFixture.KeyRef), SignatureStoreFixture.Signature)
        }
    })

    it('keeps every signature when separate instances on the same file put at once', async () =>
    {
        const digests = ['sha256:a', 'sha256:b', 'sha256:c', 'sha256:d']
        await Promise.all(digests.map(d => new FileSignatureStore(path).Put(d, SignatureStoreFixture.KeyRef, SignatureStoreFixture.Signature)))
        for (const d of digests)
        {
            assert.equal(await new FileSignatureStore(path).Get(d, SignatureStoreFixture.KeyRef), SignatureStoreFixture.Signature)
        }
    })

    it('two keys signing the same digest keep both signatures, and a key never sees another key\'s signature', async () =>
    {
        const store = new FileSignatureStore(path)
        await store.Put(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef, SignatureStoreFixture.Signature)
        await store.Put(SignatureStoreFixture.Digest, SignatureStoreFixture.OtherKeyRef, SignatureStoreFixture.OtherSignature)
        assert.equal(await store.Get(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), SignatureStoreFixture.Signature)
        assert.equal(await store.Get(SignatureStoreFixture.Digest, SignatureStoreFixture.OtherKeyRef), SignatureStoreFixture.OtherSignature)
        assert.equal(await store.Get(SignatureStoreFixture.Digest, 'third'), undefined)
    })

    it('HasKeyed counts only a signature filed under that key, never a pre-keyed entry', async () =>
    {
        await writeFile(path, JSON.stringify({ [SignatureStoreFixture.Digest]: SignatureStoreFixture.Signature }), SignatureStoreFixture.Encoding)
        const store = new FileSignatureStore(path)
        assert.equal(await store.HasKeyed(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), false)
        await store.Put(SignatureStoreFixture.Digest, SignatureStoreFixture.OtherKeyRef, SignatureStoreFixture.OtherSignature)
        assert.equal(await store.HasKeyed(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), false)
        assert.equal(await store.HasKeyed(SignatureStoreFixture.Digest, SignatureStoreFixture.OtherKeyRef), true)
        assert.equal(await store.HasKeyed(SignatureStoreFixture.Digest, ''), false)
        assert.equal(await store.HasKeyed('sha256:none', SignatureStoreFixture.KeyRef), false)
    })

    it('answers a file written before signatures were keyed, and keeps that signature when a keyed one is added', async () =>
    {
        await writeFile(path, JSON.stringify({ [SignatureStoreFixture.Digest]: SignatureStoreFixture.Signature }), SignatureStoreFixture.Encoding)
        const store = new FileSignatureStore(path)
        assert.equal(await store.Get(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), SignatureStoreFixture.Signature)
        await store.Put(SignatureStoreFixture.Digest, SignatureStoreFixture.OtherKeyRef, SignatureStoreFixture.OtherSignature)
        assert.equal(await store.Get(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), SignatureStoreFixture.Signature)
        assert.equal(await store.Get(SignatureStoreFixture.Digest, SignatureStoreFixture.OtherKeyRef), SignatureStoreFixture.OtherSignature)
    })

    it('returns undefined for an unknown digest', async () =>
    {
        const store = new FileSignatureStore(path)
        await store.Put(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef, SignatureStoreFixture.Signature)
        assert.equal(await store.Get('sha256:other', SignatureStoreFixture.KeyRef), undefined)
    })

    it('returns undefined when the file does not exist', async () =>
    {
        const store = new FileSignatureStore(path)
        assert.equal(await store.Get(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), undefined)
    })

    it('persists a JSON digest-to-key-to-signature map readable by a new instance', async () =>
    {
        await new FileSignatureStore(path).Put(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef, SignatureStoreFixture.Signature)
        const parsed = JSON.parse(await readFile(path, SignatureStoreFixture.Encoding))
        assert.deepEqual(parsed, { [SignatureStoreFixture.Digest]: { [SignatureStoreFixture.KeyRef]: SignatureStoreFixture.Signature } })
        assert.equal(await new FileSignatureStore(path).Get(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), SignatureStoreFixture.Signature)
    })

    it('throws a fixed-message error naming only the path for a non-JSON file', async () =>
    {
        const planted = 'SECRETSIG-not-json'
        await writeFile(path, planted, SignatureStoreFixture.Encoding)
        await assert.rejects(() => new FileSignatureStore(path).Get(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), (err: Error) =>
        {
            assert.ok(err instanceof SignatureStoreCorruptError)
            assert.ok(err.message.includes(path))
            assert.ok(!err.message.includes(planted))
            return true
        })
    })

    it('throws the corrupt error for a null or array JSON file', async () =>
    {
        for (const body of ['null', '["SECRETSIG"]', '{"sha256:a":null}', '{"sha256:a":5}', '{"sha256:a":{"k":5}}', '{"sha256:a":["x"]}'])
        {
            await writeFile(path, body, SignatureStoreFixture.Encoding)
            await assert.rejects(() => new FileSignatureStore(path).Get(SignatureStoreFixture.Digest, SignatureStoreFixture.KeyRef), SignatureStoreCorruptError)
        }
    })
})
