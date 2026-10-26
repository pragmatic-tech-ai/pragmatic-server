import { OciRegistryClient } from './oci-registry-client.js'

export interface UiBundleFile
{
    path: string
    bytes: Uint8Array
}

export interface UiArtifactConfig
{
    appName: string
    appVersion: string
    entry: string
    assets: readonly string[]
}

export interface UiArtifactPacked
{
    manifestBytes: Uint8Array
    manifestDigest: string
    configBlob: Uint8Array
    layerBlob: Uint8Array
}

interface UiBlobDescriptor
{
    mediaType: string
    digest: string
    size: number
}

/** Packs a UI bundle into an OCI config blob + JSON layer blob + image manifest, reproducibly, and unpacks it. */
export class UiArtifact
{
    private static readonly ConfigMediaType = 'application/vnd.pragmatic.ui.config.v1+json'
    private static readonly LayerMediaType = 'application/vnd.pragmatic.ui.layer.v1+json'
    private static readonly ManifestMediaType = 'application/vnd.oci.image.manifest.v1+json'
    private static readonly SchemaVersion = 2
    private static readonly Base64 = 'base64'

    /** Packs the bundle. Layer keys and config assets are sorted, so the digest ignores input order. */
    public static Pack(config: UiArtifactConfig, files: readonly UiBundleFile[]): UiArtifactPacked
    {
        const encoder = new TextEncoder()
        const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        const layerMap: Record<string, string> = {}
        for (const f of sorted)
        {
            layerMap[f.path] = Buffer.from(f.bytes).toString(UiArtifact.Base64)
        }
        const layerBlob = encoder.encode(JSON.stringify(layerMap))
        const orderedConfig: UiArtifactConfig =
        {
            appName: config.appName,
            appVersion: config.appVersion,
            entry: config.entry,
            assets: [...config.assets].sort(),
        }
        const configBlob = encoder.encode(JSON.stringify(orderedConfig))
        const manifest =
        {
            schemaVersion: UiArtifact.SchemaVersion,
            mediaType: UiArtifact.ManifestMediaType,
            config: UiArtifact.Describe(UiArtifact.ConfigMediaType, configBlob),
            layers: [UiArtifact.Describe(UiArtifact.LayerMediaType, layerBlob)],
        }
        const manifestBytes = encoder.encode(JSON.stringify(manifest))
        return { manifestBytes, manifestDigest: UiArtifact.ManifestDigestOf(manifestBytes), configBlob, layerBlob }
    }

    public static Unpack(layerBlob: Uint8Array): UiBundleFile[]
    {
        const map = JSON.parse(new TextDecoder().decode(layerBlob)) as Record<string, string>
        return Object.keys(map).map(path => ({ path, bytes: new Uint8Array(Buffer.from(map[path], UiArtifact.Base64)) }))
    }

    public static ManifestDigestOf(manifestBytes: Uint8Array): string
    {
        return OciRegistryClient.DigestOf(manifestBytes)
    }

    private static Describe(mediaType: string, blob: Uint8Array): UiBlobDescriptor
    {
        return { mediaType, digest: OciRegistryClient.DigestOf(blob), size: blob.byteLength }
    }
}
