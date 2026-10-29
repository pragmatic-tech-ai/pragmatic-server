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
        if (this.endpoint === undefined || this.endpoint.length === 0)
        {
            return baseImage
        }
        return this.endpoint + EffectiveRegistry.PathSeparator + baseImage
    }
}
