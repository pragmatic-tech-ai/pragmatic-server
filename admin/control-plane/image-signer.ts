import { createPrivateKey, sign } from 'node:crypto'
import type { IImageDigest } from './image-digest.js'
import type { ISignatureStore } from './signature-store.js'
import type { IKeyStore } from './key-store.js'

/** Signs an image's content digest with a dev Ed25519 private key and records it in the signature store. */
export class ImageSigner
{
    private static readonly Base64 = 'base64'

    public constructor(
        private readonly digests: IImageDigest,
        private readonly store: ISignatureStore,
        private readonly keys: IKeyStore,
    )
    {
    }

    public async Sign(imageRef: string, signingKeyRef: string): Promise<void>
    {
        const digest = await this.digests.Of(imageRef)
        const pem = await this.keys.PrivateKey(signingKeyRef)
        const signature = sign(null, Buffer.from(digest), createPrivateKey(pem)).toString(ImageSigner.Base64)
        await this.store.Put(digest, signature)
    }
}
