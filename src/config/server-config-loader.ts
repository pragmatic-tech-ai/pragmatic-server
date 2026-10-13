import { randomUUID } from 'node:crypto'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import { DeploymentMode } from '../platform/deployment-mode.js'
import type { MachineTlsRef } from '../cluster/machine-tls.js'
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
    private static readonly GatewayNeedsRedis = 'PRAGMATIC_REDIS_URL is required for the gateway'

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
        return {
            host: env.PRAGMATIC_HOST ?? file.host ?? ServerConfigLoader.DefaultHost,
            port: ServerConfigLoader.Int(env.PRAGMATIC_PORT) ?? file.port ?? ServerConfigLoader.DefaultPort,
            baseDir,
            masterKey,
            deploymentMode: ServerConfigLoader.Mode(env.PRAGMATIC_DEPLOYMENT_MODE ?? file.deploymentMode),
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
        }
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
