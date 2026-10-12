import { DeploymentMode } from '../platform/deployment-mode.js'
import type { PlatformServices } from '../platform/platform-services.js'
import type { ITenantProvisioning } from '../tenancy/tenant-provisioning.js'
import type { PragmaticServerHostOptions } from '../host/pragmatic-server-host.js'
import type { ServerConfig } from '../config/server-config.js'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'

export class ServerBootstrap
{
    private static readonly CloudNeedsPlatform = 'cloud deployment requires a configured platform (deferred backends)'
    private static readonly RedisOwnership = 'redis'
    private static readonly InMemoryOwnership = 'in-memory'
    private static readonly SecretsFile = 'file'
    private static readonly SecretsNone = 'none'

    public static ComposeOptions(config: ServerConfig, provisioning: ITenantProvisioning, platform?: PlatformServices, provisionedSecrets?: IProvisionedSecretSource): PragmaticServerHostOptions
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
            redisUrl: config.redisUrl,
            replicaId: config.replicaId,
            provisionedSecrets,
        }
    }

    public static StartupLine(config: ServerConfig, tenantCount: number): string
    {
        const ownership = config.redisUrl !== undefined ? ServerBootstrap.RedisOwnership : ServerBootstrap.InMemoryOwnership
        const secrets = config.provisionedSecretsFile !== undefined && config.provisionedSecretsFile.length > 0 ? ServerBootstrap.SecretsFile : ServerBootstrap.SecretsNone
        return `pragmatic-server listening on ${config.host}:${config.port} mode=${config.deploymentMode} tenants=${tenantCount} ownership=${ownership} secrets=${secrets}`
    }
}
