import type { MachineTlsRef } from '../cluster/machine-tls.js'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { AuditSinkKind } from './audit-sink-kind.js'
import type { RateLimitConfig } from '../host/rate-limiter.js'
import type { OtlpProtocol } from '../observability/otlp-protocol.js'
import type { DeploymentMode } from '../platform/deployment-mode.js'
import type { DeploymentProvider } from '../platform/deployment-provider.js'

export enum SandboxStrategy
{
    Worker = 'worker',
    Child = 'child',
}

export interface AdapterPacksResourceLimits
{
    readonly maxOldGenerationSizeMb?: number
    readonly maxYoungGenerationSizeMb?: number
    readonly stackSizeMb?: number
}

export interface AdapterPacksEviction
{
    readonly maxVersionsPerPack?: number
    readonly maxAgeMs?: number
}

/** Deployment-global adapter-pack settings; each tenant builds its own provider from these plus its ConnectorsPolicy gate. */
export interface AdapterPacksConfig
{
    readonly cacheDir: string
    readonly sandboxStrategy: SandboxStrategy
    readonly requireSignatures?: boolean
    readonly resourceLimits?: AdapterPacksResourceLimits
    readonly eviction?: AdapterPacksEviction
    readonly scriptAllowlist?: readonly string[]
}

export interface SingleTenantConfig
{
    id: string
    displayName: string
}

export interface WsResilienceConfig
{
    heartbeatIntervalMs: number
    readIdleMs: number
    backpressureSoftBytes: number
    backpressureHardBytes: number
    backpressureGraceMs: number
    maxInboundBytes: number
}

export interface ServerConfig
{
    host: string
    port: number
    baseDir: string
    masterKey: MasterKeyRef
    deploymentMode: DeploymentMode
    tenantsFile?: string
    singleTenant?: SingleTenantConfig
    idleTtlMs?: number
    idleSweepMs?: number
    redisUrl?: string
    replicaId?: string
    provisionedSecretsFile?: string
    tls?: MachineTlsRef
    clientTls?: MachineTlsRef
    workerAdvertiseHost?: string
    workerAdvertisePort?: number
    workerServerName?: string
    healthPort?: number
    serviceName?: string
    metricsPort?: number
    otlpEndpoint?: string
    otlpProtocol?: OtlpProtocol
    otlpMetrics?: boolean
    traceSampling?: number
    auditSink?: AuditSinkKind
    auditFile?: string
    rateLimit?: RateLimitConfig
    drainTimeoutMs?: number
    cypherRowCap?: number
    cypherTimeoutMs?: number
    cypherMaxVarLength?: number
    cloudProvider?: DeploymentProvider
    awsRegion?: string
    s3Bucket?: string
    s3Prefix?: string
    rdsHost?: string
    rdsPort?: number
    rdsUser?: string
    rdsDatabase?: string
    rdsAuth?: string
    rdsPasswordRef?: string
    blobAccount?: string
    blobContainer?: string
    blobPrefix?: string
    keyVaultUrl?: string
    azpgHost?: string
    azpgPort?: number
    azpgUser?: string
    azpgDatabase?: string
    azpgAuth?: string
    azpgPasswordRef?: string
    gcsBucket?: string
    gcsPrefix?: string
    gcpProject?: string
    cloudSqlInstance?: string
    cloudSqlUser?: string
    cloudSqlDatabase?: string
    cloudSqlIpType?: string
    cloudSqlAuth?: string
    cloudMasterKeyRef?: string
    cloudAuditAnchorKeyRef?: string
    cloudAuditAnchorInterval?: number
    readonly adapterPacks?: AdapterPacksConfig
    wsResilience?: WsResilienceConfig
}

export interface GatewayConfig
{
    host: string
    port: number
    tls: MachineTlsRef
    clientTls?: MachineTlsRef
    redisUrl: string
    workerServerName?: string
    healthPort?: number
    serviceName?: string
    metricsPort?: number
    otlpEndpoint?: string
    otlpProtocol?: OtlpProtocol
    otlpMetrics?: boolean
    traceSampling?: number
    auditSink?: AuditSinkKind
    auditFile?: string
    rateLimit?: RateLimitConfig
    drainTimeoutMs?: number
    wsResilience?: WsResilienceConfig
}
