import { DeploymentMode } from './deployment-mode.js'
import { NodePlatform } from './node-platform.js'
import type { PlatformServices } from './platform-services.js'

/** Resolves the PlatformServices bundle for a server: an explicitly-supplied bundle wins; otherwise the
 *  DeploymentMode selects one. Cloud requires an explicit bundle because pragmatic-server does not depend
 *  on the cloud platform package (fail-closed rather than silently falling back to the local set). */
export class PlatformSelector
{
    private static readonly CloudRequiresBundle = 'DeploymentMode.Cloud requires an explicit platform bundle'

    public static Resolve(platform: PlatformServices | undefined, mode: DeploymentMode): PlatformServices
    {
        if (platform !== undefined)
        {
            return platform
        }
        if (mode === DeploymentMode.Cloud)
        {
            throw new Error(PlatformSelector.CloudRequiresBundle)
        }
        return new NodePlatform()
    }
}
