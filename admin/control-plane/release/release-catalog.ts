import { OciProtocolError, OciProtocolFault, OciResponseError, OciUnavailableError } from '../oci-registry-client.js'
import type { OciRegistryClient } from '../oci-registry-client.js'
import { ReleaseState } from '../manifest-record.js'
import type { ManifestRecord, ManifestRelease } from '../manifest-record.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { ManifestExistsError, ReleaseNotRejectedError, ReleaseRegistryUnavailableError, UnknownManifestError } from '../rollout-errors.js'
import { ReleaseDescriptorCodec, ReleaseDescriptorInvalidError } from './release-descriptor.js'
import type { ReleaseDescriptor } from './release-descriptor.js'
import { ReleasePublisher } from './release-publisher.js'
import { ReleaseRegistry } from './release-registry.js'
import { ReleaseSignature } from './release-signature.js'
import { ReleaseApp, ReleaseApps, ReleaseTag, ReleaseTagInvalidError } from './release-tag.js'
import type { ReleaseTrustKeys } from './release-trust-keys.js'

/**
 * Versions imported by one refresh, split by outcome; how many listed versions were already imported releases; and the
 * listed versions hidden by a locally published manifest of the same id (never imported while that manifest exists).
 */
export type ReleaseRefreshResult = { imported: string[]; rejected: string[]; unchanged: number; shadowed: string[] }

type PulledDescriptor = { layer: Uint8Array; layerDigest: string; annotations: Record<string, string> }

/**
 * Lists the signed release descriptors in the registry and imports every version not yet in the manifest catalogue,
 * verified (descriptor signed by a trusted key, every image present at the signed digest with a valid signature) or
 * rejected with a reason naming only the failed check and the app or key id. Every version is inspected before any is
 * imported, so a registry that drops or refuses the credential mid-refresh leaves the catalogue untouched.
 */
export class ReleaseCatalog
{
    private static readonly NoImage = ''
    private static readonly StatusNotFound = 404
    /** An untrusted key id comes from the registry; it is named in the reason only when it has a plain identifier shape. */
    private static readonly PlainKeyId = /^[A-Za-z0-9._-]{1,64}$/
    /** One fixed sentence per way a descriptor artifact breaks the OCI protocol; never the registry's own text. */
    private static readonly ArtifactInvalid = 'descriptor artifact invalid'
    private static readonly BadManifestReason = ReleaseCatalog.ArtifactInvalid + ': not a single-layer manifest'
    private static readonly LayerMismatchReason = ReleaseCatalog.ArtifactInvalid + ': layer bytes do not match the manifest digest'
    private static readonly BadAnnotationsReason = ReleaseCatalog.ArtifactInvalid + ': manifest annotations are not strings'
    private static readonly ArtifactReasons: ReadonlyMap<OciProtocolFault, string> = new Map([
        [OciProtocolFault.BadManifest, ReleaseCatalog.BadManifestReason],
        [OciProtocolFault.LayerMismatch, ReleaseCatalog.LayerMismatchReason],
        [OciProtocolFault.BadAnnotations, ReleaseCatalog.BadAnnotationsReason],
    ])
    private static readonly DescriptorInvalid = 'descriptor invalid: '
    private static readonly KeyMissing = 'signing key missing'
    private static readonly KeyUntrusted = 'untrusted signing key'
    private static readonly ReasonSeparator = ': '
    private static readonly DescriptorSignatureInvalid = 'descriptor signature invalid: '
    private static readonly KeyMismatch = 'signing key mismatch: '
    private static readonly VersionMismatch = 'descriptor version mismatch'
    private static readonly ChannelMismatch = 'descriptor channel mismatch'
    private static readonly RepositoryMismatch = 'image repository mismatch: '
    private static readonly ImageMissing = 'image missing: '
    private static readonly DigestMismatch = 'image digest mismatch: '
    private static readonly ImageSignatureInvalid = 'image signature invalid: '

    /**
     * @param imageHost the registry host the by-digest image references are recorded under (`ghcr.io`, or the host of
     * PRAGMATIC_RELEASE_REGISTRY): the same registry the descriptors and images are read from.
     */
    public constructor(
        private readonly registry: OciRegistryClient,
        private readonly namespace: string,
        private readonly trust: ReleaseTrustKeys,
        private readonly deployments: PlatformDeploymentRegistry,
        private readonly imageHost: string = ReleaseRegistry.DefaultHost,
    )
    {
    }

    /**
     * Imports every listed version not yet recorded, and re-inspects every Rejected one: a version that now verifies (its
     * image tags restored, its key added to the trust dir) replaces the Rejected record and counts as imported; one still
     * failing keeps its record and counts as unchanged.
     */
    public async Refresh(): Promise<ReleaseRefreshResult>
    {
        const result: ReleaseRefreshResult = { imported: [], rejected: [], unchanged: 0, shadowed: [] }
        const pending: ManifestRecord[] = []
        const retried: ManifestRecord[] = []
        const known = new Map(this.deployments.AllManifests().map(m => [m.id, m]))
        try
        {
            for (const tag of await this.registry.ListTags(this.Repo(ReleasePublisher.DescriptorRepository)))
            {
                const release = ReleaseCatalog.ReleaseTagFor(tag)
                if (release === undefined)
                {
                    continue
                }
                const existing = known.get(release.Version)
                if (existing === undefined)
                {
                    const record = await this.Inspect(release)
                    if (record !== undefined)
                    {
                        pending.push(record)
                    }
                }
                else if (existing.release === undefined)
                {
                    result.shadowed.push(release.Version)
                }
                else if (existing.release.state === ReleaseState.Rejected)
                {
                    const record = await this.Inspect(release)
                    if (record?.release?.state === ReleaseState.Verified)
                    {
                        retried.push(record)
                    }
                    else
                    {
                        result.unchanged++
                    }
                }
                else
                {
                    result.unchanged++
                }
            }
        }
        catch (error)
        {
            if (error instanceof OciUnavailableError || error instanceof OciResponseError)
            {
                throw new ReleaseRegistryUnavailableError()
            }
            throw error
        }
        for (const record of pending)
        {
            try
            {
                await this.deployments.ImportRelease(record)
            }
            catch (error)
            {
                if (error instanceof ManifestExistsError)
                {
                    // A concurrent refresh (or publish) recorded the version since the listing: nothing changes here.
                    result.unchanged++
                    continue
                }
                throw error
            }
            const outcome = record.release?.state === ReleaseState.Verified ? result.imported : result.rejected
            outcome.push(record.id)
        }
        for (const record of retried)
        {
            try
            {
                await this.deployments.ReplaceRejectedRelease(record)
            }
            catch (error)
            {
                if (error instanceof ReleaseNotRejectedError || error instanceof UnknownManifestError)
                {
                    // A concurrent refresh replaced (or an operator removed) the record since the listing: nothing changes here.
                    result.unchanged++
                    continue
                }
                throw error
            }
            result.imported.push(record.id)
        }
        return result
    }

    /** The record for one listed version; undefined when its descriptor has vanished since the tag listing. */
    private async Inspect(tag: ReleaseTag): Promise<ManifestRecord | undefined>
    {
        const S = ReleaseCatalog
        let pulled: PulledDescriptor
        try
        {
            pulled = await this.registry.PullArtifactLayer(this.Repo(ReleasePublisher.DescriptorRepository), tag.Version)
        }
        catch (error)
        {
            if (error instanceof OciResponseError && error.status === S.StatusNotFound)
            {
                return undefined
            }
            if (S.IsTransportFailure(error))
            {
                throw error
            }
            // Anything else is this artifact's own fault (bad shape, bad annotations, altered bytes): reject it with the fixed
            // sentence for its cause, so one malformed descriptor neither blocks every refresh nor echoes registry-supplied text.
            return S.Rejected(tag, S.ArtifactReasonOf(error))
        }
        let descriptor: ReleaseDescriptor
        try
        {
            descriptor = ReleaseDescriptorCodec.Decode(pulled.layer)
        }
        catch (error)
        {
            if (error instanceof ReleaseDescriptorInvalidError)
            {
                return S.Rejected(tag, S.DescriptorInvalid + error.Reason)
            }
            throw error
        }
        const reason = await this.Verify(tag, pulled, descriptor)
        return reason === undefined ? this.Verified(descriptor) : S.Rejected(tag, reason)
    }

    /** The first failed check as a reason sentence, or undefined when the release verifies end to end. */
    private async Verify(tag: ReleaseTag, pulled: PulledDescriptor, descriptor: ReleaseDescriptor): Promise<string | undefined>
    {
        const S = ReleaseCatalog
        const keyId = pulled.annotations[ReleasePublisher.KeyAnnotation]
        if (keyId === undefined || keyId.length === 0)
        {
            return S.KeyMissing
        }
        const publicKey = this.trust.KeyFor(keyId)
        if (publicKey === undefined)
        {
            return S.PlainKeyId.test(keyId) ? S.KeyUntrusted + S.ReasonSeparator + keyId : S.KeyUntrusted
        }
        const signature = pulled.annotations[ReleasePublisher.SignatureAnnotation]
        if (signature === undefined || !ReleaseSignature.Verifies(pulled.layerDigest, signature, publicKey))
        {
            return S.DescriptorSignatureInvalid + keyId
        }
        if (descriptor.signingKeyId !== keyId)
        {
            return S.KeyMismatch + keyId
        }
        if (descriptor.version !== tag.Version)
        {
            return S.VersionMismatch
        }
        if (descriptor.channel !== tag.Channel)
        {
            return S.ChannelMismatch
        }
        for (const app of ReleaseApps.All)
        {
            const reason = await this.VerifyImage(app, descriptor, publicKey)
            if (reason !== undefined)
            {
                return reason
            }
        }
        return undefined
    }

    private async VerifyImage(app: ReleaseApp, descriptor: ReleaseDescriptor, publicKey: string): Promise<string | undefined>
    {
        const S = ReleaseCatalog
        const image = descriptor.images[app]
        const repository = this.Repo(app)
        if (image.repository !== repository)
        {
            return S.RepositoryMismatch + app
        }
        const current = await this.registry.HeadManifest(repository, descriptor.version)
        if (current === undefined)
        {
            return S.ImageMissing + app
        }
        if (current !== image.digest)
        {
            return S.DigestMismatch + app
        }
        if (!ReleaseSignature.Verifies(image.digest, image.signature, publicKey))
        {
            return S.ImageSignatureInvalid + app
        }
        return undefined
    }

    private Verified(descriptor: ReleaseDescriptor): ManifestRecord
    {
        const images = {} as NonNullable<ManifestRelease['images']>
        for (const app of ReleaseApps.All)
        {
            images[app] = { repository: descriptor.images[app].repository, digest: descriptor.images[app].digest }
        }
        const server = images[ReleaseApp.EnvServer]
        return {
            id: descriptor.version,
            channel: descriptor.channel,
            image: ReleaseRegistry.DigestReference(this.imageHost, server.repository, server.digest),
            digest: server.digest,
            signed: true,
            publishedAt: descriptor.builtAt,
            release: {
                state: ReleaseState.Verified,
                serverCommit: descriptor.serverCommit,
                siblingCommits: descriptor.siblingCommits,
                builtAt: descriptor.builtAt,
                signingKeyId: descriptor.signingKeyId,
                images,
            },
        }
    }

    /** A rejected release records no image: nothing about it is trusted, and it can never be gated. */
    private static Rejected(tag: ReleaseTag, reason: string): ManifestRecord
    {
        return {
            id: tag.Version,
            channel: tag.Channel,
            image: ReleaseCatalog.NoImage,
            signed: false,
            publishedAt: new Date().toISOString(),
            release: { state: ReleaseState.Rejected, rejectedReason: reason },
        }
    }

    /** The fixed sentence for a descriptor artifact that failed to pull for a reason of its own. */
    private static ArtifactReasonOf(error: unknown): string
    {
        const S = ReleaseCatalog
        return error instanceof OciProtocolError ? S.ArtifactReasons.get(error.Fault) ?? S.ArtifactInvalid : S.ArtifactInvalid
    }

    /** The release tag for a descriptor tag that is a release version; undefined for anything else (`latest`, `release-notes`). */
    private static ReleaseTagFor(tag: string): ReleaseTag | undefined
    {
        try
        {
            return ReleaseTag.FromVersion(tag)
        }
        catch (error)
        {
            if (error instanceof ReleaseTagInvalidError)
            {
                return undefined
            }
            throw error
        }
    }

    /**
     * Unreachable, or answered with a transport status (401 refused credential, 5xx, ...) rather than malformed content: the
     * registry, not the artifact, is at fault. Refresh turns these (and any OCI error outside a descriptor pull, such as an
     * unreadable tag list) into ReleaseRegistryUnavailableError, so nothing is imported.
     */
    private static IsTransportFailure(error: unknown): boolean
    {
        return error instanceof OciUnavailableError || (error instanceof OciResponseError && !(error instanceof OciProtocolError))
    }

    private Repo(name: string): string
    {
        return ReleaseRegistry.RepositoryPath(this.namespace, name)
    }
}
