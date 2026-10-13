import { readFileSync } from 'node:fs'
import { ServerConfigLoader } from '../config/server-config-loader.js'
import { TenantProvisioningFactory } from '../config/tenant-provisioning-factory.js'
import { ProvisionedSecretsFactory } from '../config/provisioned-secrets-factory.js'
import { WorkerHost } from '../cluster/worker-host.js'
import { ServerBootstrap } from './server-bootstrap.js'
import { StructuredLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'
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

    private constructor(private readonly host: WorkerHost, private readonly logger: ILogger)
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
        const audit = ServerBootstrap.AuditSink(config, logger, observability)
        const rateLimit = ServerBootstrap.RateLimit(config, audit, observability, logger)
        const host = await WorkerHost.StartAsync(ServerBootstrap.ComposeWorkerOptions(config, provisioning, provisionedSecrets, logger, observability, audit, rateLimit))
        logger.Info(ServerBootstrap.WorkerStartupLine(config), { [WorkerMain.EventKey]: WorkerMain.StartupEvent })
        const main = new WorkerMain(host, logger)
        process.on(WorkerMain.SigTerm, () => void main.Shutdown())
        process.on(WorkerMain.SigInt, () => void main.Shutdown())
    }

    public static Fail(error: unknown): void
    {
        StructuredLogger.ToStdout().Error(WorkerMain.StartFailedPrefix + (error instanceof Error ? error.message : WorkerMain.UnknownError), { [WorkerMain.EventKey]: WorkerMain.StartFailedEvent })
        process.exit(1)
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
            process.exit(1)
            return
        }
        process.exit(0)
    }
}

WorkerMain.Run().catch(WorkerMain.Fail)
