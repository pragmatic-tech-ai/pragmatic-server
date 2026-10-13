import type { IStorageProviderRegistry, ISqlSession } from '@pragmatic-tech-ai/todl'
import type { ISecretStore } from '@pragmatic-tech-ai/todl-identity'
import type { CloudPlatform } from './cloud-platform.js'

/** The backend handles + lifecycle the factory needs (structurally satisfied by each provider's CloudBackends). */
export interface ICloudBackends
{
    readonly Storage: IStorageProviderRegistry
    readonly SecretManager: ISecretStore
    readonly Session: ISqlSession
    Dispose(): Promise<void>
}

/** A built CloudPlatform plus the teardown for the backends it runs on (CloudPlatform has none). */
export interface ICloudBundle
{
    readonly Platform: CloudPlatform
    Dispose(): Promise<void>
}
