import { OciProtocolError, OciResponseError, OciUnavailableError } from '../oci-registry-client.js'
import type { OciRegistryClient } from '../oci-registry-client.js'
import { ReleaseState } from '../manifest-record.js'
import type { ManifestRecord, ManifestRelease } from '../manifest-record.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { ReleaseRegistryUnavailableError } from '../rollout-errors.js'
import { ReleaseDescriptorCodec, ReleaseDescriptorInvalidError } from './release-descriptor.js'
import type { ReleaseDescriptor } from './release-descriptor.js'
import { ReleasePublisher } from './release-publisher.js'
import { ReleaseSignature } from './release-signature.js'
import { ReleaseApp, ReleaseApps, ReleaseTag, ReleaseTagInvalidError } from './release-tag.js'
import type { ReleaseTrustKeys } from './release-trust-keys.js'

/** Versions imported by one refresh, split by outcome, and how many listed versions were already in the catalogue. */
export type ReleaseRefreshResult = { imported: string[]; rejected: string[]; unchanged: number }

type PulledDescriptor = { layer: Uint8Array; layerDigest: string; annotations: Record<string, string> }

/**
 * Lists the signed release descriptors in the registry and imports every version not yet in the manifest catalogue,
 * verified (descriptor signed by a trusted key, every image present at the signed digest with a valid signature) or
 * rejected with a reason naming only the failed check and the app or key id. Every version is inspected before any is
 * imported, so a registry that drops or refuses the credential mid-refresh leaves the catalogue untouched.
 */
export class ReleaseCatalog
{
    private static readonly RegistryHost = 'ghcr.io/'
    private static readonly PathSeparator = '/'
    private static readonly DigestSeparator = '@'
    private static readonly TagPrefix = 'release/'
    private static readonly NoImage = ''
    private static readonly StatusNotFound = 404
    /** An untrusted key id comes from the registry; it is named in the reason only when it has a plain identifier shape. */
    private static readonly PlainKeyId = /^[A-Za-z0-9._-]{1,64}$/
    private static readonly ArtifactInvalid = 'descriptor artifact invalid: '
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

    public constructor(
        private readonly registry: OciRegistryClient,
        private readonly namespace: string,
        private readonly trust: ReleaseTrustKeys,
        private readonly deployments: PlatformDeploymentRegistry,
    )
    {
    }

    public async Refresh(): Promise<ReleaseRefreshResult>
    {
        const result: ReleaseRefreshResult = { imported: [], rejected: [], unchanged: 0 }
        const pending: ManifestRecord[] = []
        const known = new Set(this.deployments.AllManifests().map(m => m.id))
        try
        {
            for (const tag of await this.registry.ListTags(this.Repo(ReleasePublisher.DescriptorRepository)))
            {
                const release = ReleaseCatalog.ReleaseTagFor(tag)
                if (release === undefined)
                {
                    continue
                }
                if (known.has(release.Version))
                {
                    result.unchanged++
                    continue
                }
                const record = await this.Inspect(release)
                if (record !== undefined)
                {
                    pending.push(record)
                }
            }
        }
        catch (error)
        {
            if (ReleaseCatalog.IsUnavailable(error))
            {
                throw new ReleaseRegistryUnavailableError()
            }
            throw error
        }
        for (const record of pending)
        {
            await this.deployments.ImportRelease(record)
            const outcome = record.release?.state === ReleaseState.Verified ? result.imported : result.rejected
            outcome.push(record.id)
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
            if (error instanceof OciProtocolError)
            {
                return S.Rejected(tag, S.ArtifactInvalid + error.message)
            }
            if (error instanceof OciResponseError && error.status === S.StatusNotFound)
            {
                return undefined
            }
            throw error
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
        const S = ReleaseCatalog
        const images = {} as NonNullable<ManifestRelease['images']>
        for (const app of ReleaseApps.All)
        {
            images[app] = { repository: descriptor.images[app].repository, digest: descriptor.images[app].digest }
        }
        const server = images[ReleaseApp.EnvServer]
        return {
            id: descriptor.version,
            channel: descriptor.channel,
            image: S.RegistryHost + server.repository + S.DigestSeparator + server.digest,
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

    /** The release tag for a descriptor tag that is a release version; undefined for anything else (`latest`, `release-notes`). */
    private static ReleaseTagFor(tag: string): ReleaseTag | undefined
    {
        try
        {
            return ReleaseTag.Parse(ReleaseCatalog.TagPrefix + tag)
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
     * Unreachable, credential refused (401), or any other unexpected answer outside a descriptor pull (an unreadable tag
     * list, a 5xx, a HEAD without a digest): the registry as a whole cannot be read, so nothing is imported.
     */
    private static IsUnavailable(error: unknown): boolean
    {
        return error instanceof OciUnavailableError || error instanceof OciResponseError
    }

    private Repo(name: string): string
    {
        return this.namespace + ReleaseCatalog.PathSeparator + name
    }
}
