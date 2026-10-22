import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSignatureStore } from '../signature-store.js'

class SignatureStoreFixture
{
    public static readonly Digest = 'sha256:abc123'
    public static readonly Signature = 'c2lnbmF0dXJl'
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
        await store.Put(SignatureStoreFixture.Digest, SignatureStoreFixture.Signature)
        assert.equal(await store.Get(SignatureStoreFixture.Digest), SignatureStoreFixture.Signature)
    })

    it('returns undefined for an unknown digest', async () =>
    {
        const store = new FileSignatureStore(path)
        await store.Put(SignatureStoreFixture.Digest, SignatureStoreFixture.Signature)
        assert.equal(await store.Get('sha256:other'), undefined)
    })

    it('returns undefined when the file does not exist', async () =>
    {
        const store = new FileSignatureStore(path)
        assert.equal(await store.Get(SignatureStoreFixture.Digest), undefined)
    })

    it('persists a JSON digest-to-signature map readable by a new instance', async () =>
    {
        await new FileSignatureStore(path).Put(SignatureStoreFixture.Digest, SignatureStoreFixture.Signature)
        const parsed = JSON.parse(await readFile(path, SignatureStoreFixture.Encoding))
        assert.deepEqual(parsed, { [SignatureStoreFixture.Digest]: SignatureStoreFixture.Signature })
        assert.equal(await new FileSignatureStore(path).Get(SignatureStoreFixture.Digest), SignatureStoreFixture.Signature)
    })
})
