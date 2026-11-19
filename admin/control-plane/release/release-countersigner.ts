import type { IImageSigner } from '../image-signer.js'

/** Adds the platform's own signature to a verified release's images, so hives trusting the platform key accept them. */
export interface IReleaseCountersigner
{
    Countersign(imageRefs: readonly string[]): Promise<void>
}

/**
 * Countersigns by-digest release images with the platform signing key through the shared image signer. A release has
 * already verified against its release key, so a failed countersign never undoes the import: it is logged per image, by
 * reference and error name only (an error message may carry registry or key-store text), and the next image is tried.
 */
export class PlatformReleaseCountersigner implements IReleaseCountersigner
{
    private static readonly FailurePrefix = 'Release countersign failed for '
    private static readonly FailureInfix = ': '
    private static readonly UnknownError = 'unknown error'

    public constructor(private readonly signer: IImageSigner, private readonly keyRef: string)
    {
    }

    public async Countersign(imageRefs: readonly string[]): Promise<void>
    {
        const S = PlatformReleaseCountersigner
        for (const imageRef of imageRefs)
        {
            try
            {
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
