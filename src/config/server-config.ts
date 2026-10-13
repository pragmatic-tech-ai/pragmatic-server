import type { MachineTlsRef } from '../cluster/machine-tls.js'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { AuditSinkKind } from './audit-sink-kind.js'
import type { RateLimitConfig } from '../host/rate-limiter.js'
import type { OtlpProtocol } from '../observability/otlp-protocol.js'
import type { DeploymentMode } from '../platform/deployment-mode.js'
import type { DeploymentProvider } from '../platform/deployment-provider.js'

export interface SingleTenantConfig
{
    id: string
    displayName: string
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
}
