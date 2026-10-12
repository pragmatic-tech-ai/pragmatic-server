import { DeploymentMode } from './deployment-mode.js'
import { NodePlatform } from './node-platform.js'
import type { PlatformServices } from './platform-services.js'

/** Resolves the PlatformServices bundle for a server: an explicitly-supplied bundle wins; otherwise the
 *  DeploymentMode selects one. Only Local builds a bundle in-package (NodePlatform); every other mode —
 *  Cloud today, and any mode added later without its own branch — requires an explicit bundle and throws
 *  otherwise, because pragmatic-server depends on no cloud platform package (fail-closed, never a silent
 *  fall back to the local set). */
export class PlatformSelector
{
    private static readonly RequiresBundle = ' requires an explicit platform bundle'

    public static Resolve(platform: PlatformServices | undefined, mode: DeploymentMode): PlatformServices
    {
        if (platform !== undefined)
        {
            return platform
        }
        if (mode === DeploymentMode.Local)
        {
            return new NodePlatform()
        }
        // Cloud requires an injected bundle built via CloudPlatform.Create (external resources cannot be synthesized here).
        throw new Error(`${mode}${PlatformSelector.RequiresBundle}`)
    }
}
