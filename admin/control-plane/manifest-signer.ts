import type { IImageDigest } from './image-digest.js'
import type { ImageSigner } from './image-signer.js'
import type { ISignatureStore } from './signature-store.js'

export type SignForPublishResult = { digest?: string; signed: boolean }

export interface IManifestSigner
{
    SignForPublish(imageRef: string): Promise<SignForPublishResult>
}

/**
 * Signs an image at publish time and reports honestly what happened. Never throws and never
 * carries key material: `signed` reflects the signature store, not the attempt.
 */
export class ManifestSigner implements IManifestSigner
{
    public constructor(
        private readonly digests: IImageDigest,
        private readonly signer: ImageSigner,
        private readonly store: ISignatureStore,
        private readonly signingKeyRef: string,
    )
    {
    }

    public async SignForPublish(imageRef: string): Promise<SignForPublishResult>
    {
        let digest: string
        try
        {
            digest = await this.digests.Of(imageRef)
        }
        catch
        {
            return { signed: false }
        }
        try
        {
            await this.signer.Sign(imageRef, this.signingKeyRef)
        }
        catch
        {
            // Swallowed on purpose: the store lookup below reports what is actually true.
        }
        let signed = false
        try
        {
            signed = (await this.store.Get(digest)) !== undefined
        }
        catch
        {
            signed = false
        }
        return { digest, signed }
    }
}
