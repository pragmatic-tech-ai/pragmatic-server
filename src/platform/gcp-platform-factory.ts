import { GcpCloudBackends } from '@pragmatic-tech-ai/todl-platform-gcp'
import type { IStorageProviderRegistry, ISqlSession } from '@pragmatic-tech-ai/todl'
import type { ISecretStore } from '@pragmatic-tech-ai/todl-identity'
import type { ServerConfig } from '../config/server-config.js'
import { CloudPlatform } from './cloud-platform.js'

/** The backend handles + lifecycle the factory needs (structurally satisfied by GcpCloudBackends). */
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

export class GcpPlatformFactory
{
    private static readonly MissingMasterKeyRef = 'PRAGMATIC_CLOUD_MASTER_KEY_REF is required for cloud deployment'
    private static readonly MissingGcpConfig = 'cloud deployment requires complete GCP configuration'

    public static async Create(config: ServerConfig): Promise<ICloudBundle>
    {
        const masterKeyRef = config.cloudMasterKeyRef
        if (masterKeyRef === undefined)
        {
            throw new Error(GcpPlatformFactory.MissingMasterKeyRef)
        }
        if (config.gcsBucket === undefined || config.gcpProject === undefined || config.cloudSqlInstance === undefined
            || config.cloudSqlUser === undefined || config.cloudSqlDatabase === undefined)
        {
            throw new Error(GcpPlatformFactory.MissingGcpConfig)
        }
        const backends = await GcpCloudBackends.Create({
            gcsBucket: config.gcsBucket,
            gcsPrefix: config.gcsPrefix,
            gcpProject: config.gcpProject,
            cloudSqlInstance: config.cloudSqlInstance,
            cloudSqlUser: config.cloudSqlUser,
            cloudSqlDatabase: config.cloudSqlDatabase,
            cloudSqlIpType: config.cloudSqlIpType,
            cloudSqlAuth: config.cloudSqlAuth,
        })
        return GcpPlatformFactory.CreateWith(backends, masterKeyRef)
    }

    public static async CreateWith(backends: ICloudBackends, masterKeyRef: string): Promise<ICloudBundle>
    {
        let platform: CloudPlatform
        try
        {
            platform = await CloudPlatform.Create({
                session: backends.Session,
                storage: backends.Storage,
                secretManager: backends.SecretManager,
                masterKeyRef,
            })
        }
        catch (error)
        {
            await backends.Dispose()
            throw error
        }
        return { Platform: platform, Dispose: () => backends.Dispose() }
    }
}
