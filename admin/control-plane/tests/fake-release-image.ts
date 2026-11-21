import { createHash } from 'node:crypto'
import { ComponentImageLabel } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { FakeOciRegistry } from './fake-oci-registry.js'

/** How a fake image is laid out: one image manifest, or an index of platform images (with a build attestation). */
export enum FakeImageLayout
{
    Single = 'single',
    Index = 'index',
}

/**
 * Release images in a FakeOciRegistry shaped as buildx pushes them: an image manifest naming a config blob whose
 * `config.Labels` carry the component descriptor digest, or an index of such manifests (amd64, arm64) plus an attestation
 * manifest. Content is derived from the app and version, so the same call yields the same digest (an image can be restored).
 */
export class FakeReleaseImage
{
    public static readonly ManifestType = 'application/vnd.oci.image.manifest.v1+json'
    public static readonly IndexType = 'application/vnd.oci.image.index.v1+json'
    private static readonly ConfigType = 'application/vnd.oci.image.config.v1+json'
    private static readonly AttestationAnnotation = 'vnd.docker.reference.type'
    private static readonly AttestationType = 'attestation-manifest'
    private static readonly Unknown = 'unknown'
    private static readonly Linux = 'linux'
    private static readonly Architectures = ['amd64', 'arm64']
    private static readonly DigestPrefix = 'sha256:'
    private static readonly Sha256 = 'sha256'
    private static readonly Hex = 'hex'
    private static readonly SchemaVersion = 2
    private static readonly Separator = ' '

    public constructor(private readonly registry: FakeOciRegistry)
    {
    }

    /** The component digest a fake app's image carries (stands for the digest of its component.json). */
    public static ComponentDigestOf(app: string): string
    {
        const S = FakeReleaseImage
        return S.DigestPrefix + createHash(S.Sha256).update(app).digest(S.Hex)
    }

    /**
     * Stores the image under `repo:tag` and returns its digest. `component` is the label value (null: no label);
     * `perPlatform` overrides it per platform image of an index.
     */
    public Put(repo: string, tag: string, content: string, layout: FakeImageLayout, component: string | null, perPlatform?: (string | null)[]): string
    {
        const S = FakeReleaseImage
        if (layout === FakeImageLayout.Single)
        {
            return this.registry.PutManifest(repo, tag, this.ManifestBytes(repo, content, component), S.ManifestType)
        }
        const manifests: Record<string, unknown>[] = S.Architectures.map((architecture, i) =>
        {
            const bytes = this.ManifestBytes(repo, content + S.Separator + architecture, perPlatform === undefined ? component : perPlatform[i])
            const digest = this.registry.PutManifest(repo, FakeOciRegistry.DigestOf(bytes), bytes, S.ManifestType)
            return { mediaType: S.ManifestType, digest, size: bytes.length, platform: { os: S.Linux, architecture } }
        })
        const attestation = this.ManifestBytes(repo, content + S.Separator + S.AttestationType, null)
        manifests.push({
            mediaType: S.ManifestType,
            digest: this.registry.PutManifest(repo, FakeOciRegistry.DigestOf(attestation), attestation, S.ManifestType),
            size: attestation.length,
            platform: { os: S.Unknown, architecture: S.Unknown },
            annotations: { [S.AttestationAnnotation]: S.AttestationType },
        })
        const index = new TextEncoder().encode(JSON.stringify({ schemaVersion: S.SchemaVersion, mediaType: S.IndexType, manifests }))
        return this.registry.PutManifest(repo, tag, index, S.IndexType)
    }

    /** An image manifest over a config blob (stored now) carrying the label, or none for null. */
    public ManifestBytes(repo: string, content: string, component: string | null): Uint8Array
    {
        const S = FakeReleaseImage
        const labels = component === null ? {} : { [ComponentImageLabel.Name]: component }
        const config = new TextEncoder().encode(JSON.stringify({ architecture: content, os: S.Linux, config: { Labels: labels } }))
        const digest = this.registry.PutBlob(repo, config)
        return new TextEncoder().encode(JSON.stringify({
            schemaVersion: S.SchemaVersion,
            mediaType: S.ManifestType,
            config: { mediaType: S.ConfigType, digest, size: config.length },
            layers: [],
        }))
    }
}
