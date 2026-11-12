import { ReleaseApp } from './portal-types.js'

// Single home for the order a release's images are shown in (mirrors the server's ReleaseApps.All).
export class ReleaseApps
{
    public static readonly All: readonly ReleaseApp[] = [
        ReleaseApp.PlatformAdmin,
        ReleaseApp.PlatformEdge,
        ReleaseApp.EnvServer,
        ReleaseApp.EnvGateway,
        ReleaseApp.HiveAgent,
        ReleaseApp.TenantAdmin,
        ReleaseApp.TenantIdp,
        ReleaseApp.UiUnpack,
    ]
}
