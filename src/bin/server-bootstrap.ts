import { DeploymentMode, type ServerConfig, type Observability, PagingLimits, type IAccessAuditSink, type RateLimitGuard, HostBootstrap } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { PlatformServices } from '../platform/platform-services.js'
import type { IEnvironmentProvisioning } from '../environments/environment-provisioning.js'
import type { PragmaticServerHostOptions } from '../host/pragmatic-server-host.js'
import type { WorkerHostOptions } from '../cluster/worker-host.js'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'
import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { CypherLimits } from '../config/cypher-limits.js'

/**
 * The environment server's and its workers' host options and startup lines from their configuration; what they share with
 * the gateway (observability, audit sink, rate limit, the common startup tokens) is HostBootstrap's.
 */
export class ServerBootstrap
{
    private static readonly CloudNeedsPlatform = 'cloud deployment requires a configured platform (deferred backends)'
    private static readonly RedisOwnership = 'redis'
    private static readonly InMemoryOwnership = 'in-memory'
    private static readonly OidcFlowToken = ' oidc-flow='
    private static readonly SecretsFile = 'file'
    private static readonly SecretsNone = 'none'
    private static readonly HealthOff = 'off'
    private static readonly AuditAnchorLabel = ' audit-anchor='
    private static readonly AuditAnchorOn = 'on'
    private static readonly AuditAnchorOff = 'off'
    private static readonly WorkerNeedsTls = 'worker requires TLS (set PRAGMATIC_TLS_CERT_FILE/KEY_FILE/CA_FILE)'

    public static ComposeOptions(config: ServerConfig, provisioning: IEnvironmentProvisioning, platform?: PlatformServices, provisionedSecrets?: IProvisionedSecretSource, logger?: ILogger, observability?: Observability, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard): PragmaticServerHostOptions
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
            allowedOrigins: config.allowedOrigins,
            provisioning,
            idleTtlMs: config.idleTtlMs,
            idleSweepMs: config.idleSweepMs,
            platform,
            deploymentMode: config.deploymentMode,
            redisUrl: config.redisUrl,
            replicaId: config.replicaId,
            provisionedSecrets,
            adapterPacks: config.adapterPacks,
            clientTls: config.clientTls,
            logger,
            observability,
            audit,
            rateLimit,
            drainTimeoutMs: config.drainTimeoutMs,
            cypherLimits: ServerBootstrap.CypherLimitsOf(config),
            paging: ServerBootstrap.PagingLimitsOf(config),
        }
    }

    private static CypherLimitsOf(config: ServerConfig): CypherLimits
    {
        return new CypherLimits(config.cypherRowCap, config.cypherTimeoutMs, config.cypherMaxVarLength)
    }

    private static PagingLimitsOf(config: ServerConfig): PagingLimits
    {
        return new PagingLimits(config.pagingPageSize, config.pagingMaxPageSize)
    }

    public static StartupLine(config: ServerConfig, environmentCount: number): string
    {
        const ownership = ServerBootstrap.HasRedis(config) ? ServerBootstrap.RedisOwnership : ServerBootstrap.InMemoryOwnership
        const secrets = config.provisionedSecretsFile !== undefined && config.provisionedSecretsFile.length > 0 ? ServerBootstrap.SecretsFile : ServerBootstrap.SecretsNone
        return `pragmatic-server listening on ${config.host}:${config.port} mode=${config.deploymentMode} environments=${environmentCount} ownership=${ownership} secrets=${secrets}${HostBootstrap.ClientMtlsToken(config.clientTls)}${ServerBootstrap.OidcFlowToken}${ownership}${HostBootstrap.OtelToken(config)}${HostBootstrap.SecurityTokens(config)}${HostBootstrap.DrainToken(config)}${ServerBootstrap.AuditAnchor(config)}`
    }

    public static ComposeWorkerOptions(config: ServerConfig, provisioning: IEnvironmentProvisioning, platform?: PlatformServices, provisionedSecrets?: IProvisionedSecretSource, logger?: ILogger, observability?: Observability, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard): WorkerHostOptions
    {
        if (config.tls === undefined)
        {
            throw new Error(ServerBootstrap.WorkerNeedsTls)
        }
        if (config.deploymentMode === DeploymentMode.Cloud && platform === undefined)
        {
            throw new Error(ServerBootstrap.CloudNeedsPlatform)
        }
        const advertise = config.workerAdvertiseHost !== undefined && config.workerAdvertisePort !== undefined
            ? { host: config.workerAdvertiseHost, port: config.workerAdvertisePort }
            : undefined
        return {
            host: config.host,
            port: config.port,
            baseDir: config.baseDir,
            masterKey: config.masterKey,
            allowedOrigins: config.allowedOrigins,
            provisioning,
            tls: config.tls,
            idleTtlMs: config.idleTtlMs,
            idleSweepMs: config.idleSweepMs,
            platform,
            deploymentMode: config.deploymentMode,
            redisUrl: config.redisUrl,
            replicaId: config.replicaId,
            provisionedSecrets,
            adapterPacks: config.adapterPacks,
            healthPort: config.healthPort,
            advertise,
            logger,
            observability,
            audit,
            rateLimit,
            drainTimeoutMs: config.drainTimeoutMs,
            cypherLimits: ServerBootstrap.CypherLimitsOf(config),
            paging: ServerBootstrap.PagingLimitsOf(config),
        }
    }

    public static WorkerStartupLine(config: ServerConfig): string
    {
        const ownership = ServerBootstrap.HasRedis(config) ? ServerBootstrap.RedisOwnership : ServerBootstrap.InMemoryOwnership
        return `pragmatic-worker listening on ${config.host}:${config.port} mode=${config.deploymentMode} ownership=${ownership} health=${config.healthPort ?? ServerBootstrap.HealthOff}${HostBootstrap.OtelToken(config)}${HostBootstrap.SecurityTokens(config)}${HostBootstrap.DrainToken(config)}`
    }

    private static AuditAnchor(config: { deploymentMode?: DeploymentMode; cloudAuditAnchorKeyRef?: string }): string
    {
        if (config.deploymentMode !== DeploymentMode.Cloud)
        {
            return ''
        }
        const on = config.cloudAuditAnchorKeyRef !== undefined && config.cloudAuditAnchorKeyRef.length > 0
        return ServerBootstrap.AuditAnchorLabel + (on ? ServerBootstrap.AuditAnchorOn : ServerBootstrap.AuditAnchorOff)
    }

    private static HasRedis(config: ServerConfig): boolean
    {
        return config.redisUrl !== undefined && config.redisUrl.length > 0
    }
}
