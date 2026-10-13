import type { MachineTlsRef } from '../cluster/machine-tls.js'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { AuditSinkKind } from './audit-sink-kind.js'
import type { RateLimitConfig } from '../host/rate-limiter.js'
import type { OtlpProtocol } from '../observability/otlp-protocol.js'
import type { DeploymentMode } from '../platform/deployment-mode.js'

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
