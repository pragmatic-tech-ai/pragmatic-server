import { DeploymentMode } from '../platform/deployment-mode.js'
import type { PlatformServices } from '../platform/platform-services.js'
import type { ITenantProvisioning } from '../tenancy/tenant-provisioning.js'
import type { PragmaticServerHostOptions } from '../host/pragmatic-server-host.js'
import type { ServerConfig, GatewayConfig } from '../config/server-config.js'
import type { WorkerHostOptions } from '../cluster/worker-host.js'
import type { GatewayOptions } from '../cluster/gateway.js'
import type { MachineTlsRef } from '../cluster/machine-tls.js'
import type { IWorkerRouter } from '../cluster/worker-router.js'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'

export class ServerBootstrap
{
    private static readonly CloudNeedsPlatform = 'cloud deployment requires a configured platform (deferred backends)'
    private static readonly RedisOwnership = 'redis'
    private static readonly InMemoryOwnership = 'in-memory'
    private static readonly SecretsFile = 'file'
    private static readonly SecretsNone = 'none'
    private static readonly HealthOff = 'off'
    private static readonly ServerNameDefault = 'default'
    private static readonly ClientMtlsOn = 'on'
    private static readonly ClientMtlsOff = 'off'
    private static readonly ClientMtlsLabel = ' client-mtls='
    private static readonly WorkerNeedsTls = 'worker requires TLS (set PRAGMATIC_TLS_CERT_FILE/KEY_FILE/CA_FILE)'

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
            clientTls: config.clientTls,
        }
    }

    public static StartupLine(config: ServerConfig, tenantCount: number): string
    {
        const ownership = config.redisUrl !== undefined ? ServerBootstrap.RedisOwnership : ServerBootstrap.InMemoryOwnership
        const secrets = config.provisionedSecretsFile !== undefined && config.provisionedSecretsFile.length > 0 ? ServerBootstrap.SecretsFile : ServerBootstrap.SecretsNone
        return `pragmatic-server listening on ${config.host}:${config.port} mode=${config.deploymentMode} tenants=${tenantCount} ownership=${ownership} secrets=${secrets}${ServerBootstrap.ClientMtls(config.clientTls)}`
    }

    public static ComposeWorkerOptions(config: ServerConfig, provisioning: ITenantProvisioning, provisionedSecrets?: IProvisionedSecretSource): WorkerHostOptions
    {
        if (config.tls === undefined)
        {
            throw new Error(ServerBootstrap.WorkerNeedsTls)
        }
        const advertise = config.workerAdvertiseHost !== undefined && config.workerAdvertisePort !== undefined
            ? { host: config.workerAdvertiseHost, port: config.workerAdvertisePort }
            : undefined
        return {
            host: config.host,
            port: config.port,
            baseDir: config.baseDir,
            masterKey: config.masterKey,
            provisioning,
            tls: config.tls,
            idleTtlMs: config.idleTtlMs,
            idleSweepMs: config.idleSweepMs,
            platform: undefined,
            deploymentMode: config.deploymentMode,
            redisUrl: config.redisUrl,
            replicaId: config.replicaId,
            provisionedSecrets,
            healthPort: config.healthPort,
            advertise,
        }
    }

    public static ComposeGatewayOptions(gw: GatewayConfig, router: IWorkerRouter): GatewayOptions
    {
        return {
            host: gw.host,
            port: gw.port,
            router,
            tls: gw.tls,
            serverName: gw.workerServerName,
            clientTls: gw.clientTls,
        }
    }

    public static WorkerStartupLine(config: ServerConfig): string
    {
        const ownership = config.redisUrl !== undefined ? ServerBootstrap.RedisOwnership : ServerBootstrap.InMemoryOwnership
        return `pragmatic-worker listening on ${config.host}:${config.port} mode=${config.deploymentMode} ownership=${ownership} health=${config.healthPort ?? ServerBootstrap.HealthOff}`
    }

    public static GatewayStartupLine(gw: GatewayConfig): string
    {
        return `pragmatic-gateway listening on ${gw.host}:${gw.port} servername=${gw.workerServerName ?? ServerBootstrap.ServerNameDefault}${ServerBootstrap.ClientMtls(gw.clientTls)}`
    }

    private static ClientMtls(clientTls: MachineTlsRef | undefined): string
    {
        return ServerBootstrap.ClientMtlsLabel + (clientTls !== undefined ? ServerBootstrap.ClientMtlsOn : ServerBootstrap.ClientMtlsOff)
    }
}
