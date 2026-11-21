import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentChannelHost, type IAgentChannelBackend, type IDesktopDiscoveryBackend, DesktopDiscoveryEndpoint, PlaneHttp } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { EdgeClientAddress } from './edge-client-address.js'

/**
 * The edge's one public listener (behind Caddy): the agent channel, desktop discovery and a liveness probe, nothing
 * else. It holds no state of its own besides the discovery throttle; every answer comes from the backends.
 */
export class EdgeHost
{
    public static readonly HealthzPath = '/healthz'
    private static readonly OkBody = { ok: true }
    private static readonly NotListeningMessage = 'EdgeHost is not listening'

    private readonly channel: AgentChannelHost
    private readonly discovery: DesktopDiscoveryEndpoint
    private httpServer: HttpServer | undefined

    public constructor(agent: IAgentChannelBackend, discovery: IDesktopDiscoveryBackend, private readonly trustedProxy: boolean)
    {
        this.channel = new AgentChannelHost(agent)
        this.discovery = new DesktopDiscoveryEndpoint(discovery, DesktopDiscoveryEndpoint.NewThrottle())
    }

    public Listen(port: number, bind: string): Promise<void>
    {
        const server = createServer((req, res) =>
        {
            void this.Serve(req, res)
        })
        return new Promise((resolve, reject) =>
        {
            server.once('error', reject)
            server.listen(port, bind, () =>
            {
                server.off('error', reject)
                this.httpServer = server
                resolve()
            })
        })
    }

    public async Close(): Promise<void>
    {
        const server = this.httpServer
        this.httpServer = undefined
        if (server !== undefined)
        {
            server.closeAllConnections()
            await new Promise<void>(res => server.close(() => res()))
        }
    }

    public Address(): { address: string; port: number }
    {
        const a = this.httpServer?.address() as AddressInfo | null | undefined
        if (a === null || a === undefined)
        {
            throw new Error(EdgeHost.NotListeningMessage)
        }
        return { address: a.address, port: a.port }
    }

    private async Serve(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const url = req.url ?? ''
        if (url === EdgeHost.HealthzPath && req.method === PlaneHttp.MethodGet)
        {
            req.resume()
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, EdgeHost.OkBody)
            return
        }
        if (url === DesktopDiscoveryEndpoint.Path && req.method === PlaneHttp.MethodPost)
        {
            await this.discovery.Handle(req, res, EdgeClientAddress.Of(req, this.trustedProxy))
            return
        }
        if (AgentChannelHost.IsChannelPath(url))
        {
            await this.channel.Serve(req, res)
            return
        }
        req.resume()
        PlaneHttp.WriteNotFound(res)
    }
}
