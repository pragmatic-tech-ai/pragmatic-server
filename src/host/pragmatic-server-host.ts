import { createServer } from 'node:http'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Socket, AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { WsMessageSocket } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { AccessContext, Tenant } from '@pragmatic-tech-ai/todl-identity'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { PragmaticServer } from '../pragmatic-server.js'
import type { PragmaticServerIdentityOptions } from '../pragmatic-server.js'
import { ServerConnectionHandler } from './server-connection-handler.js'
import { ConnectionAuthenticator } from './connection-authenticator.js'

export interface PragmaticServerHostOptions
{
    host?: string
    port: number
    packagesRoot?: string
    identity: PragmaticServerIdentityOptions
}

export interface WebSocketAddress
{
    host: string
    port: number
}

/** Serves one single-tenant PragmaticServer over http + a noServer ws WebSocketServer; every upgrade is bearer-authenticated. */
export class PragmaticServerHost
{
    private static readonly DefaultHost = '127.0.0.1'
    private static readonly UpgradeEvent = 'upgrade'
    private static readonly CloseEvent = 'close'
    private static readonly ListeningEvent = 'listening'
    private static readonly ErrorEvent = 'error'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly UnauthorizedResponse = 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'

    private readonly server: PragmaticServer
    private readonly httpServer: HttpServer
    private readonly wss: WebSocketServer
    private readonly languageService: ILanguageService
    private readonly manager: SolutionManagerService
    private readonly pack: ServerIdentityPack
    private readonly tenant: Tenant
    private readonly authenticator = new ConnectionAuthenticator()
    private readonly handlers = new Set<ServerConnectionHandler>()
    private readonly address: WebSocketAddress

    private constructor(
        server: PragmaticServer,
        httpServer: HttpServer,
        wss: WebSocketServer,
        languageService: ILanguageService,
        manager: SolutionManagerService,
        pack: ServerIdentityPack,
        tenant: Tenant,
        address: WebSocketAddress)
    {
        this.server = server
        this.httpServer = httpServer
        this.wss = wss
        this.languageService = languageService
        this.manager = manager
        this.pack = pack
        this.tenant = tenant
        this.address = address
        httpServer.on(PragmaticServerHost.UpgradeEvent, (req: IncomingMessage, socket: Socket, head: Buffer) =>
        {
            void this.Upgrade(req, socket, head)
        })
    }

    public static async StartAsync(options: PragmaticServerHostOptions): Promise<PragmaticServerHost>
    {
        const server = new PragmaticServer({ packagesRoot: options.packagesRoot, identity: options.identity })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const pack = await server.Pack()
        const tenant = server.Tenant()
        const host = options.host ?? PragmaticServerHost.DefaultHost
        const httpServer = createServer()
        const wss = new WebSocketServer({ noServer: true })
        try
        {
            await new Promise<void>((resolve, reject) =>
            {
                httpServer.once(PragmaticServerHost.ListeningEvent, () => resolve())
                httpServer.once(PragmaticServerHost.ErrorEvent, reject)
                httpServer.listen(options.port, host)
            })
        }
        catch (error)
        {
            await server.Dispose()
            throw error
        }
        const resolved = httpServer.address() as AddressInfo
        return new PragmaticServerHost(server, httpServer, wss, languageService, manager, pack, tenant, { host, port: resolved.port })
    }

    public Address(): WebSocketAddress
    {
        return this.address
    }

    /** Test seam: the resolved language service, so tests can trigger a graph change. */
    public async LanguageServiceForTest(): Promise<ILanguageService>
    {
        return this.languageService
    }

    /** Test seam: the identity pack, so tests can mint a token. */
    public async IdentityPackForTest(): Promise<ServerIdentityPack>
    {
        return this.pack
    }

    /** Test seam: the served tenant. */
    public TenantForTest(): Tenant
    {
        return this.tenant
    }

    public async DisposeAsync(): Promise<void>
    {
        for (const handler of this.handlers)
        {
            handler.Dispose()
        }
        this.handlers.clear()
        for (const client of this.wss.clients)
        {
            client.terminate()
        }
        await new Promise<void>(resolve => this.wss.close(() => resolve()))
        await new Promise<void>(resolve => this.httpServer.close(() => resolve()))
        await this.server.Dispose()
    }

    private async Upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void>
    {
        try
        {
            const context = await this.Authenticate(req)
            if (context === null)
            {
                this.Reject(socket)
                return
            }
            this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) =>
            {
                const handler = ServerConnectionHandler.Attach(new WsMessageSocket(ws), this.languageService, this.manager, context)
                this.handlers.add(handler)
                ws.on(PragmaticServerHost.CloseEvent, () =>
                {
                    handler.Dispose()
                    this.handlers.delete(handler)
                })
            })
        }
        catch
        {
            this.Reject(socket)
        }
    }

    private Reject(socket: Socket): void
    {
        socket.write(PragmaticServerHost.UnauthorizedResponse)
        socket.destroy()
    }

    private async Authenticate(req: IncomingMessage): Promise<AccessContext | null>
    {
        const header = req.headers[PragmaticServerHost.AuthorizationHeader]
        if (typeof header !== 'string' || !header.startsWith(PragmaticServerHost.BearerPrefix))
        {
            return null
        }
        const token = header.slice(PragmaticServerHost.BearerPrefix.length)
        return this.authenticator.ResolveAsync(token, this.tenant, this.pack)
    }
}
