import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore } from '../key-store.js'
import { UiArtifactSigner, UiArtifactVerifier, UiSignatureError } from '../ui-artifact-signer.js'

class UiSignerFixture
{
    public static readonly App = 'orders-ui'
    public static readonly Version = '1.2.3'
    public static readonly Digest = 'sha256:abc'
    public static readonly KeyA = 'key-a'
    public static readonly KeyB = 'key-b'
    public static readonly TmpPrefix = 'ui-signer-'
    public static readonly Pem = 'pem'
    public static readonly Spki = 'spki'
    public static readonly Pkcs8 = 'pkcs8'
    public static readonly Ed25519 = 'ed25519'

    public dir = ''
    public signer!: UiArtifactSigner
    public verifier!: UiArtifactVerifier

    public async Setup(): Promise<void>
    {
        this.dir = await mkdtemp(join(tmpdir(), UiSignerFixture.TmpPrefix))
        await this.WriteKey(UiSignerFixture.KeyA)
        await this.WriteKey(UiSignerFixture.KeyB)
        const keys = new FileKeyStore(this.dir)
        this.signer = new UiArtifactSigner(keys)
        this.verifier = new UiArtifactVerifier(keys)
    }

    public async Teardown(): Promise<void>
    {
        await rm(this.dir, { recursive: true, force: true })
    }

    public Sign(): Promise<string>
    {
        return this.signer.Sign(UiSignerFixture.App, UiSignerFixture.Version, UiSignerFixture.Digest, UiSignerFixture.KeyA)
    }

    private async WriteKey(ref: string): Promise<void>
    {
        const pair = generateKeyPairSync(UiSignerFixture.Ed25519)
        await writeFile(join(this.dir, `${ref}${FileKeyStore.PublicSuffix}`), pair.publicKey.export({ type: UiSignerFixture.Spki, format: UiSignerFixture.Pem }))
        await writeFile(join(this.dir, `${ref}${FileKeyStore.PrivateSuffix}`), pair.privateKey.export({ type: UiSignerFixture.Pkcs8, format: UiSignerFixture.Pem }))
    }
}

describe('UiArtifactSigner / UiArtifactVerifier', () =>
{
    const fx = new UiSignerFixture()
    beforeEach(() => fx.Setup())
    afterEach(() => fx.Teardown())

    it('a signature verifies against the same identity + digest', async () =>
    {
        const sig = await fx.Sign()
        await fx.verifier.Verify(UiSignerFixture.App, UiSignerFixture.Version, UiSignerFixture.Digest, sig, UiSignerFixture.KeyA)
    })

    it('verification fails closed when appVersion is changed', async () =>
    {
        const sig = await fx.Sign()
        await assert.rejects(fx.verifier.Verify(UiSignerFixture.App, '9.9.9', UiSignerFixture.Digest, sig, UiSignerFixture.KeyA), UiSignatureError)
    })

    it('verification fails closed when the manifestDigest is changed', async () =>
    {
        const sig = await fx.Sign()
        await assert.rejects(fx.verifier.Verify(UiSignerFixture.App, UiSignerFixture.Version, 'sha256:other', sig, UiSignerFixture.KeyA), UiSignatureError)
    })

    it('verification fails closed when appName is changed', async () =>
    {
        const sig = await fx.Sign()
        await assert.rejects(fx.verifier.Verify('other-ui', UiSignerFixture.Version, UiSignerFixture.Digest, sig, UiSignerFixture.KeyA), UiSignatureError)
    })

    it('a missing trust root rejects (fail-closed)', async () =>
    {
        const sig = await fx.Sign()
        await assert.rejects(fx.verifier.Verify(UiSignerFixture.App, UiSignerFixture.Version, UiSignerFixture.Digest, sig, undefined), UiSignatureError)
    })

    it('a signature from a different key does not verify', async () =>
    {
        const sig = await fx.Sign()
        await assert.rejects(fx.verifier.Verify(UiSignerFixture.App, UiSignerFixture.Version, UiSignerFixture.Digest, sig, UiSignerFixture.KeyB), UiSignatureError)
    })

    it('the thrown error names no key material or signature bytes', async () =>
    {
        const sig = await fx.Sign()
        await assert.rejects(
            fx.verifier.Verify(UiSignerFixture.App, UiSignerFixture.Version, UiSignerFixture.Digest, sig, UiSignerFixture.KeyB),
            (err: Error) =>
            {
                assert.equal(err.message, UiSignatureError.SafeMessage)
                assert.ok(!err.message.includes(sig))
                return true
            })
    })
})
