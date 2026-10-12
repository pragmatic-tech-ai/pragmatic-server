import { DeploymentMode } from '../platform/deployment-mode.js'
import type { PlatformServices } from '../platform/platform-services.js'
import type { ITenantProvisioning } from '../tenancy/tenant-provisioning.js'
import type { PragmaticServerHostOptions } from '../host/pragmatic-server-host.js'
import type { ServerConfig } from '../config/server-config.js'

export class ServerBootstrap
{
    private static readonly CloudNeedsPlatform = 'cloud deployment requires a configured platform (deferred backends)'

    public static ComposeOptions(config: ServerConfig, provisioning: ITenantProvisioning, platform?: PlatformServices): PragmaticServerHostOptions
    {
        if (config.deploymentMode === DeploymentMode.Cloud && platform === undefined)
        {
            throw new Error(ServerBootstrap.CloudNeedsPlatform)
        }
        return {
            host: config.host,
            port: config.port,
            baseDir: config.baseDir,
            masterKey: config.masterKey,
            provisioning,
            idleTtlMs: config.idleTtlMs,
            idleSweepMs: config.idleSweepMs,
            platform,
            deploymentMode: config.deploymentMode,
        }
    }

    public static StartupLine(config: ServerConfig): string
    {
        return `pragmatic-server listening on ${config.host}:${config.port} mode=${config.deploymentMode}`
    }
}
