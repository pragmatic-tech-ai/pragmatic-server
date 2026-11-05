import { readFileSync } from 'node:fs'
import type { ServerConfig } from '../config/server-config.js'
import { ServerConfigLoader } from '../config/server-config-loader.js'
import { TenantProvisioningFactory } from '../config/tenant-provisioning-factory.js'
import { ProvisionedSecretsFactory } from '../config/provisioned-secrets-factory.js'
import { PragmaticServerHost } from '../host/pragmatic-server-host.js'
import { ServerBootstrap } from './server-bootstrap.js'
import { GracefulShutdown } from './graceful-shutdown.js'
import type { IAccessAuditSink } from '../host/access-audit.js'
import { StructuredLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'
import { DeploymentMode } from '../platform/deployment-mode.js'
import { DeploymentProvider } from '../platform/deployment-provider.js'
import type { ICloudBundle } from '../platform/cloud-bundle.js'
import { Observability, ObservabilityRole } from '../observability/observability.js'

class ServerMain
{
    private static readonly Utf8 = 'utf8'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly SigInt = 'SIGINT'
    private static readonly StartFailedPrefix = 'pragmatic-server failed to start: '
    private static readonly UnknownError = 'unknown error'
    private static readonly ShutdownLine = 'pragmatic-server shutting down'
    private static readonly ShutdownErrorPrefix = 'pragmatic-server shutdown error: '

    private static readonly StartupEvent = 'startup'
    private static readonly StartFailedEvent = 'start-failed'
    private static readonly EventKey = 'event'

    private readonly shutdown: GracefulShutdown

    private constructor(host: PragmaticServerHost, audit: IAccessAuditSink, logger: ILogger, bundle?: ICloudBundle)
    {
        this.shutdown = new GracefulShutdown(host, audit, bundle, logger, ServerMain.ShutdownLine, ServerMain.ShutdownErrorPrefix)
    }

    public static async Run(): Promise<void>
    {
        const logger = StructuredLogger.ToStdout()
        const read = (path: string): string => readFileSync(path, ServerMain.Utf8)
        const config = ServerConfigLoader.Load(process.env, read)
        const { provisioning, tenantCount } = TenantProvisioningFactory.Build(config, read)
        const provisionedSecrets = ProvisionedSecretsFactory.Build(config, read)
        const observabilityOptions = ServerBootstrap.ObservabilityOptions(config, ObservabilityRole.Host)
        const observability = observabilityOptions !== undefined ? Observability.Start(observabilityOptions) : undefined
        const bundle = config.deploymentMode === DeploymentMode.Cloud ? await ServerMain.BuildBundle(config) : undefined
        let main: ServerMain
        try
        {
            const audit = ServerBootstrap.AuditSink(config, logger, observability, bundle !== undefined ? await bundle.Platform.AuditSink() : undefined)
            const rateLimit = ServerBootstrap.RateLimit(config, audit, observability, logger)
            const options = ServerBootstrap.ComposeOptions(config, provisioning, bundle?.Platform, provisionedSecrets, logger, observability, audit, rateLimit)
            const host = await PragmaticServerHost.StartAsync(options)
            logger.Info(ServerBootstrap.StartupLine(config, tenantCount), { [ServerMain.EventKey]: ServerMain.StartupEvent })
            main = new ServerMain(host, audit, logger, bundle)
        }
        catch (error)
        {
            await ServerMain.DisposeQuietly(bundle)
            throw error
        }
        process.on(ServerMain.SigTerm, () => void main.Shutdown())
        process.on(ServerMain.SigInt, () => void main.Shutdown())
    }

    public static Fail(error: unknown): void
    {
        StructuredLogger.ToStdout().Error(ServerMain.StartFailedPrefix + (error instanceof Error ? error.message : ServerMain.UnknownError), { [ServerMain.EventKey]: ServerMain.StartFailedEvent })
        process.exit(1)
    }

    private static async BuildBundle(config: ServerConfig): Promise<ICloudBundle>
    {
        if (config.cloudProvider === DeploymentProvider.Azure)
        {
            const { AzurePlatformFactory } = await import('../platform/azure-platform-factory.js')
            return await AzurePlatformFactory.Create(config)
        }
        if (config.cloudProvider === DeploymentProvider.Aws)
        {
            const { AwsPlatformFactory } = await import('../platform/aws-platform-factory.js')
            return await AwsPlatformFactory.Create(config)
        }
        const { GcpPlatformFactory } = await import('../platform/gcp-platform-factory.js')
        return await GcpPlatformFactory.Create(config)
    }

    private static async DisposeQuietly(bundle: ICloudBundle | undefined): Promise<void>
    {
        if (bundle === undefined)
        {
            return
        }
        try
        {
            await bundle.Dispose()
        }
        catch
        {
            // best-effort: a bundle teardown failure must not block exit
        }
    }

    /** Stops the host, drains the access audit, disposes the bundle, then exits (once; a second signal is ignored). */
    private async Shutdown(): Promise<void>
    {
        const code = await this.shutdown.Run()
        if (code !== undefined)
        {
            process.exit(code)
        }
    }
}

ServerMain.Run().catch(ServerMain.Fail)
