import { ServerConfigLoader } from '../config/server-config-loader.js'
import { Gateway } from '../cluster/gateway.js'
import { RedisWorkerRouter } from '../cluster/redis-worker-router.js'
import type { IWorkerRouter } from '../cluster/worker-router.js'
import { ServerBootstrap } from './server-bootstrap.js'
import { StructuredLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'
import { Observability, ObservabilityRole } from '../observability/observability.js'

class GatewayMain
{
    private static readonly SigTerm = 'SIGTERM'
    private static readonly SigInt = 'SIGINT'
    private static readonly StartFailedPrefix = 'pragmatic-gateway failed to start: '
    private static readonly UnknownError = 'unknown error'
    private static readonly ShutdownLine = 'pragmatic-gateway shutting down'
    private static readonly ShutdownErrorPrefix = 'pragmatic-gateway shutdown error: '

    private static readonly StartupEvent = 'startup'
    private static readonly ShutdownEvent = 'shutdown'
    private static readonly StartFailedEvent = 'start-failed'
    private static readonly ShutdownErrorEvent = 'shutdown-error'
    private static readonly EventKey = 'event'
    private static readonly ObservabilityShutdownFailed = 'observability shutdown failed: '
    private static readonly ObservabilityShutdownEvent = 'observability-shutdown-error'

    private shuttingDown = false

    private constructor(private readonly gateway: Gateway, private readonly router: IWorkerRouter, private readonly logger: ILogger, private readonly observability?: Observability)
    {
    }

    public static async Run(): Promise<void>
    {
        const logger = StructuredLogger.ToStdout()
        const gw = ServerConfigLoader.LoadGateway(process.env)
        const observabilityOptions = ServerBootstrap.ObservabilityOptions(gw, ObservabilityRole.Gateway)
        const observability = observabilityOptions !== undefined ? Observability.Start(observabilityOptions) : undefined
        const router = new RedisWorkerRouter(gw.redisUrl)
        const audit = ServerBootstrap.AuditSink(gw, logger, observability)
        const rateLimit = ServerBootstrap.RateLimit(gw, audit, observability, logger)
        const gateway = await Gateway.StartAsync(ServerBootstrap.ComposeGatewayOptions(gw, router, logger, rateLimit, observability))
        logger.Info(ServerBootstrap.GatewayStartupLine(gw), { [GatewayMain.EventKey]: GatewayMain.StartupEvent })
        const main = new GatewayMain(gateway, router, logger, observability)
        process.on(GatewayMain.SigTerm, () => void main.Shutdown())
        process.on(GatewayMain.SigInt, () => void main.Shutdown())
    }

    public static Fail(error: unknown): void
    {
        StructuredLogger.ToStdout().Error(GatewayMain.StartFailedPrefix + (error instanceof Error ? error.message : GatewayMain.UnknownError), { [GatewayMain.EventKey]: GatewayMain.StartFailedEvent })
        process.exit(1)
    }

    private async Shutdown(): Promise<void>
    {
        if (this.shuttingDown)
        {
            return
        }
        this.shuttingDown = true
        this.logger.Info(GatewayMain.ShutdownLine, { [GatewayMain.EventKey]: GatewayMain.ShutdownEvent })
        try
        {
            try
            {
                await this.gateway.DisposeAsync()
            }
            finally
            {
                await this.ShutdownObservability()
            }
        }
        catch (error)
        {
            this.logger.Error(GatewayMain.ShutdownErrorPrefix + (error instanceof Error ? error.message : GatewayMain.UnknownError), { [GatewayMain.EventKey]: GatewayMain.ShutdownErrorEvent })
            await this.router.Drain().catch(() => {})
            process.exit(1)
            return
        }
        await this.router.Drain().catch(() => {})
        process.exit(0)
    }

    private async ShutdownObservability(): Promise<void>
    {
        try
        {
            await this.observability?.Shutdown()
        }
        catch (error)
        {
            this.logger.Error(GatewayMain.ObservabilityShutdownFailed + (error instanceof Error ? error.message : GatewayMain.UnknownError), { [GatewayMain.EventKey]: GatewayMain.ObservabilityShutdownEvent })
        }
    }
}

GatewayMain.Run().catch(GatewayMain.Fail)
