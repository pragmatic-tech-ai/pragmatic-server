import { readFileSync } from 'node:fs'
import { ServerConfigLoader } from '../config/server-config-loader.js'
import { TenantProvisioningFactory } from '../config/tenant-provisioning-factory.js'
import { ProvisionedSecretsFactory } from '../config/provisioned-secrets-factory.js'
import { WorkerHost } from '../cluster/worker-host.js'
import { ServerBootstrap } from './server-bootstrap.js'

class WorkerMain
{
    private static readonly Utf8 = 'utf8'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly SigInt = 'SIGINT'
    private static readonly StartFailedPrefix = 'pragmatic-worker failed to start: '
    private static readonly UnknownError = 'unknown error'
    private static readonly ShutdownLine = 'pragmatic-worker shutting down'
    private static readonly ShutdownErrorPrefix = 'pragmatic-worker shutdown error: '

    private shuttingDown = false

    private constructor(private readonly host: WorkerHost)
    {
    }

    public static async Run(): Promise<void>
    {
        const read = (path: string): string => readFileSync(path, WorkerMain.Utf8)
        const config = ServerConfigLoader.Load(process.env, read)
        const { provisioning } = TenantProvisioningFactory.Build(config, read)
        const provisionedSecrets = ProvisionedSecretsFactory.Build(config, read)
        const host = await WorkerHost.StartAsync(ServerBootstrap.ComposeWorkerOptions(config, provisioning, provisionedSecrets))
        console.log(ServerBootstrap.WorkerStartupLine(config))
        const main = new WorkerMain(host)
        process.on(WorkerMain.SigTerm, () => void main.Shutdown())
        process.on(WorkerMain.SigInt, () => void main.Shutdown())
    }

    public static Fail(error: unknown): void
    {
        console.error(WorkerMain.StartFailedPrefix + (error instanceof Error ? error.message : WorkerMain.UnknownError))
        process.exit(1)
    }

    private async Shutdown(): Promise<void>
    {
        if (this.shuttingDown)
        {
            return
        }
        this.shuttingDown = true
        console.log(WorkerMain.ShutdownLine)
        try
        {
            await this.host.DisposeAsync()
        }
        catch (error)
        {
            console.error(WorkerMain.ShutdownErrorPrefix + (error instanceof Error ? error.message : WorkerMain.UnknownError))
            process.exit(1)
            return
        }
        process.exit(0)
    }
}

WorkerMain.Run().catch(WorkerMain.Fail)
