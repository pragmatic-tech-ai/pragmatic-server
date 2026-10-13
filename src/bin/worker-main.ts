import { readFileSync } from 'node:fs'
import { ServerConfigLoader } from '../config/server-config-loader.js'
import { TenantProvisioningFactory } from '../config/tenant-provisioning-factory.js'
import { ProvisionedSecretsFactory } from '../config/provisioned-secrets-factory.js'
import { WorkerHost } from '../cluster/worker-host.js'
import { ServerBootstrap } from './server-bootstrap.js'
import { StructuredLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'
import { DeploymentMode } from '../platform/deployment-mode.js'
import { GcpPlatformFactory } from '../platform/gcp-platform-factory.js'
import type { ICloudBundle } from '../platform/gcp-platform-factory.js'
import { Observability, ObservabilityRole } from '../observability/observability.js'

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
    private static readonly ShutdownEvent = 'shutdown'
    private static readonly StartFailedEvent = 'start-failed'
    private static readonly ShutdownErrorEvent = 'shutdown-error'
    private static readonly EventKey = 'event'

    private shuttingDown = false

    private constructor(private readonly host: WorkerHost, private readonly logger: ILogger, private readonly bundle?: ICloudBundle)
    {
    }

    public static async Run(): Promise<void>
    {
        const logger = StructuredLogger.ToStdout()
        const read = (path: string): string => readFileSync(path, WorkerMain.Utf8)
        const config = ServerConfigLoader.Load(process.env, read)
        const { provisioning } = TenantProvisioningFactory.Build(config, read)
        const provisionedSecrets = ProvisionedSecretsFactory.Build(config, read)
        const observabilityOptions = ServerBootstrap.ObservabilityOptions(config, ObservabilityRole.Worker)
        const observability = observabilityOptions !== undefined ? Observability.Start(observabilityOptions) : undefined
        const bundle = config.deploymentMode === DeploymentMode.Cloud ? await GcpPlatformFactory.Create(config) : undefined
        const audit = ServerBootstrap.AuditSink(config, logger, observability, bundle !== undefined ? await bundle.Platform.AuditSink() : undefined)
        const rateLimit = ServerBootstrap.RateLimit(config, audit, observability, logger)
        const host = await WorkerHost.StartAsync(ServerBootstrap.ComposeWorkerOptions(config, provisioning, bundle?.Platform, provisionedSecrets, logger, observability, audit, rateLimit))
        logger.Info(ServerBootstrap.WorkerStartupLine(config), { [WorkerMain.EventKey]: WorkerMain.StartupEvent })
        const main = new WorkerMain(host, logger, bundle)
        process.on(WorkerMain.SigTerm, () => void main.Shutdown())
        process.on(WorkerMain.SigInt, () => void main.Shutdown())
    }

    public static Fail(error: unknown): void
    {
        StructuredLogger.ToStdout().Error(WorkerMain.StartFailedPrefix + (error instanceof Error ? error.message : WorkerMain.UnknownError), { [WorkerMain.EventKey]: WorkerMain.StartFailedEvent })
        process.exit(1)
    }

    private async DisposeBundle(): Promise<void>
    {
        if (this.bundle === undefined)
        {
            return
        }
        try
        {
            await this.bundle.Dispose()
        }
        catch
        {
            // best-effort: a bundle teardown failure must not block exit
        }
    }

    private async Shutdown(): Promise<void>
    {
        if (this.shuttingDown)
        {
            return
        }
        this.shuttingDown = true
        this.logger.Info(WorkerMain.ShutdownLine, { [WorkerMain.EventKey]: WorkerMain.ShutdownEvent })
        try
        {
            await this.host.DisposeAsync()
        }
        catch (error)
        {
            this.logger.Error(WorkerMain.ShutdownErrorPrefix + (error instanceof Error ? error.message : WorkerMain.UnknownError), { [WorkerMain.EventKey]: WorkerMain.ShutdownErrorEvent })
            await this.DisposeBundle()
            process.exit(1)
            return
        }
        await this.DisposeBundle()
        process.exit(0)
    }
}

WorkerMain.Run().catch(WorkerMain.Fail)
