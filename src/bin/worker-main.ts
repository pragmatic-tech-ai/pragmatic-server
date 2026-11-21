import { readFileSync } from 'node:fs'
import { type ServerConfig, ServerConfigLoader, type IAccessAuditSink, DeploymentMode, DeploymentProvider, Observability, ObservabilityRole, HostBootstrap } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvironmentProvisioningFactory } from '../config/environment-provisioning-factory.js'
import { ProvisionedSecretsFactory } from '../config/provisioned-secrets-factory.js'
import { WorkerHost } from '../cluster/worker-host.js'
import { ServerBootstrap } from './server-bootstrap.js'
import { GracefulShutdown } from './graceful-shutdown.js'
import { StructuredLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { ICloudBundle } from '../platform/cloud-bundle.js'

class WorkerMain
{
    private static readonly Utf8 = 'utf8'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly SigInt = 'SIGINT'
    private static readonly StartFailedPrefix = 'pragmatic-worker failed to start: '
    private static readonly UnknownError = 'unknown error'
    private static readonly ShutdownLine = 'pragmatic-worker shutting down'
    private static readonly ShutdownErrorPrefix = 'pragmatic-worker shutdown error: '

    private static readonly StartupEvent = 'startup'
    private static readonly StartFailedEvent = 'start-failed'
    private static readonly EventKey = 'event'

    private readonly shutdown: GracefulShutdown

    private constructor(host: WorkerHost, audit: IAccessAuditSink, logger: ILogger, bundle?: ICloudBundle)
    {
        this.shutdown = new GracefulShutdown(host, audit, bundle, logger, WorkerMain.ShutdownLine, WorkerMain.ShutdownErrorPrefix)
    }

    public static async Run(): Promise<void>
    {
        const logger = StructuredLogger.ToStdout()
        const read = (path: string): string => readFileSync(path, WorkerMain.Utf8)
        const config = ServerConfigLoader.Load(process.env, read)
        const { provisioning } = EnvironmentProvisioningFactory.Build(config, read)
        const provisionedSecrets = ProvisionedSecretsFactory.Build(config, read)
        const observabilityOptions = HostBootstrap.ObservabilityOptions(config, ObservabilityRole.Worker)
        const observability = observabilityOptions !== undefined ? Observability.Start(observabilityOptions) : undefined
        const bundle = config.deploymentMode === DeploymentMode.Cloud ? await WorkerMain.BuildBundle(config) : undefined
        let main: WorkerMain
        try
        {
            const audit = HostBootstrap.AuditSink(config, logger, observability, bundle !== undefined ? await bundle.Platform.AuditSink() : undefined)
            const rateLimit = HostBootstrap.RateLimit(config, audit, observability, logger)
            const host = await WorkerHost.StartAsync(ServerBootstrap.ComposeWorkerOptions(config, provisioning, bundle?.Platform, provisionedSecrets, logger, observability, audit, rateLimit))
            logger.Info(ServerBootstrap.WorkerStartupLine(config), { [WorkerMain.EventKey]: WorkerMain.StartupEvent })
            main = new WorkerMain(host, audit, logger, bundle)
        }
        catch (error)
        {
            await WorkerMain.DisposeQuietly(bundle)
            throw error
        }
        process.on(WorkerMain.SigTerm, () => void main.Shutdown())
        process.on(WorkerMain.SigInt, () => void main.Shutdown())
    }

    public static Fail(error: unknown): void
    {
        StructuredLogger.ToStdout().Error(WorkerMain.StartFailedPrefix + (error instanceof Error ? error.message : WorkerMain.UnknownError), { [WorkerMain.EventKey]: WorkerMain.StartFailedEvent })
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

WorkerMain.Run().catch(WorkerMain.Fail)
