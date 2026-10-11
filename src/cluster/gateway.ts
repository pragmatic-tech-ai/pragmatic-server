import { createServer } from 'node:http'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import type { RawData } from 'ws'
import type { WebSocketAddress } from '../host/pragmatic-server-host.js'
import type { IWorkerRouter, WorkerEndpoint } from './worker-router.js'
import { MachineTls } from './machine-tls.js'
import type { ClientTlsMaterial, MachineTlsRef } from './machine-tls.js'

export interface GatewayOptions
{
    host?: string
    port: number
    router: IWorkerRouter
    tls: MachineTlsRef
}

/** Public plain-ws front door. Holds NO identity pack and never parses JSON-RPC: it reads the ?tenant hint,
 *  dials the worker over mutual-TLS wss (forwarding tenant + bearer), and relays raw frames both ways.
 *  The client-side upgrade completes only after the worker ws opens, so a worker rejection rejects the client. */
export class Gateway
{
    private static readonly DefaultHost = '127.0.0.1'
    private static readonly UpgradeEvent = 'upgrade'
    private static readonly RequestEvent = 'request'
    private static readonly MessageEvent = 'message'
    private static readonly OpenEvent = 'open'
    private static readonly CloseEvent = 'close'
    private static readonly ErrorEvent = 'error'
    private static readonly ListeningEvent = 'listening'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly TenantHeader = 'x-pragmatic-tenant'
    private static readonly TenantParam = 'tenant'
    private static readonly BaseUrl = 'http://localhost'
    private static readonly ServerName = '127.0.0.1'
    private static readonly WsScheme = 'wss://'
    private static readonly UnauthorizedResponse = 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'
    private static readonly BadGatewayStatus = 502
    private static readonly BadRequestStatus = 400
    private static readonly TenantPattern = /^[A-Za-z0-9._-]+$/

    private readonly httpServer: HttpServer
    private readonly wss: WebSocketServer
    private readonly router: IWorkerRouter
    private readonly clientTls: ClientTlsMaterial
    private readonly address: WebSocketAddress
    private readonly workerSockets = new Set<WebSocket>()
    private disposed = false

    private constructor(httpServer: HttpServer, wss: WebSocketServer, router: IWorkerRouter, clientTls: ClientTlsMaterial, address: WebSocketAddress)
    {
        this.httpServer = httpServer
        this.wss = wss
        this.router = router
        this.clientTls = clientTls
        this.address = address
        httpServer.on(Gateway.UpgradeEvent, (req: IncomingMessage, socket: Socket, head: Buffer) =>
        {
            socket.on(Gateway.ErrorEvent, () => socket.destroy())
            void this.Upgrade(req, socket, head)
        })
        httpServer.on(Gateway.RequestEvent, (req: IncomingMessage, res: ServerResponse) =>
        {
            void this.Request(req, res)
        })
    }

    public static async StartAsync(options: GatewayOptions): Promise<Gateway>
    {
        const host = options.host ?? Gateway.DefaultHost
        const httpServer = createServer()
        const wss = new WebSocketServer({ noServer: true })
        await new Promise<void>((resolve, reject) =>
        {
            httpServer.once(Gateway.ListeningEvent, () => resolve())
            httpServer.once(Gateway.ErrorEvent, reject)
            httpServer.listen(options.port, host)
        })
        const resolved = httpServer.address() as AddressInfo
        const clientTls = MachineTls.Client(options.tls)
        return new Gateway(httpServer, wss, options.router, clientTls, { host, port: resolved.port })
    }

    public Address(): WebSocketAddress
    {
        return this.address
    }

    public async DisposeAsync(): Promise<void>
    {
        this.disposed = true
        for (const workerWs of this.workerSockets)
        {
            workerWs.terminate()
        }
        this.workerSockets.clear()
        for (const client of this.wss.clients)
        {
            client.terminate()
        }
        await new Promise<void>(resolve => this.wss.close(() => resolve()))
        await new Promise<void>(resolve => this.httpServer.close(() => resolve()))
    }

    private async Upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void>
    {
        try
        {
            const tenantId = this.TenantHint(req)
            if (tenantId === null)
            {
                this.Reject(socket)
                return
            }
            let endpoint: WorkerEndpoint
            try
            {
                endpoint = await this.router.RouteOrSpawn(tenantId)
            }
            catch
            {
                this.Reject(socket)
                return
            }
            if (this.disposed)
            {
                this.Reject(socket)
                return
            }
            this.Dial(req, socket, head, tenantId, endpoint, this.AuthorizationOf(req))
        }
        catch
        {
            this.Reject(socket)
        }
    }

    private Dial(req: IncomingMessage, socket: Socket, head: Buffer, tenantId: string, endpoint: WorkerEndpoint, authorization: string | null): void
    {
        const client = this.clientTls
        const headers: Record<string, string> = { [Gateway.TenantHeader]: tenantId }
        if (authorization !== null)
        {
            headers[Gateway.AuthorizationHeader] = authorization
        }
        const wsOptions = { key: client.key, cert: client.cert, ca: client.ca, rejectUnauthorized: true, servername: Gateway.ServerName, headers }
        const workerWs = new WebSocket(`${Gateway.WsScheme}${endpoint.host}:${endpoint.port}/`, wsOptions)
        this.workerSockets.add(workerWs)
        let opened = false
        let bridged = false
        workerWs.once(Gateway.OpenEvent, () =>
        {
            opened = true
            if (this.disposed)
            {
                workerWs.terminate()
                this.Reject(socket)
                return
            }
            this.wss.handleUpgrade(req, socket, head, (clientWs: WebSocket) =>
            {
                bridged = true
                this.Bridge(clientWs, workerWs)
            })
        })
        workerWs.once(Gateway.ErrorEvent, () =>
        {
            this.workerSockets.delete(workerWs)
            if (!opened)
            {
                this.Reject(socket)
            }
        })
        workerWs.once(Gateway.CloseEvent, () =>
        {
            this.workerSockets.delete(workerWs)
            if (!opened)
            {
                this.Reject(socket)
            }
        })
        socket.on(Gateway.ErrorEvent, () => workerWs.terminate())
        socket.on(Gateway.CloseEvent, () =>
        {
            if (!bridged)
            {
                this.workerSockets.delete(workerWs)
                workerWs.terminate()
            }
        })
    }

    private Bridge(clientWs: WebSocket, workerWs: WebSocket): void
    {
        clientWs.on(Gateway.MessageEvent, (data: RawData, isBinary: boolean) =>
        {
            if (workerWs.readyState === WebSocket.OPEN)
            {
                workerWs.send(data, { binary: isBinary })
            }
        })
        workerWs.on(Gateway.MessageEvent, (data: RawData, isBinary: boolean) =>
        {
            if (clientWs.readyState === WebSocket.OPEN)
            {
                clientWs.send(data, { binary: isBinary })
            }
        })
        clientWs.on(Gateway.CloseEvent, () =>
        {
            this.workerSockets.delete(workerWs)
            this.CloseSafe(workerWs)
        })
        workerWs.on(Gateway.CloseEvent, () => this.CloseSafe(clientWs))
        clientWs.on(Gateway.ErrorEvent, () =>
        {
            this.workerSockets.delete(workerWs)
            workerWs.terminate()
        })
        workerWs.on(Gateway.ErrorEvent, () => clientWs.terminate())
    }

    private CloseSafe(ws: WebSocket): void
    {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        {
            ws.close()
        }
    }

    private async Request(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        try
        {
            const tenantId = this.TenantHint(req)
            if (tenantId === null)
            {
                res.writeHead(Gateway.BadRequestStatus)
                res.end()
                return
            }
            let endpoint: WorkerEndpoint
            try
            {
                endpoint = await this.router.RouteOrSpawn(tenantId)
            }
            catch
            {
                res.writeHead(Gateway.BadGatewayStatus)
                res.end()
                return
            }
            const client = this.clientTls
            const headers = { ...req.headers, [Gateway.TenantHeader]: tenantId }
            const proxied = httpsRequest(
                { host: endpoint.host, port: endpoint.port, method: req.method, path: req.url, headers, key: client.key, cert: client.cert, ca: client.ca, rejectUnauthorized: true, servername: Gateway.ServerName },
                upstream =>
                {
                    upstream.on(Gateway.ErrorEvent, () =>
                    {
                        if (!res.headersSent && !res.writableEnded)
                        {
                            res.writeHead(Gateway.BadGatewayStatus)
                            res.end()
                        }
                        else
                        {
                            res.destroy()
                        }
                    })
                    res.writeHead(upstream.statusCode ?? Gateway.BadGatewayStatus, upstream.headers)
                    upstream.pipe(res)
                })
            proxied.on(Gateway.ErrorEvent, () =>
            {
                if (!res.headersSent && !res.writableEnded)
                {
                    res.writeHead(Gateway.BadGatewayStatus)
                    res.end()
                }
            })
            req.on(Gateway.ErrorEvent, () => proxied.destroy())
            res.on(Gateway.ErrorEvent, () => proxied.destroy())
            res.on(Gateway.CloseEvent, () => proxied.destroy())
            req.pipe(proxied)
        }
        catch
        {
            if (!res.headersSent && !res.writableEnded)
            {
                res.writeHead(Gateway.BadGatewayStatus)
                res.end()
            }
        }
    }

    private AuthorizationOf(req: IncomingMessage): string | null
    {
        const header = req.headers[Gateway.AuthorizationHeader]
        return typeof header === 'string' ? header : null
    }

    private TenantHint(req: IncomingMessage): string | null
    {
        let tenant: string | null
        try
        {
            const url = new URL(req.url ?? '/', Gateway.BaseUrl)
            tenant = url.searchParams.get(Gateway.TenantParam)
        }
        catch
        {
            return null
        }
        if (tenant === null || tenant.length === 0 || !Gateway.TenantPattern.test(tenant))
        {
            return null
        }
        return tenant
    }

    private Reject(socket: Socket): void
    {
        if (!socket.writableEnded && !socket.destroyed)
        {
            socket.write(Gateway.UnauthorizedResponse)
        }
        socket.destroy()
    }
}
