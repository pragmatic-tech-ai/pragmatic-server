import { readFileSync } from 'node:fs'
import { ServerConfigLoader } from '../config/server-config-loader.js'
import { TenantProvisioningFactory } from '../config/tenant-provisioning-factory.js'
import { PragmaticServerHost } from '../host/pragmatic-server-host.js'
import { ServerBootstrap } from './server-bootstrap.js'

class ServerMain
{
    private static readonly Utf8 = 'utf8'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly SigInt = 'SIGINT'
    private static readonly StartFailedPrefix = 'pragmatic-server failed to start: '
    private static readonly UnknownError = 'unknown error'
    private static readonly ShutdownLine = 'pragmatic-server shutting down'
    private static readonly ShutdownErrorPrefix = 'pragmatic-server shutdown error: '

    private shuttingDown = false

    private constructor(private readonly host: PragmaticServerHost)
    {
    }

    public static async Run(): Promise<void>
    {
        const read = (path: string): string => readFileSync(path, ServerMain.Utf8)
        const config = ServerConfigLoader.Load(process.env, read)
        const { provisioning, tenantCount } = TenantProvisioningFactory.Build(config, read)
        const options = ServerBootstrap.ComposeOptions(config, provisioning)
        const host = await PragmaticServerHost.StartAsync(options)
        console.log(ServerBootstrap.StartupLine(config, tenantCount))
        const main = new ServerMain(host)
        process.on(ServerMain.SigTerm, () => void main.Shutdown())
        process.on(ServerMain.SigInt, () => void main.Shutdown())
    }

    public static Fail(error: unknown): void
    {
        console.error(ServerMain.StartFailedPrefix + (error instanceof Error ? error.message : ServerMain.UnknownError))
        process.exit(1)
    }

    private async Shutdown(): Promise<void>
    {
        if (this.shuttingDown)
        {
            return
        }
        this.shuttingDown = true
        console.log(ServerMain.ShutdownLine)
        try
        {
            await this.host.DisposeAsync()
        }
        catch (error)
        {
            console.error(ServerMain.ShutdownErrorPrefix + (error instanceof Error ? error.message : ServerMain.UnknownError))
            process.exit(1)
            return
        }
        process.exit(0)
    }
}

ServerMain.Run().catch(ServerMain.Fail)
