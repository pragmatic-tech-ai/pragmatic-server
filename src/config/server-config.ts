import type { MasterKeyRef } from '../identity/master-key-resolver.js'
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
}
