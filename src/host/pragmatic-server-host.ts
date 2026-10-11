import { createServer } from 'node:http'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { WsMessageSocket } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { AccessContext, Tenant } from '@pragmatic-tech-ai/todl-identity'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { PragmaticServer } from '../pragmatic-server.js'
import { ServerConnectionHandler } from './server-connection-handler.js'
import { ConnectionAuthenticator } from './connection-authenticator.js'
import { AuthHttpEndpoint } from './auth-http-endpoint.js'
import { InMemoryTenantCoordinator } from '../tenancy/tenant-coordinator.js'
import { TenantRegistry } from '../tenancy/tenant-registry.js'
import type { ITenantProvisioning } from '../tenancy/tenant-provisioning.js'

export interface PragmaticServerHostOptions
{
    host?: string
    port: number
    baseDir: string
    masterKey: MasterKeyRef
    provisioning: ITenantProvisioning
    idleTtlMs?: number
    idleSweepMs?: number
}

export interface WebSocketAddress
{
    host: string
    port: number
}

export class PragmaticServerHost
{
    private static readonly DefaultHost = '127.0.0.1'
    private static readonly UpgradeEvent = 'upgrade'
    private static readonly RequestEvent = 'request'
    private static readonly CloseEvent = 'close'
    private static readonly ListeningEvent = 'listening'
    private static readonly ErrorEvent = 'error'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly TenantParam = 'tenant'
    private static readonly BaseUrl = 'http://localhost'
    private static readonly UnauthorizedResponse = 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'
    private static readonly NotFoundStatus = 404
    private static readonly DefaultIdleTtlMs = 300_000
    private static readonly DefaultIdleSweepMs = 30_000

    private readonly httpServer: HttpServer
    private readonly wss: WebSocketServer
    private readonly registry: TenantRegistry
    private readonly authenticator = new ConnectionAuthenticator()
    private readonly handlers = new Set<ServerConnectionHandler>()
    private readonly address: WebSocketAddress
    private readonly idleTtlMs: number
    private readonly sweep: NodeJS.Timeout

    private constructor(
        httpServer: HttpServer,
        wss: WebSocketServer,
        registry: TenantRegistry,
        address: WebSocketAddress,
        idleTtlMs: number,
        idleSweepMs: number)
    {
        this.httpServer = httpServer
        this.wss = wss
        this.registry = registry
        this.address = address
        this.idleTtlMs = idleTtlMs
        httpServer.on(PragmaticServerHost.UpgradeEvent, (req: IncomingMessage, socket: Socket, head: Buffer) =>
        {
            socket.on(PragmaticServerHost.ErrorEvent, () => socket.destroy())
            void this.Upgrade(req, socket, head)
        })
        httpServer.on(PragmaticServerHost.RequestEvent, (req: IncomingMessage, res: ServerResponse) =>
        {
            void this.Request(req, res)
        })
        this.sweep = setInterval(() => void this.registry.EvictIdle(Date.now(), this.idleTtlMs), idleSweepMs)
        this.sweep.unref()
    }

    public static async StartAsync(options: PragmaticServerHostOptions): Promise<PragmaticServerHost>
    {
        const coordinator = new InMemoryTenantCoordinator()
        const registry = new TenantRegistry(options.baseDir, options.masterKey, options.provisioning, coordinator)
        const host = options.host ?? PragmaticServerHost.DefaultHost
        const httpServer = createServer()
        const wss = new WebSocketServer({ noServer: true })
        await new Promise<void>((resolve, reject) =>
        {
            httpServer.once(PragmaticServerHost.ListeningEvent, () => resolve())
            httpServer.once(PragmaticServerHost.ErrorEvent, reject)
            httpServer.listen(options.port, host)
        })
        const resolved = httpServer.address() as AddressInfo
        return new PragmaticServerHost(httpServer, wss, registry, { host, port: resolved.port }, options.idleTtlMs ?? PragmaticServerHost.DefaultIdleTtlMs, options.idleSweepMs ?? PragmaticServerHost.DefaultIdleSweepMs)
    }

    public Address(): WebSocketAddress
    {
        return this.address
    }

    public RegistryForTest(): TenantRegistry
    {
        return this.registry
    }

    public async IdentityPackForTest(tenantId: string): Promise<ServerIdentityPack>
    {
        return (await this.registry.ServerFor(tenantId)).Pack()
    }

    public async TenantForTest(tenantId: string): Promise<Tenant>
    {
        return (await this.registry.ServerFor(tenantId)).Tenant()
    }

    public async LanguageServiceForTest(tenantId: string): Promise<ILanguageService>
    {
        return (await this.registry.ServerFor(tenantId)).LanguageService()
    }

    /** Test seam: number of live authenticated connections. */
    public HandlerCountForTest(): number
    {
        return this.handlers.size
    }

    public async DisposeAsync(): Promise<void>
    {
        clearInterval(this.sweep)
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
        await this.registry.DisposeAll()
    }

    private async Upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void>
    {
        try
        {
            const resolved = await this.Resolve(req)
            if (resolved === null)
            {
                this.Reject(socket)
                return
            }
            const { server, context, tenantId } = resolved
            const languageService = await server.LanguageService()
            const manager = await server.Manager()
            this.registry.Acquire(tenantId)
            this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) =>
            {
                const handler = ServerConnectionHandler.Attach(new WsMessageSocket(ws), languageService, manager, context)
                this.handlers.add(handler)
                ws.on(PragmaticServerHost.CloseEvent, () =>
                {
                    handler.Dispose()
                    this.handlers.delete(handler)
                    this.registry.Release(tenantId)
                })
            })
        }
        catch
        {
            this.Reject(socket)
        }
    }

    private async Resolve(req: IncomingMessage): Promise<{ server: PragmaticServer; context: AccessContext; tenantId: string } | null>
    {
        const tenantId = this.TenantHint(req)
        if (tenantId === null)
        {
            return null
        }
        let server: PragmaticServer
        try
        {
            server = await this.registry.ServerFor(tenantId)
        }
        catch
        {
            return null
        }
        const header = req.headers[PragmaticServerHost.AuthorizationHeader]
        if (typeof header !== 'string' || !header.startsWith(PragmaticServerHost.BearerPrefix))
        {
            return null
        }
        const token = header.slice(PragmaticServerHost.BearerPrefix.length)
        if (token.length === 0)
        {
            return null
        }
        const context = await this.authenticator.ResolveAsync(token, server.Tenant(), await server.Pack())
        if (context === null)
        {
            return null
        }
        return { server, context, tenantId }
    }

    private async Request(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        try
        {
            const tenantId = this.TenantHint(req)
            if (tenantId === null)
            {
                res.writeHead(PragmaticServerHost.NotFoundStatus)
                res.end()
                return
            }
            const server = await this.registry.ServerFor(tenantId)
            const endpoint = new AuthHttpEndpoint(await server.Pack(), server.Tenant(), server.Oidc())
            await endpoint.Handle(req, res)
        }
        catch
        {
            if (!res.writableEnded)
            {
                res.writeHead(PragmaticServerHost.NotFoundStatus)
                res.end()
            }
        }
    }

    private TenantHint(req: IncomingMessage): string | null
    {
        const url = new URL(req.url ?? '/', PragmaticServerHost.BaseUrl)
        const tenant = url.searchParams.get(PragmaticServerHost.TenantParam)
        return tenant !== null && tenant.length > 0 ? tenant : null
    }

    private Reject(socket: Socket): void
    {
        if (!socket.writableEnded && !socket.destroyed)
        {
            socket.write(PragmaticServerHost.UnauthorizedResponse)
        }
        socket.destroy()
    }
}
