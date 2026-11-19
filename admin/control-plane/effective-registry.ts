import { InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'

/**
 * Resolves a hive's RegistrySpec to a concrete registry endpoint and rewrites image
 * references to pull from it. An explicitly empty endpoint string means "no registry"
 * (shared-store fast path): images are left unchanged. Pull policy is not modelled here;
 * K8sManifestBuilder renders it.
 */
export class EffectiveRegistry
{
    private static readonly DefaultProvisionEndpoint = 'localhost:5000'
    private static readonly PathSeparator = '/'
    private static readonly DigestMarker = '@sha256:'
    private static readonly HostDot = '.'
    private static readonly HostPort = ':'
    private static readonly LocalhostHost = 'localhost'

    private constructor(
        private readonly endpoint: string | undefined,
        private readonly mode: InfraMode)
    {
    }

    public static For(hive: HiveRecord): EffectiveRegistry
    {
        const spec = hive.registry
        let endpoint = spec.endpoint
        if (endpoint === undefined && spec.mode === InfraMode.Provision)
        {
            endpoint = EffectiveRegistry.DefaultProvisionEndpoint
        }
        if (endpoint === '')
        {
            endpoint = undefined
        }
        if (endpoint !== undefined && endpoint.endsWith(EffectiveRegistry.PathSeparator))
        {
            endpoint = endpoint.slice(0, -EffectiveRegistry.PathSeparator.length)
        }
        return new EffectiveRegistry(endpoint, spec.mode)
    }

    public get Endpoint(): string | undefined
    {
        return this.endpoint
    }

    public get Mode(): InfraMode
    {
        return this.mode
    }

    public ImageRef(baseImage: string): string
    {
        if (this.endpoint === undefined || this.endpoint.length === 0 || EffectiveRegistry.IsFullReference(baseImage))
        {
            return baseImage
        }
        return this.endpoint + EffectiveRegistry.PathSeparator + baseImage
    }

    /** A reference pinned by digest, or one that already names its registry host, keeps where it comes from. */
    private static IsFullReference(image: string): boolean
    {
        if (image.includes(EffectiveRegistry.DigestMarker))
        {
            return true
        }
        const slash = image.indexOf(EffectiveRegistry.PathSeparator)
        if (slash < 0)
        {
            return false
        }
        const first = image.slice(0, slash)
        return first.includes(EffectiveRegistry.HostDot) || first.includes(EffectiveRegistry.HostPort) || first === EffectiveRegistry.LocalhostHost
    }
}
