import type { IImageSigner } from '../image-signer.js'
import { RegistryRefImageDigest } from '../image-digest.js'
import type { ISignatureStore } from '../signature-store.js'

/** Adds the platform's own signature to a verified release's images, so hives trusting the platform key accept them. */
export interface IReleaseCountersigner
{
    Countersign(imageRefs: readonly string[]): Promise<void>
}

/**
 * Countersigns by-digest release images with the platform signing key through the shared image signer. A release has
 * already verified against its release key, so a failed countersign never undoes the import: it is logged per image, by
 * reference and error name only (an error message may carry registry or key-store text), and the next image is tried.
 * Given the signature store, an image the platform key already signed is skipped, so every refresh can offer every verified
 * release: a countersign that failed once (or a release imported before countersigning existed) lands on a later refresh.
 */
export class PlatformReleaseCountersigner implements IReleaseCountersigner
{
    private static readonly FailurePrefix = 'Release countersign failed for '
    private static readonly FailureInfix = ': '
    private static readonly UnknownError = 'unknown error'

    private readonly digests = new RegistryRefImageDigest()

    public constructor(private readonly signer: IImageSigner, private readonly keyRef: string, private readonly signed?: ISignatureStore)
    {
    }

    public async Countersign(imageRefs: readonly string[]): Promise<void>
    {
        const S = PlatformReleaseCountersigner
        for (const imageRef of imageRefs)
        {
            try
            {
                if (this.signed !== undefined && await this.signed.HasKeyed(await this.digests.Of(imageRef), this.keyRef))
                {
                    continue
                }
                await this.signer.Sign(imageRef, this.keyRef)
            }
            catch (error)
            {
                const name = error instanceof Error ? error.name : S.UnknownError
                console.warn(S.FailurePrefix + imageRef + S.FailureInfix + name)
            }
        }
    }
}
