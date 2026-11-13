import { OciRegistryClient } from '../oci-registry-client.js'
import { ReleaseDescriptorCodec, type ReleaseDescriptor, type ReleaseImage } from './release-descriptor.js'
import { ReleaseRegistry } from './release-registry.js'
import { ReleaseSignature } from './release-signature.js'
import { ReleaseApps, type ReleaseApp, type ReleaseTag } from './release-tag.js'
import { ReleaseTrustKeys } from './release-trust-keys.js'

/** The published descriptor and the digest of its encoded bytes (the layer digest the registry records and the signature covers). */
export type ReleasePublishResult = { descriptor: ReleaseDescriptor; descriptorDigest: string }

export type ReleasePublishInput = {
    tag: ReleaseTag
    serverCommit: string
    siblingCommits: Record<string, string>
    signingKeyId: string
    privateKeyPem: string
    /** The trusted public key for `signingKeyId` (`release-keys/<id>.pub.pem`): every signature is checked against it before the push. */
    trustedPublicKeyPem: string
}

/**
 * The signing key does not produce signatures the trusted public key verifies. Publishing anyway would record a descriptor
 * every platform rejects, burning the version, so nothing is pushed.
 */
export class ReleaseSigningKeyMismatchError extends Error
{
    private static readonly ErrorName = 'ReleaseSigningKeyMismatchError'
    private static readonly MessagePrefix = 'The signing key does not match the trusted public key '
    private static readonly MessageSuffix = '; nothing was published'
    private static readonly PathSeparator = '/'

    public constructor(public readonly KeyId: string)
    {
        super(ReleaseSigningKeyMismatchError.MessagePrefix + ReleaseTrustKeys.DirName + ReleaseSigningKeyMismatchError.PathSeparator
            + KeyId + ReleaseTrustKeys.Suffix + ReleaseSigningKeyMismatchError.MessageSuffix)
        this.name = ReleaseSigningKeyMismatchError.ErrorName
    }
}

/** A release descriptor already exists for the version; releases are immutable. */
export class ReleaseVersionExistsError extends Error
{
    private static readonly ErrorName = 'ReleaseVersionExistsError'
    private static readonly MessagePrefix = 'Release already published: '

    public constructor(public readonly Version: string)
    {
        super(ReleaseVersionExistsError.MessagePrefix + Version)
        this.name = ReleaseVersionExistsError.ErrorName
    }
}

/** An image of the release is not in the registry under the release version tag. */
export class ReleaseImageMissingError extends Error
{
    private static readonly ErrorName = 'ReleaseImageMissingError'
    private static readonly MessagePrefix = 'Release image missing: '
    private static readonly VersionSeparator = ':'

    public constructor(public readonly App: ReleaseApp, public readonly Version: string)
    {
        super(ReleaseImageMissingError.MessagePrefix + App + ReleaseImageMissingError.VersionSeparator + Version)
        this.name = ReleaseImageMissingError.ErrorName
    }
}

/**
 * Signs the digest of every image tagged with the release version and publishes the signed release descriptor as an OCI
 * artifact. The descriptor is pushed last, so its existence means every image was present and signed.
 */
export class ReleasePublisher
{
    public static readonly DescriptorRepository = 'pragmatic-release'
    public static readonly ArtifactType = 'application/vnd.pragmatic.release.v1'
    public static readonly LayerMediaType = 'application/vnd.pragmatic.release.v1+json'
    public static readonly SignatureAnnotation = 'org.pragmatic.release.signature'
    public static readonly KeyAnnotation = 'org.pragmatic.release.key'
    private static readonly SchemaVersion = 1

    public constructor(
        private readonly registry: OciRegistryClient,
        private readonly namespace: string,
        private readonly clock: () => Date = () => new Date(),
    )
    {
    }

    public async CheckVersionFree(version: string): Promise<void>
    {
        const existing = await this.registry.HeadManifest(this.repo(ReleasePublisher.DescriptorRepository), version)
        if (existing !== undefined)
        {
            throw new ReleaseVersionExistsError(version)
        }
    }

    public async Publish(input: ReleasePublishInput): Promise<ReleasePublishResult>
    {
        const S = ReleasePublisher
        const version = input.tag.Version
        await this.CheckVersionFree(version)
        const images: Partial<Record<ReleaseApp, ReleaseImage>> = {}
        for (const app of ReleaseApps.All)
        {
            const repository = this.repo(app)
            const digest = await this.registry.HeadManifest(repository, version)
            if (digest === undefined)
            {
                throw new ReleaseImageMissingError(app, version)
            }
            images[app] = { repository, digest, signature: ReleaseSignature.Sign(digest, input.privateKeyPem) }
        }
        const descriptor: ReleaseDescriptor = {
            schema: S.SchemaVersion,
            version,
            channel: input.tag.Channel,
            serverCommit: input.serverCommit,
            siblingCommits: input.siblingCommits,
            builtAt: this.clock().toISOString(),
            signingKeyId: input.signingKeyId,
            images: images as ReleaseDescriptor['images'],
        }
        const bytes = ReleaseDescriptorCodec.Encode(descriptor)
        const descriptorDigest = OciRegistryClient.DigestOf(bytes)
        const signature = ReleaseSignature.Sign(descriptorDigest, input.privateKeyPem)
        S.AssertVerifies(bytes, descriptorDigest, signature, input)
        await this.registry.PushArtifact(this.repo(S.DescriptorRepository), version, S.ArtifactType, S.LayerMediaType, bytes, {
            [S.SignatureAnnotation]: signature,
            [S.KeyAnnotation]: input.signingKeyId,
        })
        return { descriptor, descriptorDigest }
    }

    /**
     * What the platform's catalogue will check, run on the bytes about to be pushed: the descriptor decodes, and its signature
     * and every image signature verify against the trusted public key. Throws before any push when one does not.
     */
    private static AssertVerifies(bytes: Uint8Array, descriptorDigest: string, signature: string, input: ReleasePublishInput): void
    {
        const decoded = ReleaseDescriptorCodec.Decode(bytes)
        const key = input.trustedPublicKeyPem
        if (!ReleaseSignature.Verifies(descriptorDigest, signature, key))
        {
            throw new ReleaseSigningKeyMismatchError(input.signingKeyId)
        }
        for (const app of ReleaseApps.All)
        {
            const image = decoded.images[app]
            if (!ReleaseSignature.Verifies(image.digest, image.signature, key))
            {
                throw new ReleaseSigningKeyMismatchError(input.signingKeyId)
            }
        }
    }

    private repo(name: string): string
    {
        return ReleaseRegistry.RepositoryPath(this.namespace, name)
    }
}
