import { AwsCloudBackends } from '@pragmatic-tech-ai/todl-platform-aws'
import type { ServerConfig } from '../config/server-config.js'
import type { ICloudBundle, ICloudBackends } from './cloud-bundle.js'
import { CloudPlatform } from './cloud-platform.js'

export class AwsPlatformFactory
{
    private static readonly MissingMasterKeyRef = 'PRAGMATIC_CLOUD_MASTER_KEY_REF is required for cloud deployment'
    private static readonly MissingAwsConfig = 'cloud deployment requires complete AWS configuration'

    public static async Create(config: ServerConfig): Promise<ICloudBundle>
    {
        const masterKeyRef = config.cloudMasterKeyRef
        if (masterKeyRef === undefined)
        {
            throw new Error(AwsPlatformFactory.MissingMasterKeyRef)
        }
        if (config.awsRegion === undefined || config.s3Bucket === undefined || config.rdsHost === undefined
            || config.rdsUser === undefined || config.rdsDatabase === undefined)
        {
            throw new Error(AwsPlatformFactory.MissingAwsConfig)
        }
        const backends = await AwsCloudBackends.Create({
            s3Bucket: config.s3Bucket,
            s3Prefix: config.s3Prefix,
            awsRegion: config.awsRegion,
            rdsHost: config.rdsHost,
            rdsPort: config.rdsPort,
            rdsUser: config.rdsUser,
            rdsDatabase: config.rdsDatabase,
            rdsAuth: config.rdsAuth,
            rdsPasswordRef: config.rdsPasswordRef,
        })
        return AwsPlatformFactory.CreateWith(backends, masterKeyRef, config.cloudAuditAnchorKeyRef, config.cloudAuditAnchorInterval)
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
