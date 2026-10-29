import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import type { IImageDigest } from '../image-digest.js'
import type { IKeyStore } from '../key-store.js'
import { KeyNotFoundError } from '../key-store.js'
import type { ISignatureStore } from '../signature-store.js'
import { ImageSigner } from '../image-signer.js'
import { ManifestSigner } from '../manifest-signer.js'

class SignerFixture
{
    public static readonly Image = 'registry.local/app:1'
    public static readonly Digest = 'sha256:abc'
    public static readonly KeyRef = 'dev-priv'
    public static readonly MissingRef = 'no-such-key'
    public static readonly Existing = 'pre-existing-signature'
    public static readonly InspectFailure = 'docker inspect failed'
    public static readonly KeyType = 'ed25519'
    public static readonly Pkcs8Format = 'pkcs8'
    public static readonly PemType = 'pem'
}

class FakeDigest implements IImageDigest
{
    public constructor(private readonly value: string | undefined)
    {
    }

    public async Of(_imageRef: string): Promise<string>
    {
        if (this.value === undefined)
        {
            throw new Error(SignerFixture.InspectFailure)
        }
        return this.value
    }
}

class MemoryStore implements ISignatureStore
{
    public readonly map = new Map<string, string>()

    public async Get(digest: string): Promise<string | undefined>
    {
        return this.map.get(digest)
    }

    public async Put(digest: string, signature: string): Promise<void>
    {
        this.map.set(digest, signature)
    }
}

class MemoryKeys implements IKeyStore
{
    public constructor(private readonly pem: string)
    {
    }

    public async PublicKey(ref: string): Promise<string>
    {
        throw new KeyNotFoundError(ref)
    }

    public async PrivateKey(ref: string): Promise<string>
    {
        if (ref !== SignerFixture.KeyRef)
        {
            throw new KeyNotFoundError(ref)
        }
        return this.pem
    }
}

class SignerHarness
{
    public readonly store = new MemoryStore()
    public readonly subject: ManifestSigner

    public constructor(digest: string | undefined, keyRef: string)
    {
        const pair = generateKeyPairSync(SignerFixture.KeyType)
        const pem = pair.privateKey.export({ type: SignerFixture.Pkcs8Format, format: SignerFixture.PemType }) as string
        const digests = new FakeDigest(digest)
        const signer = new ImageSigner(digests, this.store, new MemoryKeys(pem))
        this.subject = new ManifestSigner(digests, signer, this.store, keyRef)
    }
}

describe('ManifestSigner', () =>
{
    it('signs and reports signed when digest and key are available', async () =>
    {
        const h = new SignerHarness(SignerFixture.Digest, SignerFixture.KeyRef)
        const result = await h.subject.SignForPublish(SignerFixture.Image)
        assert.deepEqual(result, { digest: SignerFixture.Digest, signed: true })
        assert.ok(h.store.map.get(SignerFixture.Digest))
    })

    it('reports unsigned without a digest when the image cannot be inspected', async () =>
    {
        const h = new SignerHarness(undefined, SignerFixture.KeyRef)
        const result = await h.subject.SignForPublish(SignerFixture.Image)
        assert.equal(result.digest, undefined)
        assert.equal(result.signed, false)
    })

    it('keeps the digest but reports unsigned when signing fails', async () =>
    {
        const h = new SignerHarness(SignerFixture.Digest, SignerFixture.MissingRef)
        const result = await h.subject.SignForPublish(SignerFixture.Image)
        assert.deepEqual(result, { digest: SignerFixture.Digest, signed: false })
    })

    it('reports signed from the store truthfully', async () =>
    {
        const h = new SignerHarness(SignerFixture.Digest, SignerFixture.MissingRef)
        await h.store.Put(SignerFixture.Digest, SignerFixture.Existing)
        const result = await h.subject.SignForPublish(SignerFixture.Image)
        assert.deepEqual(result, { digest: SignerFixture.Digest, signed: true })
    })
})
