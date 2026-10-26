import { OciRegistryClient } from './oci-registry-client.js'

/** A material-free failure packing or unpacking a UI artifact; the message is fixed and never echoes input. */
export class UiArtifactError extends Error
{
    public constructor(message: string)
    {
        super(message)
        this.name = 'UiArtifactError'
    }
}

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
    private static readonly DuplicatePathMessage = 'UI bundle contains a duplicate file path'
    private static readonly MalformedLayerMessage = 'UI layer blob is malformed'

    /** Packs the bundle. Layer keys and config assets are sorted, so the digest ignores input order. */
    public static Pack(config: UiArtifactConfig, files: readonly UiBundleFile[]): UiArtifactPacked
    {
        const encoder = new TextEncoder()
        const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        const layerMap: Record<string, string> = {}
        for (const f of sorted)
        {
            if (Object.prototype.hasOwnProperty.call(layerMap, f.path))
            {
                throw new UiArtifactError(UiArtifact.DuplicatePathMessage)
            }
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
        let map: Record<string, string>
        try
        {
            map = JSON.parse(new TextDecoder().decode(layerBlob)) as Record<string, string>
        }
        catch
        {
            throw new UiArtifactError(UiArtifact.MalformedLayerMessage)
        }
        if (map === null || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some(v => typeof v !== 'string'))
        {
            throw new UiArtifactError(UiArtifact.MalformedLayerMessage)
        }
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
