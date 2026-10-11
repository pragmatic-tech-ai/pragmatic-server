import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { WsMessageSocket } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServer } from '../pragmatic-server.js'
import { ServerConnectionHandler } from './server-connection-handler.js'

export interface PragmaticServerHostOptions
{
    host?: string
    port: number
    packagesRoot?: string
}

export interface WebSocketAddress
{
    host: string
    port: number
}

/** Serves one single-tenant PragmaticServer over a ws WebSocketServer. */
export class PragmaticServerHost
{
    private static readonly DefaultHost = '127.0.0.1'
    private static readonly ConnectionEvent = 'connection'
    private static readonly CloseEvent = 'close'
    private static readonly ListeningEvent = 'listening'
    private static readonly ErrorEvent = 'error'

    private readonly server: PragmaticServer
    private readonly wss: WebSocketServer
    private readonly languageService: ILanguageService
    private readonly manager: SolutionManagerService
    private readonly handlers = new Set<ServerConnectionHandler>()
    private readonly address: WebSocketAddress

    private constructor(server: PragmaticServer, wss: WebSocketServer, languageService: ILanguageService, manager: SolutionManagerService, address: WebSocketAddress)
    {
        this.server = server
        this.wss = wss
        this.languageService = languageService
        this.manager = manager
        this.address = address
        wss.on(PragmaticServerHost.ConnectionEvent, (socket: WebSocket) =>
        {
            const handler = ServerConnectionHandler.Attach(new WsMessageSocket(socket), languageService, manager)
            this.handlers.add(handler)
            socket.on(PragmaticServerHost.CloseEvent, () =>
            {
                handler.Dispose()
                this.handlers.delete(handler)
            })
        })
    }

    public static async StartAsync(options: PragmaticServerHostOptions): Promise<PragmaticServerHost>
    {
        const server = new PragmaticServer({ packagesRoot: options.packagesRoot })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const host = options.host ?? PragmaticServerHost.DefaultHost
        const wss = new WebSocketServer({ host, port: options.port })
        try
        {
            await new Promise<void>((resolve, reject) =>
            {
                wss.once(PragmaticServerHost.ListeningEvent, () => resolve())
                wss.once(PragmaticServerHost.ErrorEvent, reject)
            })
        }
        catch (error)
        {
            await server.Dispose()
            throw error
        }
        const resolved = wss.address() as AddressInfo
        const address = { host, port: resolved.port }
        return new PragmaticServerHost(server, wss, languageService, manager, address)
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
        await this.server.Dispose()
    }
}
