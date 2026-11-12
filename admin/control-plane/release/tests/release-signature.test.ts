import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { CryptoImageVerifier } from '../../image-verifier.js'
import { ReleaseSignature } from '../release-signature.js'

class KeyFixture
{
    public readonly Private: string
    public readonly Public: string

    public constructor()
    {
        const pair = generateKeyPairSync('ed25519')
        this.Private = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        this.Public = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    }
}

describe('ReleaseSignature', () =>
{
    const digest = `sha256:${'a'.repeat(64)}`

    it('verifies what it signs', () =>
    {
        const key = new KeyFixture()
        const signature = ReleaseSignature.Sign(digest, key.Private)
        assert.equal(ReleaseSignature.Verifies(digest, signature, key.Public), true)
    })

    it('rejects a different digest', () =>
    {
        const key = new KeyFixture()
        const signature = ReleaseSignature.Sign(digest, key.Private)
        assert.equal(ReleaseSignature.Verifies(`sha256:${'b'.repeat(64)}`, signature, key.Public), false)
    })

    it('rejects another key', () =>
    {
        const signature = ReleaseSignature.Sign(digest, new KeyFixture().Private)
        assert.equal(ReleaseSignature.Verifies(digest, signature, new KeyFixture().Public), false)
    })

    it('returns false for a garbage signature or key without throwing', () =>
    {
        const key = new KeyFixture()
        assert.equal(ReleaseSignature.Verifies(digest, Buffer.alloc(64, 7).toString('base64'), key.Public), false)
        assert.equal(ReleaseSignature.Verifies(digest, '%%%not-base64%%%', key.Public), false)
        assert.equal(ReleaseSignature.Verifies(digest, 'c2ln', 'not a pem'), false)
    })

    it('produces signatures CryptoImageVerifier accepts', async () =>
    {
        const key = new KeyFixture()
        const signature = ReleaseSignature.Sign(digest, key.Private)
        const verifier = new CryptoImageVerifier(
            { Of: async () => digest },
            { Get: async () => signature } as never,
            { PublicKey: async () => key.Public } as never,
        )
        await verifier.Verify('img:1', 'root')
    })
})
