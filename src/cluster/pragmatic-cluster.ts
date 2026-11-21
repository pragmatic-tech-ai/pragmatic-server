import { type MasterKeyRef, type MachineTlsRef, type DeploymentMode, type AdapterPacksConfig, type WebSocketAddress, InMemoryWorkerRouter, type IWorkerRouter } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { IEnvironmentProvisioning } from '../environments/environment-provisioning.js'
import { WorkerHost } from './worker-host.js'
import { Gateway } from './gateway.js'
import type { PlatformServices } from '../platform/platform-services.js'

export interface ClusterOptions
{
    host?: string
    port: number
    baseDir: string
    masterKey: MasterKeyRef
    provisioning: IEnvironmentProvisioning
    tls: MachineTlsRef
    platform?: PlatformServices
    deploymentMode?: DeploymentMode
    adapterPacks?: AdapterPacksConfig
}

/** In-process gateway + worker composition over a real loopback mutual-TLS wss channel.
 *  Starts a WorkerHost on an ephemeral port, routes every environment to it, and fronts it with a public-ws Gateway. */
export class PragmaticCluster
{
    private static readonly DefaultHost = '127.0.0.1'

    private readonly gateway: Gateway
    private readonly worker: WorkerHost
    private readonly router: IWorkerRouter

    private constructor(gateway: Gateway, worker: WorkerHost, router: IWorkerRouter)
    {
        this.gateway = gateway
        this.worker = worker
        this.router = router
    }

    public static async StartAsync(options: ClusterOptions): Promise<PragmaticCluster>
    {
        const host = options.host ?? PragmaticCluster.DefaultHost
        const worker = await WorkerHost.StartAsync({ host, port: 0, baseDir: options.baseDir, masterKey: options.masterKey, provisioning: options.provisioning, tls: options.tls, platform: options.platform, deploymentMode: options.deploymentMode, adapterPacks: options.adapterPacks })
        const router = new InMemoryWorkerRouter(worker.Address())
        const gateway = await Gateway.StartAsync({ host: options.host, port: options.port, router, tls: options.tls })
        return new PragmaticCluster(gateway, worker, router)
    }

    public Address(): WebSocketAddress
    {
        return this.gateway.Address()
    }

    public WorkerForTest(): WorkerHost
    {
        return this.worker
    }

    public async DisposeAsync(): Promise<void>
    {
        await this.gateway.DisposeAsync()
        await this.router.Drain()
        await this.worker.DisposeAsync()
    }
}
