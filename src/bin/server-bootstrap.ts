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
import { CypherLimits } from '../config/cypher-limits.js'
import { PagingLimits } from '../config/paging-limits.js'
import { AuditSinkKind } from '../config/audit-sink-kind.js'
import { NullAccessAuditSink } from '../host/access-audit.js'
import type { IAccessAuditSink } from '../host/access-audit.js'
import { FileAccessAuditSink } from '../host/file-access-audit-sink.js'
import { SqlAuditAccessSink } from '../host/sql-access-audit-sink.js'
import { TokenBucketRateLimiter } from '../host/rate-limiter.js'
import type { RateLimitConfig } from '../host/rate-limiter.js'
import { RateLimitGuard } from '../host/rate-limit-guard.js'
import type { IAuditSink } from '@pragmatic-tech-ai/todl-identity'

interface IObservabilityConfigView
{
    serviceName?: string
    replicaId?: string
    metricsPort?: number
    otlpEndpoint?: string
    otlpProtocol?: OtlpProtocol
    otlpMetrics?: boolean
    traceSampling?: number
}

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
    private static readonly AuditFailuresMetric = 'audit_write_failures_total'
    private static readonly AuditFileRequired = 'audit file path required when audit sink is file'
    private static readonly SqlNeedsStore = 'audit sink sql requires a cloud audit store'
    private static readonly AuditLabel = ' audit='
    private static readonly RateLimitLabel = ' ratelimit='
    private static readonly DrainLabel = ' drain='
    private static readonly AuditAnchorLabel = ' audit-anchor='
    private static readonly AuditAnchorOn = 'on'
    private static readonly AuditAnchorOff = 'off'
    private static readonly RateLimitOn = 'on'
    private static readonly RateLimitOff = 'off'
    private static readonly WorkerNeedsTls = 'worker requires TLS (set PRAGMATIC_TLS_CERT_FILE/KEY_FILE/CA_FILE)'

    public static ComposeOptions(config: ServerConfig, provisioning: ITenantProvisioning, platform?: PlatformServices, provisionedSecrets?: IProvisionedSecretSource, logger?: ILogger, observability?: Observability, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard): PragmaticServerHostOptions
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

    public static StartupLine(config: ServerConfig, tenantCount: number): string
    {
        const ownership = ServerBootstrap.HasRedis(config) ? ServerBootstrap.RedisOwnership : ServerBootstrap.InMemoryOwnership
        const secrets = config.provisionedSecretsFile !== undefined && config.provisionedSecretsFile.length > 0 ? ServerBootstrap.SecretsFile : ServerBootstrap.SecretsNone
        return `pragmatic-server listening on ${config.host}:${config.port} mode=${config.deploymentMode} tenants=${tenantCount} ownership=${ownership} secrets=${secrets}${ServerBootstrap.ClientMtls(config.clientTls)}${ServerBootstrap.OidcFlowToken}${ownership}${ServerBootstrap.Otel(config)}${ServerBootstrap.Security(config)}${ServerBootstrap.Drain(config)}${ServerBootstrap.AuditAnchor(config)}`
    }

    public static ComposeWorkerOptions(config: ServerConfig, provisioning: ITenantProvisioning, platform?: PlatformServices, provisionedSecrets?: IProvisionedSecretSource, logger?: ILogger, observability?: Observability, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard): WorkerHostOptions
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

    public static ComposeGatewayOptions(gw: GatewayConfig, router: IWorkerRouter, logger?: ILogger, rateLimit?: RateLimitGuard, observability?: Observability): GatewayOptions
    {
        return {
            host: gw.host,
            port: gw.port,
            router,
            tls: gw.tls,
            serverName: gw.workerServerName,
            clientTls: gw.clientTls,
            logger,
            rateLimit,
            observability,
            drainTimeoutMs: gw.drainTimeoutMs,
        }
    }

    public static WorkerStartupLine(config: ServerConfig): string
    {
        const ownership = ServerBootstrap.HasRedis(config) ? ServerBootstrap.RedisOwnership : ServerBootstrap.InMemoryOwnership
        return `pragmatic-worker listening on ${config.host}:${config.port} mode=${config.deploymentMode} ownership=${ownership} health=${config.healthPort ?? ServerBootstrap.HealthOff}${ServerBootstrap.Otel(config)}${ServerBootstrap.Security(config)}${ServerBootstrap.Drain(config)}`
    }

    public static GatewayStartupLine(gw: GatewayConfig): string
    {
        return `pragmatic-gateway listening on ${gw.host}:${gw.port} servername=${gw.workerServerName ?? ServerBootstrap.ServerNameDefault}${ServerBootstrap.ClientMtls(gw.clientTls)}${ServerBootstrap.Otel(gw)}${ServerBootstrap.Security(gw)}${ServerBootstrap.Drain(gw)}`
    }

    public static OtelEnabled(config: IObservabilityConfigView): boolean
    {
        const tracing = config.otlpEndpoint !== undefined && config.otlpEndpoint.length > 0
        const metrics = config.metricsPort !== undefined || config.otlpMetrics === true
        return tracing || metrics
    }

    public static ObservabilityOptions(config: IObservabilityConfigView, role: ObservabilityRole, replicaId?: string): IObservabilityOptions | undefined
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

    public static AuditSink(config: { auditSink?: AuditSinkKind; auditFile?: string }, logger: ILogger, observability?: Observability, cloudAudit?: IAuditSink): IAccessAuditSink
    {
        if (config.auditSink === AuditSinkKind.File)
        {
            if (config.auditFile === undefined || config.auditFile.length === 0)
            {
                throw new Error(ServerBootstrap.AuditFileRequired)
            }
            return new FileAccessAuditSink(config.auditFile, undefined, logger, observability?.Meter().createCounter(ServerBootstrap.AuditFailuresMetric))
        }
        if (config.auditSink === AuditSinkKind.Sql)
        {
            if (cloudAudit === undefined)
            {
                throw new Error(ServerBootstrap.SqlNeedsStore)
            }
            return new SqlAuditAccessSink(cloudAudit, logger)
        }
        return new NullAccessAuditSink()
    }

    public static RateLimit(config: { rateLimit?: RateLimitConfig }, audit: IAccessAuditSink, observability?: Observability, logger?: ILogger): RateLimitGuard
    {
        if (config.rateLimit === undefined)
        {
            return new RateLimitGuard()
        }
        const meter = observability?.Meter()
        return new RateLimitGuard(new TokenBucketRateLimiter(config.rateLimit), audit, meter?.createCounter(RateLimitGuard.MetricName()), logger, meter?.createCounter(RateLimitGuard.ErrorMetricName()))
    }

    private static Drain(config: { drainTimeoutMs?: number }): string
    {
        return config.drainTimeoutMs === undefined ? '' : ServerBootstrap.DrainLabel + config.drainTimeoutMs
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

    private static Security(config: { auditSink?: AuditSinkKind; rateLimit?: RateLimitConfig }): string
    {
        const audit = config.auditSink ?? AuditSinkKind.None
        const rateLimit = config.rateLimit !== undefined ? ServerBootstrap.RateLimitOn : ServerBootstrap.RateLimitOff
        return ServerBootstrap.AuditLabel + audit + ServerBootstrap.RateLimitLabel + rateLimit
    }

    private static Otel(config: IObservabilityConfigView): string
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
