import { AzureCloudBackends } from '@pragmatic-tech-ai/todl-platform-azure'
import type { ServerConfig } from '../config/server-config.js'
import type { ICloudBundle, ICloudBackends } from './cloud-bundle.js'
import { CloudPlatform } from './cloud-platform.js'

export class AzurePlatformFactory
{
    private static readonly MissingMasterKeyRef = 'PRAGMATIC_CLOUD_MASTER_KEY_REF is required for cloud deployment'
    private static readonly MissingAzureConfig = 'cloud deployment requires complete Azure configuration'

    public static async Create(config: ServerConfig): Promise<ICloudBundle>
    {
        const masterKeyRef = config.cloudMasterKeyRef
        if (masterKeyRef === undefined)
        {
            throw new Error(AzurePlatformFactory.MissingMasterKeyRef)
        }
        if (config.blobAccount === undefined || config.blobContainer === undefined || config.keyVaultUrl === undefined
            || config.azpgHost === undefined || config.azpgUser === undefined || config.azpgDatabase === undefined)
        {
            throw new Error(AzurePlatformFactory.MissingAzureConfig)
        }
        const backends = await AzureCloudBackends.Create({
            blobAccount: config.blobAccount,
            blobContainer: config.blobContainer,
            blobPrefix: config.blobPrefix,
            keyVaultUrl: config.keyVaultUrl,
            azpgHost: config.azpgHost,
            azpgPort: config.azpgPort,
            azpgUser: config.azpgUser,
            azpgDatabase: config.azpgDatabase,
            azpgAuth: config.azpgAuth,
            azpgPasswordRef: config.azpgPasswordRef,
        })
        return AzurePlatformFactory.CreateWith(backends, masterKeyRef, config.cloudAuditAnchorKeyRef, config.cloudAuditAnchorInterval)
    }

    public static async CreateWith(backends: ICloudBackends, masterKeyRef: string, auditAnchorKeyRef?: string, auditAnchorInterval?: number): Promise<ICloudBundle>
    {
        let platform: CloudPlatform
        try
        {
            platform = await CloudPlatform.Create({
                session: backends.Session,
                storage: backends.Storage,
                secretManager: backends.SecretManager,
                masterKeyRef,
                auditAnchorKeyRef,
                auditAnchorInterval,
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
