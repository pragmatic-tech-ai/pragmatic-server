import { NodeExecFile, type IExecFile } from './kubectl.js'
import { ImageVerificationError } from './image-verifier.js'

export interface IImageDigest
{
    Of(imageRef: string): Promise<string>
}

/** Reads an image's content digest (its docker image id) from the local docker CLI. */
export class DockerImageDigest implements IImageDigest
{
    private static readonly Docker = 'docker'
    private static readonly ImageCommand = 'image'
    private static readonly InspectCommand = 'inspect'
    private static readonly FormatFlag = '--format'
    private static readonly IdTemplate = '{{.Id}}'

    public constructor(private readonly exec: IExecFile = new NodeExecFile())
    {
    }

    public async Of(imageRef: string): Promise<string>
    {
        const result = await this.exec.Run(DockerImageDigest.Docker, [
            DockerImageDigest.ImageCommand,
            DockerImageDigest.InspectCommand,
            imageRef,
            DockerImageDigest.FormatFlag,
            DockerImageDigest.IdTemplate,
        ])
        return result.stdout.trim()
    }
}

/**
 * An image reference that names no content digest, so no signature can be checked against it. It is an image verification
 * failure, so every path that shows one (installs, rollouts, environment bring-up) names the image instead of masking it.
 */
export class TagReferenceError extends ImageVerificationError
{
    private static readonly Prefix = 'Image '
    private static readonly Suffix = ' is not pinned by digest'
    private static readonly Reason = 'not pinned by digest'
    private static readonly TagErrorName = 'TagReferenceError'

    public constructor(imageRef: string)
    {
        super(imageRef, TagReferenceError.Reason)
        this.message = TagReferenceError.Prefix + imageRef + TagReferenceError.Suffix
        this.name = TagReferenceError.TagErrorName
    }
}

/**
 * Reads an image's digest from its registry reference (`…@sha256:<64 hex>`): the index digest a release names. It needs no
 * docker, so it serves a control plane that runs no containers; a tag reference is refused, never resolved.
 */
export class RegistryRefImageDigest implements IImageDigest
{
    private static readonly ByDigest = /@(sha256:[0-9a-f]{64})$/

    public async Of(imageRef: string): Promise<string>
    {
        const match = RegistryRefImageDigest.ByDigest.exec(imageRef)
        if (match === null)
        {
            throw new TagReferenceError(imageRef)
        }
        return match[1]
    }
}
