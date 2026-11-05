import { existsSync, readFileSync } from 'node:fs'
import { ImageVerificationError, type IImageVerifier } from './image-verifier.js'

/**
 * An image ref the platform verified (signature against the hive's trust root) and approved for this hive. A plain ref
 * allow-list: the console cannot reach the platform's digest/signature stores, so no digest is carried or checked here.
 */
export type VerifiedImage = { imageRef: string }

/** The verified-images file is not a JSON array of `{ imageRef }` entries; names the file only. */
export class InvalidVerifiedImagesError extends Error
{
    private static readonly ErrorName = 'InvalidVerifiedImagesError'
    private static readonly MessagePrefix = 'The verified images file is not a JSON array of { imageRef } entries: '

    public constructor(path: string)
    {
        super(InvalidVerifiedImagesError.MessagePrefix + path)
        this.name = InvalidVerifiedImagesError.ErrorName
    }
}

/**
 * An image ref the console may not run: the platform approved only the server image of the console's install. `Sentence` is what
 * the operator sees: run a newer release by reinstalling the console, which approves the platform's current server image.
 */
export class ImageNotApprovedError extends ImageVerificationError
{
    private static readonly NotApprovedErrorName = 'ImageNotApprovedError'
    private static readonly SentencePrefix = 'The hive refused to run image '
    private static readonly SentenceSuffix = ': the console runs only the server image the platform approved when the console was installed. Reinstall the console from the platform portal to approve the new server image.'

    public readonly Sentence: string

    public constructor(imageRef: string)
    {
        super(imageRef, PinnedImageVerifier.NotVerifiedReason)
        this.name = ImageNotApprovedError.NotApprovedErrorName
        this.Sentence = ImageNotApprovedError.SentencePrefix + imageRef + ImageNotApprovedError.SentenceSuffix
    }
}

/**
 * The console's image gate: admits exactly the refs the platform pinned for this hive (the server image of the console's install);
 * everything else is refused with ImageNotApprovedError, which tells the operator to reinstall the console after a platform release.
 */
export class PinnedImageVerifier implements IImageVerifier
{
    public static readonly NotVerifiedReason = 'not verified for this hive by the platform'
    private static readonly Utf8 = 'utf8'

    private readonly refs: ReadonlySet<string>

    public constructor(images: readonly VerifiedImage[])
    {
        this.refs = new Set(images.map(i => i.imageRef))
    }

    /** Reads a JSON array of VerifiedImage; a missing file yields a verifier that refuses everything. */
    public static Load(path: string): PinnedImageVerifier
    {
        if (!existsSync(path))
        {
            return new PinnedImageVerifier([])
        }
        let parsed: unknown
        try
        {
            parsed = JSON.parse(readFileSync(path, PinnedImageVerifier.Utf8)) as unknown
        }
        catch
        {
            throw new InvalidVerifiedImagesError(path)
        }
        if (!Array.isArray(parsed) || !parsed.every(PinnedImageVerifier.IsVerifiedImage))
        {
            throw new InvalidVerifiedImagesError(path)
        }
        return new PinnedImageVerifier(parsed)
    }

    /** The trust root is the platform's concern (it verified before pinning); here only the pinned ref matters. */
    public async Verify(imageRef: string, _trustRootRef: string | undefined): Promise<void>
    {
        if (!this.refs.has(imageRef))
        {
            throw new ImageNotApprovedError(imageRef)
        }
    }

    private static IsVerifiedImage(value: unknown): value is VerifiedImage
    {
        return typeof value === 'object' && value !== null && typeof (value as { imageRef?: unknown }).imageRef === 'string'
    }
}
