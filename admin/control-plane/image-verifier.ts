import { createPublicKey, verify } from 'node:crypto'
import type { IImageDigest } from './image-digest.js'
import type { ISignatureStore } from './signature-store.js'
import type { IKeyStore } from './key-store.js'

export interface IImageVerifier
{
    Verify(imageRef: string, trustRootRef: string | undefined): Promise<void>
}

/** Names the image ref only; never carries signature, digest, or key material. */
export class ImageVerificationError extends Error
{
    private static readonly ErrorName = 'ImageVerificationError'
    private static readonly MessagePrefix = 'image signature verification failed: '

    public constructor(imageRef: string, reason: string)
    {
        super(`${ImageVerificationError.MessagePrefix}${imageRef} (${reason})`)
        this.name = ImageVerificationError.ErrorName
    }
}

/** Verifies an image digest's Ed25519 signature against the hive's trust-root public key; fails closed. */
export class CryptoImageVerifier implements IImageVerifier
{
    private static readonly NoTrustRoot = 'no trust root configured'
    private static readonly NoSignature = 'no signature'
    private static readonly InvalidSignature = 'signature invalid'
    private static readonly Base64 = 'base64'

    public constructor(
        private readonly digests: IImageDigest,
        private readonly store: ISignatureStore,
        private readonly keys: IKeyStore,
    )
    {
    }

    public async Verify(imageRef: string, trustRootRef: string | undefined): Promise<void>
    {
        if (trustRootRef === undefined || trustRootRef.length === 0)
        {
            throw new ImageVerificationError(imageRef, CryptoImageVerifier.NoTrustRoot)
        }
        const digest = await this.digests.Of(imageRef)
        const signature = await this.store.Get(digest)
        if (signature === undefined)
        {
            throw new ImageVerificationError(imageRef, CryptoImageVerifier.NoSignature)
        }
        const pem = await this.keys.PublicKey(trustRootRef)
        let valid = false
        try
        {
            valid = verify(null, Buffer.from(digest), createPublicKey(pem), Buffer.from(signature, CryptoImageVerifier.Base64))
        }
        catch
        {
            valid = false
        }
        if (!valid)
        {
            throw new ImageVerificationError(imageRef, CryptoImageVerifier.InvalidSignature)
        }
    }
}
