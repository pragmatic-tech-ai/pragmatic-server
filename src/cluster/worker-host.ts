import { createServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import type { Server as PlainHttpServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { WsMessageSocket } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { PragmaticServer } from '../pragmatic-server.js'
import { ServerConnectionHandler } from '../host/server-connection-handler.js'
import { ConnectionAuthenticator } from '../host/connection-authenticator.js'
import { AuthHttpEndpoint } from '../host/auth-http-endpoint.js'
import type { WebSocketAddress } from '../host/pragmatic-server-host.js'
import { InMemoryTenantCoordinator } from '../tenancy/tenant-coordinator.js'
import { TenantRegistry } from '../tenancy/tenant-registry.js'
import { TenantOwnedElsewhereError, InMemoryTenantOwnership } from '../tenancy/tenant-ownership.js'
import type { ITenantOwnership } from '../tenancy/tenant-ownership.js'
import { RedisTenantOwnership } from '../tenancy/redis-tenant-ownership.js'
import { WorkerRegistration } from './worker-registration.js'
import { HealthEndpoint } from '../host/health-endpoint.js'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'
import type { WorkerEndpoint } from './worker-router.js'
import type { ITenantProvisioning } from '../tenancy/tenant-provisioning.js'
import { MachineTls } from './machine-tls.js'
import type { MachineTlsRef } from './machine-tls.js'
import { MachineFingerprintHeader } from './machine-headers.js'
import { TLSSocket } from 'node:tls'
import { MachineCertIdentity } from '../host/machine-principal-map.js'
import type { MachineAuthContext } from '../host/auth-http-endpoint.js'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { AuthMethod } from '@pragmatic-tech-ai/todl-identity'
import type { PlatformServices } from '../platform/platform-services.js'
import type { DeploymentMode } from '../platform/deployment-mode.js'

export interface WorkerHostOptions
{
    host?: string
    port: number
    baseDir: string
    masterKey: MasterKeyRef
    provisioning: ITenantProvisioning
    tls: MachineTlsRef
    idleTtlMs?: number
    idleSweepMs?: number
    platform?: PlatformServices
    deploymentMode?: DeploymentMode
    redisUrl?: string
    replicaId?: string
    provisionedSecrets?: IProvisionedSecretSource
    healthPort?: number
    advertise?: WorkerEndpoint
}

/** Internal mutual-TLS wss worker: the gateway (a verified client cert) forwards x-pragmatic-tenant + authorization;
 *  the worker owns the tenant's pack, authenticates the bearer against it, isolates each tenant in its own PragmaticServer. */
export class WorkerHost
{
    private static readonly DefaultHost = '127.0.0.1'
    private static readonly UpgradeEvent = 'upgrade'
    private static readonly RequestEvent = 'request'
    private static readonly CloseEvent = 'close'
    private static readonly ListeningEvent = 'listening'
    private static readonly ErrorEvent = 'error'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly TenantHeader = 'x-pragmatic-tenant'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ServiceUnavailableResponse = 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n'
    private static readonly NotFoundStatus = 404
    private static readonly DefaultHealthHost = '0.0.0.0'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly TextPlain = 'text/plain'
    private static readonly NoHealthServer = 'no health server configured'
    private static readonly DefaultIdleTtlMs = 300_000
    private static readonly DefaultIdleSweepMs = 30_000

    private readonly httpsServer: HttpsServer
    private readonly wss: WebSocketServer
    private readonly registry: TenantRegistry
    private readonly authenticator = new ConnectionAuthenticator()
    private readonly handlers = new Set<ServerConnectionHandler>()
    private readonly address: WebSocketAddress
    private readonly idleTtlMs: number
    private readonly sweep: NodeJS.Timeout
    private readonly health = new HealthEndpoint()
    private readonly healthServer: PlainHttpServer | null
    private readonly healthAddress: WebSocketAddress | null
    private readonly registration: WorkerRegistration | null
    private ready = false
    private disposed = false

    private constructor(
        httpsServer: HttpsServer,
        wss: WebSocketServer,
        registry: TenantRegistry,
        address: WebSocketAddress,
        idleTtlMs: number,
        idleSweepMs: number,
        healthServer: PlainHttpServer | null,
        healthAddress: WebSocketAddress | null,
        registration: WorkerRegistration | null)
    {
        this.healthServer = healthServer
        this.healthAddress = healthAddress
        this.registration = registration
        this.httpsServer = httpsServer
        this.wss = wss
        this.registry = registry
        this.address = address
        this.idleTtlMs = idleTtlMs
        httpsServer.on(WorkerHost.UpgradeEvent, (req: IncomingMessage, socket: Socket, head: Buffer) =>
        {
            socket.on(WorkerHost.ErrorEvent, () => socket.destroy())
            void this.Upgrade(req, socket, head)
        })
        httpsServer.on(WorkerHost.RequestEvent, (req: IncomingMessage, res: ServerResponse) =>
        {
            void this.Request(req, res)
        })
        this.sweep = setInterval(() => void this.registry.EvictIdle(Date.now(), this.idleTtlMs), idleSweepMs)
        this.sweep.unref()
        if (healthServer !== null)
        {
            healthServer.on(WorkerHost.RequestEvent, (req: IncomingMessage, res: ServerResponse) =>
            {
                const path = (req.url ?? '/').split('?')[0]!
                const result = this.health.Handle(req.method ?? '', path, this.ready && this.registry.OwnershipHealthy())
                if (result === null)
                {
                    res.writeHead(WorkerHost.NotFoundStatus)
                    res.end()
                    return
                }
                res.writeHead(result.status, { [WorkerHost.ContentTypeHeader]: WorkerHost.TextPlain })
                res.end(result.body)
            })
        }
    }

    public MarkReady(): void
    {
        this.ready = true
    }

    public HealthAddressForTest(): WebSocketAddress
    {
        if (this.healthAddress === null)
        {
            throw new Error(WorkerHost.NoHealthServer)
        }
        return this.healthAddress
    }

    public static async StartAsync(options: WorkerHostOptions): Promise<WorkerHost>
    {
        const coordinator = new InMemoryTenantCoordinator()
        const hasRedis = options.redisUrl !== undefined && options.redisUrl.length > 0
        const ownership: ITenantOwnership = hasRedis
            ? new RedisTenantOwnership(options.redisUrl!, options.replicaId ?? randomUUID())
            : new InMemoryTenantOwnership()
        await ownership.Start().catch(() => {})
        const registry = new TenantRegistry(options.baseDir, options.masterKey, options.provisioning, coordinator, options.platform, options.deploymentMode, ownership, options.provisionedSecrets)
        const host = options.host ?? WorkerHost.DefaultHost
        const httpsServer = createServer(MachineTls.Server(options.tls))
        const wss = new WebSocketServer({ noServer: true })
        await new Promise<void>((resolve, reject) =>
        {
            httpsServer.once(WorkerHost.ListeningEvent, () => resolve())
            httpsServer.once(WorkerHost.ErrorEvent, reject)
            httpsServer.listen(options.port, host)
        })
        const resolved = httpsServer.address() as AddressInfo
        let healthServer: PlainHttpServer | null = null
        let healthAddress: WebSocketAddress | null = null
        let registration: WorkerRegistration | null = null
        try
        {
            if (options.healthPort !== undefined)
            {
                healthServer = createHttpServer()
                await new Promise<void>((resolve, reject) =>
                {
                    healthServer!.once(WorkerHost.ListeningEvent, () => resolve())
                    healthServer!.once(WorkerHost.ErrorEvent, reject)
                    healthServer!.listen(options.healthPort, WorkerHost.DefaultHealthHost)
                })
                const healthInfo = healthServer.address() as AddressInfo
                healthAddress = { host: WorkerHost.DefaultHealthHost, port: healthInfo.port }
            }
            registration = hasRedis && options.advertise !== undefined ? new WorkerRegistration(options.redisUrl!, options.advertise) : null
            if (registration !== null)
            {
                await registration.Start().catch(() => {})
            }
        }
        catch (error)
        {
            await new Promise<void>(resolve => wss.close(() => resolve()))
            await new Promise<void>(resolve => httpsServer.close(() => resolve()))
            await registry.DisposeAll().catch(() => {})
            throw error
        }
        const started = new WorkerHost(httpsServer, wss, registry, { host, port: resolved.port }, options.idleTtlMs ?? WorkerHost.DefaultIdleTtlMs, options.idleSweepMs ?? WorkerHost.DefaultIdleSweepMs, healthServer, healthAddress, registration)
        started.MarkReady()
        return started
    }

    public Address(): WebSocketAddress
    {
        return this.address
    }

    public RegistryForTest(): TenantRegistry
    {
        return this.registry
    }

    public async DisposeAsync(): Promise<void>
    {
        this.ready = false
        this.disposed = true
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
        await new Promise<void>(resolve => this.httpsServer.close(() => resolve()))
        await this.registration?.Drain().catch(() => {})
        if (this.healthServer !== null)
        {
            await new Promise<void>(resolve => this.healthServer!.close(() => resolve()))
        }
        await this.registry.DisposeAll()
    }

    private async Upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void>
    {
        const tenantId = this.TenantHint(req)
        if (tenantId === null)
        {
            socket.destroy()
            return
        }
        let server: PragmaticServer
        try
        {
            server = await this.registry.ServerFor(tenantId)
        }
        catch (error)
        {
            if (error instanceof TenantOwnedElsewhereError && !socket.writableEnded && !socket.destroyed)
            {
                socket.write(WorkerHost.ServiceUnavailableResponse)
            }
            socket.destroy()
            return
        }
        this.registry.Acquire(tenantId)
        // ws.handleUpgrade invokes its callback synchronously (no verifyClient configured), so `attached` is set before the finally runs — mirrors the 5A PragmaticServerHost lifecycle.
        let attached = false
        try
        {
            const context = await this.AuthenticateAgainst(req, server)
            if (context === null)
            {
                socket.destroy()
                return
            }
            const languageService = await server.LanguageService()
            const manager = await server.Manager()
            this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) =>
            {
                try
                {
                    const handler = ServerConnectionHandler.Attach(new WsMessageSocket(ws), languageService, manager, context, () => server.Connectors())
                    this.handlers.add(handler)
                    ws.on(WorkerHost.CloseEvent, () =>
                    {
                        if (this.disposed)
                        {
                            return
                        }
                        handler.Dispose()
                        this.handlers.delete(handler)
                        this.registry.Release(tenantId)
                    })
                    attached = true
                }
                catch
                {
                    ws.terminate()
                }
            })
        }
        catch
        {
            socket.destroy()
        }
        finally
        {
            if (!attached)
            {
                this.registry.Release(tenantId)
            }
        }
    }

    private async AuthenticateAgainst(req: IncomingMessage, server: PragmaticServer): Promise<AccessContext | null>
    {
        const header = req.headers[WorkerHost.AuthorizationHeader]
        if (typeof header !== 'string' || !header.startsWith(WorkerHost.BearerPrefix))
        {
            return null
        }
        const token = header.slice(WorkerHost.BearerPrefix.length)
        if (token.length === 0)
        {
            return null
        }
        return this.authenticator.ResolveAsync(token, server.Tenant(), await server.Pack())
    }

    private async Request(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        try
        {
            const tenantId = this.TenantHint(req)
            if (tenantId === null)
            {
                res.writeHead(WorkerHost.NotFoundStatus)
                res.end()
                return
            }
            const server = await this.registry.ServerFor(tenantId)
            const pack = await server.Pack()
            const endpoint = new AuthHttpEndpoint(pack, server.Tenant(), server.Oidc(), this.MachineContext(req, pack))
            await endpoint.Handle(req, res)
        }
        catch
        {
            if (!res.headersSent && !res.writableEnded)
            {
                res.writeHead(WorkerHost.NotFoundStatus)
                res.end()
            }
        }
    }

    /** Trusts the gateway-forwarded fingerprint (the gateway strips client-supplied values; this listener only accepts mTLS peers). */
    private MachineContext(req: IncomingMessage, pack: ServerIdentityPack): MachineAuthContext | undefined
    {
        const socket = req.socket
        if (!(socket instanceof TLSSocket) || socket.authorized !== true)
        {
            return undefined
        }
        const header = req.headers[MachineFingerprintHeader]
        if (typeof header !== 'string' || header.length === 0)
        {
            return undefined
        }
        const authenticator = pack.AuthenticatorFor(AuthMethod.Machine)
        if (authenticator === undefined)
        {
            return undefined
        }
        return { authenticator, identity: MachineCertIdentity.FromPeerCertificate(true, { fingerprint256: header }) }
    }

    private TenantHint(req: IncomingMessage): string | null
    {
        const header = req.headers[WorkerHost.TenantHeader]
        return typeof header === 'string' && header.length > 0 ? header : null
    }
}
