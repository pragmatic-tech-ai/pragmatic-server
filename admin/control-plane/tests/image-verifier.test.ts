import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IImageDigest } from '../image-digest.js'
import { FileKeyStore } from '../key-store.js'
import { FileSignatureStore } from '../signature-store.js'
import { CryptoImageVerifier, ImageVerificationError } from '../image-verifier.js'
import { ImageSigner } from '../image-signer.js'

class FakeDigest implements IImageDigest
{
    public constructor(public value: string)
    {
    }

    public async Of(_imageRef: string): Promise<string>
    {
        return this.value
    }
}

class VerifierFixture
{
    public static readonly Image = 'registry.local/app:1'
    public static readonly DigestA = 'sha256:A'
    public static readonly DigestB = 'sha256:B'
    public static readonly SignerKey = 'dev-key'
    public static readonly OtherPublic = 'other-pub'
    public static readonly SigFile = 'signatures.json'
    public static readonly TempPrefix = 'verifier-'
    public static readonly Encoding = 'utf8'
    public static readonly PemMarker = '-----BEGIN'
    public static readonly KeyType = 'ed25519'
    public static readonly SpkiFormat = 'spki'
    public static readonly Pkcs8Format = 'pkcs8'
    public static readonly PemType = 'pem'
}

describe('CryptoImageVerifier + ImageSigner', () =>
{
    let dir: string
    let digest: FakeDigest
    let store: FileSignatureStore
    let keys: FileKeyStore
    let signer: ImageSigner
    let verifier: CryptoImageVerifier

    beforeEach(async () =>
    {
        dir = await mkdtemp(join(tmpdir(), VerifierFixture.TempPrefix))
        const pair = generateKeyPairSync(VerifierFixture.KeyType)
        const other = generateKeyPairSync(VerifierFixture.KeyType)
        const pub = (k: typeof pair.publicKey): string => k.export({ type: VerifierFixture.SpkiFormat, format: VerifierFixture.PemType }) as string
        await writeFile(join(dir, `${VerifierFixture.SignerKey}${FileKeyStore.PrivateSuffix}`),
            pair.privateKey.export({ type: VerifierFixture.Pkcs8Format, format: VerifierFixture.PemType }) as string, VerifierFixture.Encoding)
        await writeFile(join(dir, `${VerifierFixture.SignerKey}${FileKeyStore.PublicSuffix}`), pub(pair.publicKey), VerifierFixture.Encoding)
        await writeFile(join(dir, `${VerifierFixture.OtherPublic}${FileKeyStore.PublicSuffix}`), pub(other.publicKey), VerifierFixture.Encoding)
        digest = new FakeDigest(VerifierFixture.DigestA)
        store = new FileSignatureStore(join(dir, VerifierFixture.SigFile))
        keys = new FileKeyStore(dir)
        signer = new ImageSigner(digest, store, keys)
        verifier = new CryptoImageVerifier(digest, store, keys)
    })

    afterEach(async () =>
    {
        await rm(dir, { recursive: true, force: true })
    })

    it('round-trips sign then verify', async () =>
    {
        await signer.Sign(VerifierFixture.Image, VerifierFixture.SignerKey)
        await verifier.Verify(VerifierFixture.Image, VerifierFixture.SignerKey)
    })

    it('rejects a digest mismatch (tamper)', async () =>
    {
        await signer.Sign(VerifierFixture.Image, VerifierFixture.SignerKey)
        digest.value = VerifierFixture.DigestB
        await assert.rejects(verifier.Verify(VerifierFixture.Image, VerifierFixture.SignerKey), ImageVerificationError)
    })

    it('rejects an unsigned image', async () =>
    {
        await assert.rejects(verifier.Verify(VerifierFixture.Image, VerifierFixture.SignerKey), ImageVerificationError)
    })

    it('fails closed on an undefined or empty trust root', async () =>
    {
        await signer.Sign(VerifierFixture.Image, VerifierFixture.SignerKey)
        await assert.rejects(verifier.Verify(VerifierFixture.Image, undefined), ImageVerificationError)
        await assert.rejects(verifier.Verify(VerifierFixture.Image, ''), ImageVerificationError)
    })

    it('rejects verification with the wrong public key', async () =>
    {
        await signer.Sign(VerifierFixture.Image, VerifierFixture.SignerKey)
        await assert.rejects(verifier.Verify(VerifierFixture.Image, VerifierFixture.OtherPublic), /no signature/)
    })

    it('rejects a signature filed under a key that did not make it (signature invalid)', async () =>
    {
        await signer.Sign(VerifierFixture.Image, VerifierFixture.SignerKey)
        const sig = (await store.Get(VerifierFixture.DigestA, VerifierFixture.SignerKey)) as string
        await store.Put(VerifierFixture.DigestA, VerifierFixture.OtherPublic, sig)
        await assert.rejects(verifier.Verify(VerifierFixture.Image, VerifierFixture.OtherPublic), /signature invalid/)
    })

    it('does not leak signature or key bytes in the error', async () =>
    {
        await signer.Sign(VerifierFixture.Image, VerifierFixture.SignerKey)
        const sig = (await store.Get(VerifierFixture.DigestA, VerifierFixture.SignerKey)) as string
        await store.Put(VerifierFixture.DigestA, VerifierFixture.OtherPublic, sig)
        let message = ''
        try
        {
            await verifier.Verify(VerifierFixture.Image, VerifierFixture.OtherPublic)
        }
        catch (err)
        {
            message = (err as Error).message
        }
        assert.ok(message.includes(VerifierFixture.Image))
        assert.ok(!message.includes(sig))
        assert.ok(!message.includes(VerifierFixture.PemMarker))
    })
})
