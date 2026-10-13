import { randomUUID } from 'node:crypto'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import { DeploymentMode } from '../platform/deployment-mode.js'
import type { MachineTlsRef } from '../cluster/machine-tls.js'
import { AuditSinkKind } from './audit-sink-kind.js'
import type { RateLimitConfig, RateLimitSettings } from '../host/rate-limiter.js'
import { OtlpProtocol } from '../observability/otlp-protocol.js'
import type { GatewayConfig, ServerConfig, SingleTenantConfig } from './server-config.js'

interface ConfigFile
{
    host?: string
    port?: number
    baseDir?: string
    deploymentMode?: string
    idleTtlMs?: number
    idleSweepMs?: number
    redisUrl?: string
}

export class ServerConfigLoader
{
    private static readonly DefaultHost = '0.0.0.0'
    private static readonly DefaultPort = 8080
    private static readonly MissingBaseDir = 'PRAGMATIC_BASE_DIR is required'
    private static readonly MissingMasterKey = 'master key is required: set PRAGMATIC_MASTER_KEY_FILE or PRAGMATIC_MASTER_KEY_B64_ENV'
    private static readonly MissingTenant = 'a tenant source is required: set PRAGMATIC_TENANTS_FILE or PRAGMATIC_TENANT_ID'
    private static readonly BadMode = 'PRAGMATIC_DEPLOYMENT_MODE must be local or cloud'

    private static readonly TlsCertMissing = 'PRAGMATIC_TLS_CERT_FILE is required when TLS is configured'
    private static readonly TlsKeyMissing = 'PRAGMATIC_TLS_KEY_FILE is required when TLS is configured'
    private static readonly TlsCaMissing = 'PRAGMATIC_TLS_CA_FILE is required when TLS is configured'
    private static readonly ClientTlsCertMissing = 'PRAGMATIC_CLIENT_TLS_CERT_FILE (client TLS cert) is required when client TLS is configured'
    private static readonly ClientTlsKeyMissing = 'PRAGMATIC_CLIENT_TLS_KEY_FILE (client TLS key) is required when client TLS is configured'
    private static readonly ClientTlsCaMissing = 'PRAGMATIC_CLIENT_TLS_CA_FILE (client TLS CA) is required when client TLS is configured'
    private static readonly GatewayNeedsTls = 'PRAGMATIC_TLS_CERT_FILE/KEY_FILE/CA_FILE are required for the gateway'
    private static readonly GatewayNoSqlAudit = 'PRAGMATIC_AUDIT_SINK=sql is not supported on the gateway (it is a router with no SQL audit store); use file or none'
    private static readonly GatewayNeedsRedis = 'PRAGMATIC_REDIS_URL is required for the gateway'

    private static readonly BadMetricsPort = 'PRAGMATIC_METRICS_PORT must be an integer port between 1 and 65535'
    private static readonly BadDrainTimeout = 'PRAGMATIC_DRAIN_TIMEOUT_MS must be a positive integer (milliseconds)'
    private static readonly EnvDrainTimeout = 'PRAGMATIC_DRAIN_TIMEOUT_MS'
    private static readonly DefaultDrainTimeoutMs = 25000
    private static readonly BadSampling = 'PRAGMATIC_TRACE_SAMPLING must be a ratio between 0 and 1'
    private static readonly BadOtlpProtocol = 'PRAGMATIC_OTLP_PROTOCOL must be http-protobuf or grpc'
    private static readonly BadOtlpMetrics = 'PRAGMATIC_OTLP_METRICS must be true or false'
    private static readonly TrueValue = 'true'
    private static readonly FalseValue = 'false'
    private static readonly EnvServiceName = 'PRAGMATIC_SERVICE_NAME'
    private static readonly EnvMetricsPort = 'PRAGMATIC_METRICS_PORT'
    private static readonly EnvOtlpEndpoint = 'PRAGMATIC_OTLP_ENDPOINT'
    private static readonly EnvOtlpProtocol = 'PRAGMATIC_OTLP_PROTOCOL'
    private static readonly EnvOtlpMetrics = 'PRAGMATIC_OTLP_METRICS'
    private static readonly EnvTraceSampling = 'PRAGMATIC_TRACE_SAMPLING'

    private static readonly BadAuditSink = 'PRAGMATIC_AUDIT_SINK must be none, file or sql'
    private static readonly AuditFileRequired = 'PRAGMATIC_AUDIT_FILE is required when PRAGMATIC_AUDIT_SINK=file'
    private static readonly AuditSqlNeedsCloud = 'PRAGMATIC_AUDIT_SINK=sql requires PRAGMATIC_DEPLOYMENT_MODE=cloud'
    private static readonly BadRateLimit = 'PRAGMATIC_RATELIMIT_* values must be set in Rps+Burst pairs, with Rps a number greater than 0 and Burst an integer of at least 1'
    private static readonly EnvGcsBucket = 'PRAGMATIC_GCS_BUCKET'
    private static readonly EnvGcsPrefix = 'PRAGMATIC_GCS_PREFIX'
    private static readonly EnvGcpProject = 'PRAGMATIC_GCP_PROJECT'
    private static readonly EnvCloudSqlInstance = 'PRAGMATIC_CLOUDSQL_INSTANCE'
    private static readonly EnvCloudSqlUser = 'PRAGMATIC_CLOUDSQL_USER'
    private static readonly EnvCloudSqlDb = 'PRAGMATIC_CLOUDSQL_DB'
    private static readonly EnvCloudSqlIpType = 'PRAGMATIC_CLOUDSQL_IPTYPE'
    private static readonly EnvCloudSqlAuth = 'PRAGMATIC_CLOUDSQL_AUTH'
    private static readonly EnvCloudMasterKeyRef = 'PRAGMATIC_CLOUD_MASTER_KEY_REF'
    private static readonly MissingGcsBucket = 'PRAGMATIC_GCS_BUCKET is required for cloud deployment'
    private static readonly MissingGcpProject = 'PRAGMATIC_GCP_PROJECT is required for cloud deployment'
    private static readonly MissingCloudSqlInstance = 'PRAGMATIC_CLOUDSQL_INSTANCE is required for cloud deployment'
    private static readonly MissingCloudSqlUser = 'PRAGMATIC_CLOUDSQL_USER is required for cloud deployment'
    private static readonly MissingCloudSqlDb = 'PRAGMATIC_CLOUDSQL_DB is required for cloud deployment'
    private static readonly MissingCloudMasterKeyRef = 'PRAGMATIC_CLOUD_MASTER_KEY_REF is required for cloud deployment'
    private static readonly UnsupportedCloudSqlAuth = 'PRAGMATIC_CLOUDSQL_AUTH=password is not supported yet; use iam'
    private static readonly CloudSqlAuthIam = 'iam'
    private static readonly EnvAuditSink = 'PRAGMATIC_AUDIT_SINK'
    private static readonly EnvAuditFile = 'PRAGMATIC_AUDIT_FILE'
    private static readonly EnvTenantRps = 'PRAGMATIC_RATELIMIT_TENANT_RPS'
    private static readonly EnvTenantBurst = 'PRAGMATIC_RATELIMIT_TENANT_BURST'
    private static readonly EnvPrincipalRps = 'PRAGMATIC_RATELIMIT_PRINCIPAL_RPS'
    private static readonly EnvPrincipalBurst = 'PRAGMATIC_RATELIMIT_PRINCIPAL_BURST'

    private static GatewaySecurity(env: Record<string, string | undefined>): { auditSink?: AuditSinkKind; auditFile?: string; rateLimit?: RateLimitConfig }
    {
        const security = ServerConfigLoader.Security(env)
        if (security.auditSink === AuditSinkKind.Sql)
        {
            throw new Error(ServerConfigLoader.GatewayNoSqlAudit)
        }
        return security
    }

    private static Security(env: Record<string, string | undefined>, deploymentMode?: DeploymentMode): { auditSink?: AuditSinkKind; auditFile?: string; rateLimit?: RateLimitConfig }
    {
        const auditSink = ServerConfigLoader.AuditSinkOf(env[ServerConfigLoader.EnvAuditSink])
        const auditFile = ServerConfigLoader.NonEmpty(env[ServerConfigLoader.EnvAuditFile])
        if (auditSink === AuditSinkKind.File && auditFile === undefined)
        {
            throw new Error(ServerConfigLoader.AuditFileRequired)
        }
        if (auditSink === AuditSinkKind.Sql && deploymentMode !== undefined && deploymentMode !== DeploymentMode.Cloud)
        {
            throw new Error(ServerConfigLoader.AuditSqlNeedsCloud)
        }
        return { auditSink, auditFile, rateLimit: ServerConfigLoader.RateLimitOf(env) }
    }

    private static AuditSinkOf(value: string | undefined): AuditSinkKind | undefined
    {
        if (value === undefined || value.length === 0)
        {
            return undefined
        }
        if (value === AuditSinkKind.None || value === AuditSinkKind.File || value === AuditSinkKind.Sql)
        {
            return value
        }
        throw new Error(ServerConfigLoader.BadAuditSink)
    }

    private static RateLimitOf(env: Record<string, string | undefined>): RateLimitConfig | undefined
    {
        const perTenant = ServerConfigLoader.SettingsOf(env[ServerConfigLoader.EnvTenantRps], env[ServerConfigLoader.EnvTenantBurst])
        const perPrincipal = ServerConfigLoader.SettingsOf(env[ServerConfigLoader.EnvPrincipalRps], env[ServerConfigLoader.EnvPrincipalBurst])
        if (perTenant === undefined && perPrincipal === undefined)
        {
            return undefined
        }
        return { perTenant, perPrincipal }
    }

    private static SettingsOf(rps: string | undefined, burst: string | undefined): RateLimitSettings | undefined
    {
        const hasRps = rps !== undefined && rps.length > 0
        const hasBurst = burst !== undefined && burst.length > 0
        if (!hasRps && !hasBurst)
        {
            return undefined
        }
        if (!hasRps || !hasBurst)
        {
            throw new Error(ServerConfigLoader.BadRateLimit)
        }
        const parsedRps = Number(rps)
        const parsedBurst = Number(burst)
        if (!Number.isFinite(parsedRps) || parsedRps <= 0 || !Number.isInteger(parsedBurst) || parsedBurst < 1)
        {
            throw new Error(ServerConfigLoader.BadRateLimit)
        }
        return { Rps: parsedRps, Burst: parsedBurst }
    }

    public static LoadGateway(env: Record<string, string | undefined>): GatewayConfig
    {
        const tls = ServerConfigLoader.Tls(env)
        if (tls === undefined)
        {
            throw new Error(ServerConfigLoader.GatewayNeedsTls)
        }
        const redisUrl = env.PRAGMATIC_REDIS_URL
        if (redisUrl === undefined || redisUrl.length === 0)
        {
            throw new Error(ServerConfigLoader.GatewayNeedsRedis)
        }
        return {
            host: env.PRAGMATIC_HOST ?? ServerConfigLoader.DefaultHost,
            port: ServerConfigLoader.Int(env.PRAGMATIC_PORT) ?? ServerConfigLoader.DefaultPort,
            tls,
            clientTls: ServerConfigLoader.ClientTls(env),
            redisUrl,
            workerServerName: env.PRAGMATIC_WORKER_SERVERNAME,
            healthPort: ServerConfigLoader.Int(env.PRAGMATIC_HEALTH_PORT),
            ...ServerConfigLoader.Observability(env),
            ...ServerConfigLoader.GatewaySecurity(env),
            drainTimeoutMs: ServerConfigLoader.DrainTimeout(env[ServerConfigLoader.EnvDrainTimeout]),
        }
    }

    private static MetricsPort(value: string | undefined): number | undefined
    {
        if (value === undefined || value.length === 0)
        {
            return undefined
        }
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
        {
            throw new Error(ServerConfigLoader.BadMetricsPort)
        }
        return parsed
    }

    private static DrainTimeout(value: string | undefined): number
    {
        if (value === undefined || value.length === 0)
        {
            return ServerConfigLoader.DefaultDrainTimeoutMs
        }
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1)
        {
            throw new Error(ServerConfigLoader.BadDrainTimeout)
        }
        return parsed
    }

    private static Sampling(value: string | undefined): number | undefined
    {
        if (value === undefined || value.length === 0)
        {
            return undefined
        }
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
        {
            throw new Error(ServerConfigLoader.BadSampling)
        }
        return parsed
    }

    private static Bool(value: string | undefined): boolean | undefined
    {
        if (value === undefined || value.length === 0)
        {
            return undefined
        }
        const lowered = value.toLowerCase()
        if (lowered === ServerConfigLoader.TrueValue)
        {
            return true
        }
        if (lowered === ServerConfigLoader.FalseValue)
        {
            return false
        }
        throw new Error(ServerConfigLoader.BadOtlpMetrics)
    }

    private static OtlpProtocolOf(value: string | undefined): OtlpProtocol | undefined
    {
        if (value === undefined || value.length === 0)
        {
            return undefined
        }
        if (value === OtlpProtocol.HttpProtobuf)
        {
            return OtlpProtocol.HttpProtobuf
        }
        if (value === OtlpProtocol.Grpc)
        {
            return OtlpProtocol.Grpc
        }
        throw new Error(ServerConfigLoader.BadOtlpProtocol)
    }

    private static Observability(env: Record<string, string | undefined>): { serviceName?: string; metricsPort?: number; otlpEndpoint?: string; otlpProtocol?: OtlpProtocol; otlpMetrics?: boolean; traceSampling?: number }
    {
        return {
            serviceName: ServerConfigLoader.NonEmpty(env[ServerConfigLoader.EnvServiceName]),
            metricsPort: ServerConfigLoader.MetricsPort(env[ServerConfigLoader.EnvMetricsPort]),
            otlpEndpoint: ServerConfigLoader.NonEmpty(env[ServerConfigLoader.EnvOtlpEndpoint]),
            otlpProtocol: ServerConfigLoader.OtlpProtocolOf(env[ServerConfigLoader.EnvOtlpProtocol]),
            otlpMetrics: ServerConfigLoader.Bool(env[ServerConfigLoader.EnvOtlpMetrics]),
            traceSampling: ServerConfigLoader.Sampling(env[ServerConfigLoader.EnvTraceSampling]),
        }
    }

    private static NonEmpty(value: string | undefined): string | undefined
    {
        return value !== undefined && value.length > 0 ? value : undefined
    }

    private static Tls(env: Record<string, string | undefined>): MachineTlsRef | undefined
    {
        const certFile = ServerConfigLoader.NonEmpty(env.PRAGMATIC_TLS_CERT_FILE)
        const keyFile = ServerConfigLoader.NonEmpty(env.PRAGMATIC_TLS_KEY_FILE)
        const caFile = ServerConfigLoader.NonEmpty(env.PRAGMATIC_TLS_CA_FILE)
        if (certFile === undefined && keyFile === undefined && caFile === undefined)
        {
            return undefined
        }
        if (certFile === undefined)
        {
            throw new Error(ServerConfigLoader.TlsCertMissing)
        }
        if (keyFile === undefined)
        {
            throw new Error(ServerConfigLoader.TlsKeyMissing)
        }
        if (caFile === undefined)
        {
            throw new Error(ServerConfigLoader.TlsCaMissing)
        }
        return { certFile, keyFile, caFile }
    }

    private static ClientTls(env: Record<string, string | undefined>): MachineTlsRef | undefined
    {
        const certFile = ServerConfigLoader.NonEmpty(env.PRAGMATIC_CLIENT_TLS_CERT_FILE)
        const keyFile = ServerConfigLoader.NonEmpty(env.PRAGMATIC_CLIENT_TLS_KEY_FILE)
        const caFile = ServerConfigLoader.NonEmpty(env.PRAGMATIC_CLIENT_TLS_CA_FILE)
        if (certFile === undefined && keyFile === undefined && caFile === undefined)
        {
            return undefined
        }
        if (certFile === undefined)
        {
            throw new Error(ServerConfigLoader.ClientTlsCertMissing)
        }
        if (keyFile === undefined)
        {
            throw new Error(ServerConfigLoader.ClientTlsKeyMissing)
        }
        if (caFile === undefined)
        {
            throw new Error(ServerConfigLoader.ClientTlsCaMissing)
        }
        return { certFile, keyFile, caFile }
    }

    public static Load(env: Record<string, string | undefined>, readTextFile: (path: string) => string): ServerConfig
    {
        const file = ServerConfigLoader.File(env, readTextFile)
        const baseDir = env.PRAGMATIC_BASE_DIR ?? file.baseDir
        if (baseDir === undefined || baseDir.length === 0)
        {
            throw new Error(ServerConfigLoader.MissingBaseDir)
        }
        const masterKey = ServerConfigLoader.MasterKey(env)
        const tenantsFile = env.PRAGMATIC_TENANTS_FILE
        const singleTenant = ServerConfigLoader.SingleTenant(env)
        if (tenantsFile === undefined && singleTenant === undefined)
        {
            throw new Error(ServerConfigLoader.MissingTenant)
        }
        const redis = ServerConfigLoader.Redis(env, file.redisUrl)
        const provisionedSecretsFile = env.PRAGMATIC_PROVISIONED_SECRETS_FILE
        const tls = ServerConfigLoader.Tls(env)
        const clientTls = ServerConfigLoader.ClientTls(env)
        const deploymentMode = ServerConfigLoader.Mode(env.PRAGMATIC_DEPLOYMENT_MODE ?? file.deploymentMode)
        return {
            host: env.PRAGMATIC_HOST ?? file.host ?? ServerConfigLoader.DefaultHost,
            port: ServerConfigLoader.Int(env.PRAGMATIC_PORT) ?? file.port ?? ServerConfigLoader.DefaultPort,
            baseDir,
            masterKey,
            deploymentMode,
            tenantsFile,
            singleTenant,
            idleTtlMs: ServerConfigLoader.Int(env.PRAGMATIC_IDLE_TTL_MS) ?? file.idleTtlMs,
            idleSweepMs: ServerConfigLoader.Int(env.PRAGMATIC_IDLE_SWEEP_MS) ?? file.idleSweepMs,
            ...redis,
            provisionedSecretsFile,
            tls,
            clientTls,
            workerAdvertiseHost: env.PRAGMATIC_WORKER_ADVERTISE_HOST,
            workerAdvertisePort: ServerConfigLoader.Int(env.PRAGMATIC_WORKER_ADVERTISE_PORT),
            workerServerName: env.PRAGMATIC_WORKER_SERVERNAME,
            healthPort: ServerConfigLoader.Int(env.PRAGMATIC_HEALTH_PORT),
            ...ServerConfigLoader.Observability(env),
            ...ServerConfigLoader.Security(env, deploymentMode),
            ...ServerConfigLoader.Cloud(env, deploymentMode),
            drainTimeoutMs: ServerConfigLoader.DrainTimeout(env[ServerConfigLoader.EnvDrainTimeout]),
        }
    }

    private static Cloud(env: Record<string, string | undefined>, deploymentMode: DeploymentMode): Partial<ServerConfig>
    {
        if (deploymentMode !== DeploymentMode.Cloud)
        {
            return {}
        }
        const gcsBucket = ServerConfigLoader.RequiredCloud(env[ServerConfigLoader.EnvGcsBucket], ServerConfigLoader.MissingGcsBucket)
        const gcpProject = ServerConfigLoader.RequiredCloud(env[ServerConfigLoader.EnvGcpProject], ServerConfigLoader.MissingGcpProject)
        const cloudSqlInstance = ServerConfigLoader.RequiredCloud(env[ServerConfigLoader.EnvCloudSqlInstance], ServerConfigLoader.MissingCloudSqlInstance)
        const cloudSqlUser = ServerConfigLoader.RequiredCloud(env[ServerConfigLoader.EnvCloudSqlUser], ServerConfigLoader.MissingCloudSqlUser)
        const cloudSqlDatabase = ServerConfigLoader.RequiredCloud(env[ServerConfigLoader.EnvCloudSqlDb], ServerConfigLoader.MissingCloudSqlDb)
        const cloudMasterKeyRef = ServerConfigLoader.RequiredCloud(env[ServerConfigLoader.EnvCloudMasterKeyRef], ServerConfigLoader.MissingCloudMasterKeyRef)
        const cloudSqlAuth = ServerConfigLoader.NonEmpty(env[ServerConfigLoader.EnvCloudSqlAuth])
        if (cloudSqlAuth !== undefined && cloudSqlAuth.toLowerCase() !== ServerConfigLoader.CloudSqlAuthIam)
        {
            throw new Error(ServerConfigLoader.UnsupportedCloudSqlAuth)
        }
        return {
            gcsBucket,
            gcsPrefix: ServerConfigLoader.NonEmpty(env[ServerConfigLoader.EnvGcsPrefix]),
            gcpProject,
            cloudSqlInstance,
            cloudSqlUser,
            cloudSqlDatabase,
            cloudSqlIpType: ServerConfigLoader.NonEmpty(env[ServerConfigLoader.EnvCloudSqlIpType]),
            cloudSqlAuth,
            cloudMasterKeyRef,
        }
    }

    private static RequiredCloud(value: string | undefined, missingMessage: string): string
    {
        const present = ServerConfigLoader.NonEmpty(value)
        if (present === undefined)
        {
            throw new Error(missingMessage)
        }
        return present
    }

    private static Redis(env: Record<string, string | undefined>, fileUrl: string | undefined): { redisUrl?: string; replicaId?: string }
    {
        const redisUrl = env.PRAGMATIC_REDIS_URL ?? fileUrl
        if (redisUrl === undefined || redisUrl.length === 0)
        {
            return {}
        }
        const replicaId = env.PRAGMATIC_REPLICA_ID ?? env.HOSTNAME ?? randomUUID()
        return { redisUrl, replicaId }
    }

    private static File(env: Record<string, string | undefined>, readTextFile: (path: string) => string): ConfigFile
    {
        const path = env.PRAGMATIC_CONFIG_FILE
        if (path === undefined || path.length === 0)
        {
            return {}
        }
        return JSON.parse(readTextFile(path)) as ConfigFile
    }

    private static MasterKey(env: Record<string, string | undefined>): MasterKeyRef
    {
        if (env.PRAGMATIC_MASTER_KEY_FILE !== undefined && env.PRAGMATIC_MASTER_KEY_FILE.length > 0)
        {
            return { keyFilePath: env.PRAGMATIC_MASTER_KEY_FILE }
        }
        if (env.PRAGMATIC_MASTER_KEY_B64_ENV !== undefined && env.PRAGMATIC_MASTER_KEY_B64_ENV.length > 0)
        {
            return { base64Env: env.PRAGMATIC_MASTER_KEY_B64_ENV }
        }
        throw new Error(ServerConfigLoader.MissingMasterKey)
    }

    private static SingleTenant(env: Record<string, string | undefined>): SingleTenantConfig | undefined
    {
        const id = env.PRAGMATIC_TENANT_ID
        if (id === undefined || id.length === 0)
        {
            return undefined
        }
        return { id, displayName: env.PRAGMATIC_TENANT_DISPLAY_NAME ?? id }
    }

    private static Mode(value: string | undefined): DeploymentMode
    {
        if (value === undefined || value === DeploymentMode.Local)
        {
            return DeploymentMode.Local
        }
        if (value === DeploymentMode.Cloud)
        {
            return DeploymentMode.Cloud
        }
        throw new Error(ServerConfigLoader.BadMode)
    }

    private static Int(value: string | undefined): number | undefined
    {
        if (value === undefined || value.length === 0)
        {
            return undefined
        }
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }
}
