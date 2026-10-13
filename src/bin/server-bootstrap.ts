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
import type { ILogger } from '../observability/logger.js'
import type { Observability, IObservabilityOptions, ObservabilityRole } from '../observability/observability.js'
import type { OtlpProtocol } from '../observability/otlp-protocol.js'

export class ServerBootstrap
{
    private static readonly CloudNeedsPlatform = 'cloud deployment requires a configured platform (deferred backends)'
    private static readonly RedisOwnership = 'redis'
    private static readonly InMemoryOwnership = 'in-memory'
    private static readonly OidcFlowToken = ' oidc-flow='
    private static readonly SecretsFile = 'file'
    private static readonly SecretsNone = 'none'
    private static readonly HealthOff = 'off'
    private static readonly ServerNameDefault = 'default'
    private static readonly ClientMtlsOn = 'on'
    private static readonly ClientMtlsOff = 'off'
    private static readonly ClientMtlsLabel = ' client-mtls='
    private static readonly OtelOn = 'on'
    private static readonly OtelOff = 'off'
    private static readonly OtelLabel = ' otel='
    private static readonly WorkerNeedsTls = 'worker requires TLS (set PRAGMATIC_TLS_CERT_FILE/KEY_FILE/CA_FILE)'

    public static ComposeOptions(config: ServerConfig, provisioning: ITenantProvisioning, platform?: PlatformServices, provisionedSecrets?: IProvisionedSecretSource, logger?: ILogger, observability?: Observability): PragmaticServerHostOptions
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
            logger,
            observability,
        }
    }

    public static StartupLine(config: ServerConfig, tenantCount: number): string
    {
        const ownership = ServerBootstrap.HasRedis(config) ? ServerBootstrap.RedisOwnership : ServerBootstrap.InMemoryOwnership
        const secrets = config.provisionedSecretsFile !== undefined && config.provisionedSecretsFile.length > 0 ? ServerBootstrap.SecretsFile : ServerBootstrap.SecretsNone
        return `pragmatic-server listening on ${config.host}:${config.port} mode=${config.deploymentMode} tenants=${tenantCount} ownership=${ownership} secrets=${secrets}${ServerBootstrap.ClientMtls(config.clientTls)}${ServerBootstrap.OidcFlowToken}${ownership}${ServerBootstrap.Otel(config)}`
    }

    public static ComposeWorkerOptions(config: ServerConfig, provisioning: ITenantProvisioning, provisionedSecrets?: IProvisionedSecretSource, logger?: ILogger, observability?: Observability): WorkerHostOptions
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
            logger,
            observability,
        }
    }

    public static ComposeGatewayOptions(gw: GatewayConfig, router: IWorkerRouter, logger?: ILogger): GatewayOptions
    {
        return {
            host: gw.host,
            port: gw.port,
            router,
            tls: gw.tls,
            serverName: gw.workerServerName,
            clientTls: gw.clientTls,
            logger,
        }
    }

    public static WorkerStartupLine(config: ServerConfig): string
    {
        const ownership = ServerBootstrap.HasRedis(config) ? ServerBootstrap.RedisOwnership : ServerBootstrap.InMemoryOwnership
        return `pragmatic-worker listening on ${config.host}:${config.port} mode=${config.deploymentMode} ownership=${ownership} health=${config.healthPort ?? ServerBootstrap.HealthOff}${ServerBootstrap.Otel(config)}`
    }

    public static GatewayStartupLine(gw: GatewayConfig): string
    {
        return `pragmatic-gateway listening on ${gw.host}:${gw.port} servername=${gw.workerServerName ?? ServerBootstrap.ServerNameDefault}${ServerBootstrap.ClientMtls(gw.clientTls)}${ServerBootstrap.Otel(gw)}`
    }

    public static OtelEnabled(config: { metricsPort?: number; otlpEndpoint?: string; otlpMetrics?: boolean }): boolean
    {
        const tracing = config.otlpEndpoint !== undefined && config.otlpEndpoint.length > 0
        const metrics = config.metricsPort !== undefined || config.otlpMetrics === true
        return tracing || metrics
    }

    public static ObservabilityOptions(config: { serviceName?: string; replicaId?: string; metricsPort?: number; otlpEndpoint?: string; otlpProtocol?: OtlpProtocol; otlpMetrics?: boolean; traceSampling?: number }, role: ObservabilityRole, replicaId?: string): IObservabilityOptions | undefined
    {
        if (!ServerBootstrap.OtelEnabled(config))
        {
            return undefined
        }
        return {
            role,
            serviceName: config.serviceName,
            replicaId: replicaId ?? config.replicaId,
            metricsPort: config.metricsPort,
            otlpEndpoint: config.otlpEndpoint,
            otlpProtocol: config.otlpProtocol,
            otlpMetrics: config.otlpMetrics,
            traceSampling: config.traceSampling,
        }
    }

    private static Otel(config: { metricsPort?: number; otlpEndpoint?: string; otlpMetrics?: boolean }): string
    {
        return ServerBootstrap.OtelLabel + (ServerBootstrap.OtelEnabled(config) ? ServerBootstrap.OtelOn : ServerBootstrap.OtelOff)
    }

    private static HasRedis(config: ServerConfig): boolean
    {
        return config.redisUrl !== undefined && config.redisUrl.length > 0
    }

    private static ClientMtls(clientTls: MachineTlsRef | undefined): string
    {
        return ServerBootstrap.ClientMtlsLabel + (clientTls !== undefined ? ServerBootstrap.ClientMtlsOn : ServerBootstrap.ClientMtlsOff)
    }
}
