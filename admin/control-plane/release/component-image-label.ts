import { OciRegistryClient, OciResponseError } from '../oci-registry-client.js'

/** Why an image's component label could not be read: one fixed sentence, never registry-supplied text. */
export enum ComponentLabelFault
{
    /** A manifest or config blob is not the JSON shape an OCI image has. */
    BadContent = 'image content is not an OCI image',
    /** Bytes the registry served do not hash to the digest they were asked for by. */
    DigestMismatch = 'image content does not match its digest',
    /** A manifest or config blob the image names is not in the registry. */
    MissingContent = 'image content missing',
    /** The label is there but is not a sha256 digest. */
    BadLabel = 'component label is not a sha256 digest',
    /** The platform images of one index carry different component digests (or only some of them carry one). */
    Inconsistent = 'platform images carry different component digests',
}

export class ComponentLabelError extends Error
{
    private static readonly ErrorName = 'ComponentLabelError'

    public constructor(public readonly Fault: ComponentLabelFault)
    {
        super(Fault)
        this.name = ComponentLabelError.ErrorName
    }
}

/**
 * The component descriptor an image carries: the JSON at `InImagePath` and its digest as the image config label `Name`
 * (the build writes both from the same descriptor and refuses a mismatch). `Read` follows an image reference by digest to
 * the label: an index (multi-arch, or one arch with build attestations) is read through every platform image it lists,
 * attestation manifests skipped, and all must carry the same digest. Every byte read is checked against its digest.
 * Imports only node builtins and builtin-only relative modules (the release workflow runs the publisher without npm install).
 */
export class ComponentImageLabel
{
    public static readonly Name = 'ai.pragmatic-tech.component.digest'
    public static readonly InImagePath = '/pragmatic/component.json'

    private static readonly DigestPattern = /^sha256:[0-9a-f]{64}$/
    private static readonly AttestationAnnotation = 'vnd.docker.reference.type'
    private static readonly AttestationType = 'attestation-manifest'
    private static readonly UnknownOs = 'unknown'
    private static readonly StatusNotFound = 404

    /** The component digest the image at `digest` carries; undefined when an image (or a platform image) has no label. */
    public static async Read(registry: OciRegistryClient, repo: string, digest: string): Promise<string | undefined>
    {
        const C = ComponentImageLabel
        const manifest = await C.PullJson(registry, repo, digest, true)
        const entries = manifest.manifests
        if (entries === undefined)
        {
            return C.LabelOf(registry, repo, manifest)
        }
        if (!Array.isArray(entries))
        {
            throw new ComponentLabelError(ComponentLabelFault.BadContent)
        }
        const labels: (string | undefined)[] = []
        for (const entry of entries)
        {
            if (!C.IsRecord(entry) || typeof entry.digest !== 'string')
            {
                throw new ComponentLabelError(ComponentLabelFault.BadContent)
            }
            if (!C.IsAttestation(entry))
            {
                labels.push(await C.LabelOf(registry, repo, await C.PullJson(registry, repo, entry.digest, true)))
            }
        }
        if (labels.length === 0)
        {
            throw new ComponentLabelError(ComponentLabelFault.BadContent)
        }
        if (labels.some(label => label !== labels[0]))
        {
            throw new ComponentLabelError(ComponentLabelFault.Inconsistent)
        }
        return labels[0]
    }

    /** The label of one platform image manifest: its config blob's `config.Labels[Name]`. */
    private static async LabelOf(registry: OciRegistryClient, repo: string, manifest: Record<string, unknown>): Promise<string | undefined>
    {
        const C = ComponentImageLabel
        const config = manifest.config
        if (!C.IsRecord(config) || typeof config.digest !== 'string')
        {
            throw new ComponentLabelError(ComponentLabelFault.BadContent)
        }
        const blob = await C.PullJson(registry, repo, config.digest, false)
        const runtime = blob.config
        if (runtime === undefined || runtime === null)
        {
            return undefined
        }
        if (!C.IsRecord(runtime))
        {
            throw new ComponentLabelError(ComponentLabelFault.BadContent)
        }
        const labels = runtime.Labels
        if (labels === undefined || labels === null)
        {
            return undefined
        }
        if (!C.IsRecord(labels))
        {
            throw new ComponentLabelError(ComponentLabelFault.BadContent)
        }
        const label = labels[C.Name]
        if (label === undefined)
        {
            return undefined
        }
        if (typeof label !== 'string' || !C.DigestPattern.test(label))
        {
            throw new ComponentLabelError(ComponentLabelFault.BadLabel)
        }
        return label
    }

    /** A manifest (or blob) by digest, checked against that digest and parsed as a JSON object. */
    private static async PullJson(registry: OciRegistryClient, repo: string, digest: string, manifest: boolean): Promise<Record<string, unknown>>
    {
        const C = ComponentImageLabel
        if (!C.DigestPattern.test(digest))
        {
            throw new ComponentLabelError(ComponentLabelFault.BadContent)
        }
        let bytes: Uint8Array
        try
        {
            bytes = manifest ? await registry.PullManifest(repo, digest) : await registry.PullBlob(repo, digest)
        }
        catch (error)
        {
            if (error instanceof OciResponseError && error.status === C.StatusNotFound)
            {
                throw new ComponentLabelError(ComponentLabelFault.MissingContent)
            }
            throw error
        }
        if (OciRegistryClient.DigestOf(bytes) !== digest)
        {
            throw new ComponentLabelError(ComponentLabelFault.DigestMismatch)
        }
        let parsed: unknown
        try
        {
            parsed = JSON.parse(new TextDecoder().decode(bytes))
        }
        catch
        {
            throw new ComponentLabelError(ComponentLabelFault.BadContent)
        }
        if (!C.IsRecord(parsed))
        {
            throw new ComponentLabelError(ComponentLabelFault.BadContent)
        }
        return parsed
    }

    /** A build attestation (provenance, SBOM) listed in an index next to the platform images: it has no image config. */
    private static IsAttestation(entry: Record<string, unknown>): boolean
    {
        const C = ComponentImageLabel
        const annotations = entry.annotations
        if (C.IsRecord(annotations) && annotations[C.AttestationAnnotation] === C.AttestationType)
        {
            return true
        }
        const platform = entry.platform
        return C.IsRecord(platform) && platform.os === C.UnknownOs
    }

    private static IsRecord(value: unknown): value is Record<string, unknown>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }
}
