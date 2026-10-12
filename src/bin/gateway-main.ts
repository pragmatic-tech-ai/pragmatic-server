import { ServerConfigLoader } from '../config/server-config-loader.js'
import { Gateway } from '../cluster/gateway.js'
import { RedisWorkerRouter } from '../cluster/redis-worker-router.js'
import type { IWorkerRouter } from '../cluster/worker-router.js'
import { ServerBootstrap } from './server-bootstrap.js'

class GatewayMain
{
    private static readonly SigTerm = 'SIGTERM'
    private static readonly SigInt = 'SIGINT'
    private static readonly StartFailedPrefix = 'pragmatic-gateway failed to start: '
    private static readonly UnknownError = 'unknown error'
    private static readonly ShutdownLine = 'pragmatic-gateway shutting down'
    private static readonly ShutdownErrorPrefix = 'pragmatic-gateway shutdown error: '

    private shuttingDown = false

    private constructor(private readonly gateway: Gateway, private readonly router: IWorkerRouter)
    {
    }

    public static async Run(): Promise<void>
    {
        const gw = ServerConfigLoader.LoadGateway(process.env)
        const router = new RedisWorkerRouter(gw.redisUrl)
        const gateway = await Gateway.StartAsync(ServerBootstrap.ComposeGatewayOptions(gw, router))
        console.log(ServerBootstrap.GatewayStartupLine(gw))
        const main = new GatewayMain(gateway, router)
        process.on(GatewayMain.SigTerm, () => void main.Shutdown())
        process.on(GatewayMain.SigInt, () => void main.Shutdown())
    }

    public static Fail(error: unknown): void
    {
        console.error(GatewayMain.StartFailedPrefix + (error instanceof Error ? error.message : GatewayMain.UnknownError))
        process.exit(1)
    }

    private async Shutdown(): Promise<void>
    {
        if (this.shuttingDown)
        {
            return
        }
        this.shuttingDown = true
        console.log(GatewayMain.ShutdownLine)
        try
        {
            await this.gateway.DisposeAsync()
            await this.router.Drain()
        }
        catch (error)
        {
            console.error(GatewayMain.ShutdownErrorPrefix + (error instanceof Error ? error.message : GatewayMain.UnknownError))
            process.exit(1)
            return
        }
        process.exit(0)
    }
}

GatewayMain.Run().catch(GatewayMain.Fail)
