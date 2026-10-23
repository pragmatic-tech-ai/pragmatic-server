import { createServer } from 'node:https'
import { AppServingEndpoint } from '../host/apps/app-serving-endpoint.js'
import type { Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import type { Server as PlainHttpServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { WsMessageSocket, HeartbeatMonitor, BackpressurePolicy, TransportCloseCode } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { PragmaticServer } from '../pragmatic-server.js'
import { ServerConnectionHandler } from '../host/server-connection-handler.js'
import { AdminService } from '../host/admin-service.js'
import { RateLimitGuard } from '../host/rate-limit-guard.js'
import { RateLimitScope } from '../host/rate-limiter.js'
import { AuditSurface, NullAccessAuditSink } from '../host/access-audit.js'
import type { IAccessAuditSink } from '../host/access-audit.js'
import { BrowserSessionAuth } from '../host/browser-session-auth.js'
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
import type { CypherLimits } from '../config/cypher-limits.js'
import type { PagingLimits } from '../config/paging-limits.js'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'
import type { AdapterPacksConfig, WsResilienceConfig } from '../config/server-config.js'
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
import { NullLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'
import { RequestInstrumentation } from '../observability/request-instrumentation.js'
import type { Observability } from '../observability/observability.js'
import { RequestCorrelation } from '../observability/request-correlation.js'
import { DrainController } from '../observability/drain-controller.js'
import { WsInFlightSource } from '../observability/ws-in-flight-source.js'
import type { IInFlightSource } from '../observability/drain-controller.js'

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
    adapterPacks?: AdapterPacksConfig
    healthPort?: number
    advertise?: WorkerEndpoint
    logger?: ILogger
    observability?: Observability
    rateLimit?: RateLimitGuard
    audit?: IAccessAuditSink
    drainTimeoutMs?: number
    cypherLimits?: CypherLimits
    paging?: PagingLimits
    wsResilience?: WsResilienceConfig
    /** Extra browser Origins (beyond same-origin) allowed to use the session cookie. */
    allowedOrigins?: readonly string[]
}

/** Internal mutual-TLS wss worker: the gateway (a verified client cert) forwards x-pragmatic-environment + authorization;
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
    private static readonly TenantHeader = 'x-pragmatic-environment'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ServiceUnavailableResponse = 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n'
    private static readonly BaseUrl = 'http://localhost'
    private static readonly NotFoundStatus = 404
    private static readonly UnauthorizedStatus = 401
    private static readonly DefaultHealthHost = '0.0.0.0'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly TextPlain = 'text/plain'
    private static readonly NoHealthServer = 'no health server configured'
    private static readonly DefaultIdleTtlMs = 300_000
    private static readonly DefaultIdleSweepMs = 30_000
    private static readonly DrainBeginEvent = 'drain-begin'
    private static readonly DrainCompleteEvent = 'drain-complete'
    private static readonly DrainFailedEvent = 'drain-failed'
    private static readonly EventKey = 'event'
    private static readonly ShedLine = 'ws shed'
    private static readonly ShedEvent = 'ws-shed'
    private static readonly InFlightField = 'inFlight'
    private static readonly RemainingField = 'remaining'
    private static readonly ElapsedField = 'elapsedMs'
    private static readonly DrainedField = 'drained'
    private static readonly StepField = 'step'
    private static readonly DrainBeginLine = 'drain begin'
    private static readonly DrainCompleteLine = 'drain complete'
    private static readonly DrainFailedLine = 'drain step failed'
    private static readonly StepReadiness = 'readiness-close'
    private static readonly StepWait = 'in-flight-wait'
    private static readonly StepHandlers = 'dispose-handlers'
    private static readonly DefaultWsResilience: WsResilienceConfig = { heartbeatIntervalMs: 30000, readIdleMs: 60000, backpressureSoftBytes: 1048576, backpressureHardBytes: 8388608, backpressureGraceMs: 5000, maxInboundBytes: 16777216 }
    private static readonly StepHeartbeat = 'heartbeat-stop'
    private static readonly StepTerminate = 'terminate-clients'
    private static readonly StepWss = 'close-wss'
    private static readonly StepHttps = 'close-https'
    private static readonly StepRegistration = 'registration-drain'
    private static readonly StepHealth = 'close-health'
    private static readonly StepObservability = 'observability-shutdown'
    private static readonly StepRegistry = 'registry-dispose'
    private static readonly DefaultDrainTimeoutMs = 0

    private readonly httpsServer: HttpsServer
    private readonly wss: WebSocketServer
    private readonly registry: TenantRegistry
    private readonly authenticator: ConnectionAuthenticator
    private readonly browserAuth: BrowserSessionAuth
    private readonly audit: IAccessAuditSink
    private readonly handlers = new Set<ServerConnectionHandler>()
    private readonly address: WebSocketAddress
    private readonly idleTtlMs: number
    private readonly sweep: NodeJS.Timeout
    private readonly health = new HealthEndpoint()
    private readonly healthServer: PlainHttpServer | null
    private readonly healthAddress: WebSocketAddress | null
    private readonly registration: WorkerRegistration | null
    private readonly logger: ILogger
    private readonly instrumentation: RequestInstrumentation | undefined
    private readonly rateLimit: RateLimitGuard
    private readonly observability: Observability | undefined
    private readonly drainTimeoutMs: number
    private readonly cypherLimits: CypherLimits | undefined
    private readonly paging: PagingLimits | undefined
    private readonly wsResilience: WsResilienceConfig
    private readonly heartbeat: HeartbeatMonitor
    private drainSource: IInFlightSource | undefined
    private drainController: DrainController | undefined
    private disposing: Promise<void> | undefined
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
        registration: WorkerRegistration | null,
        logger: ILogger,
        instrumentation?: RequestInstrumentation,
        rateLimit: RateLimitGuard = new RateLimitGuard(),
        audit: IAccessAuditSink = new NullAccessAuditSink(),
        observability?: Observability,
        drainTimeoutMs: number = WorkerHost.DefaultDrainTimeoutMs,
        cypherLimits?: CypherLimits,
        wsResilience: WsResilienceConfig = WorkerHost.DefaultWsResilience,
        paging?: PagingLimits,
        browserAuth: BrowserSessionAuth = new BrowserSessionAuth([], true))
    {
        this.browserAuth = browserAuth
        this.cypherLimits = cypherLimits
        this.paging = paging
        this.wsResilience = wsResilience
        this.heartbeat = new HeartbeatMonitor(wsResilience.heartbeatIntervalMs)
        this.heartbeat.Start()
        this.observability = observability
        this.drainTimeoutMs = drainTimeoutMs
        this.audit = audit
        this.authenticator = new ConnectionAuthenticator(undefined, audit)
        this.rateLimit = rateLimit
        this.logger = logger
        this.instrumentation = instrumentation
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

    /** Test seam: override the in-flight source the drain waits on (default: the request instrumentation). */
    public SetDrainSourceForTest(source: IInFlightSource): void
    {
        this.drainSource = source
    }

    /** Test seam: inject the drain controller (clock/sleep) so the bounded wait is deterministic. */
    public SetDrainControllerForTest(controller: DrainController): void
    {
        this.drainController = controller
    }

    public HeartbeatCountForTest(): number
    {
        return this.heartbeat.WatchedCountForTest()
    }

    public HandlerCountForTest(): number
    {
        return this.handlers.size
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
        const registry = new TenantRegistry(options.baseDir, options.masterKey, options.provisioning, coordinator, options.platform, options.deploymentMode, ownership, options.provisionedSecrets, undefined, options.adapterPacks)
        const host = options.host ?? WorkerHost.DefaultHost
        const httpsServer = createServer(MachineTls.Server(options.tls))
        const resilience = options.wsResilience ?? WorkerHost.DefaultWsResilience
        const wss = new WebSocketServer({ noServer: true, maxPayload: resilience.maxInboundBytes })
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
        const started = new WorkerHost(httpsServer, wss, registry, { host, port: resolved.port }, options.idleTtlMs ?? WorkerHost.DefaultIdleTtlMs, options.idleSweepMs ?? WorkerHost.DefaultIdleSweepMs, healthServer, healthAddress, registration, options.logger ?? new NullLogger(), options.observability !== undefined ? RequestInstrumentation.FromObservability(options.observability, options.logger ?? new NullLogger()) : undefined, options.rateLimit, options.audit, options.observability, options.drainTimeoutMs ?? WorkerHost.DefaultDrainTimeoutMs, options.cypherLimits, resilience, options.paging, new BrowserSessionAuth(options.allowedOrigins ?? [], true))
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

    public DisposeAsync(): Promise<void>
    {
        this.disposing ??= this.DoDispose()
        return this.disposing
    }

    private async DoDispose(): Promise<void>
    {
        this.ready = false
        this.disposed = true
        await this.Step(WorkerHost.StepReadiness, () =>
        {
            clearInterval(this.sweep)
            this.httpsServer.closeIdleConnections()
        })
        const drained = await this.Drain()
        await this.Step(WorkerHost.StepHandlers, () =>
        {
            for (const handler of this.handlers)
            {
                handler.Dispose()
            }
            this.handlers.clear()
        })
        await this.Step(WorkerHost.StepHeartbeat, () => this.heartbeat.Stop())
        await this.Step(WorkerHost.StepTerminate, () =>
        {
            for (const client of this.wss.clients)
            {
                if (drained)
                {
                    client.close(TransportCloseCode.GoingAway)
                }
                else
                {
                    client.terminate()
                }
            }
        })
        await this.Step(WorkerHost.StepWss, () => new Promise<void>(resolve => this.wss.close(() => resolve())))
        await this.Step(WorkerHost.StepHttps, () =>
        {
            const closed = new Promise<void>(resolve => this.httpsServer.close(() => resolve()))
            this.httpsServer.closeIdleConnections()
            if (!drained)
            {
                this.httpsServer.closeAllConnections()
            }
            return closed
        })
        await this.Step(WorkerHost.StepRegistration, async () =>
        {
            await this.registration?.Drain()
        })
        await this.Step(WorkerHost.StepHealth, () =>
        {
            const health = this.healthServer
            if (health === null)
            {
                return
            }
            health.closeIdleConnections()
            return new Promise<void>(resolve => health.close(() => resolve()))
        })
        await this.Step(WorkerHost.StepObservability, async () =>
        {
            await this.observability?.Shutdown()
        })
        await this.Step(WorkerHost.StepRegistry, () => this.registry.DisposeAll())
    }

    /** Runs one teardown step; a throw is logged (step name only, no secrets) and never skips the remaining steps. */
    private async Step(name: string, action: () => void | Promise<void>): Promise<void>
    {
        try
        {
            await action()
        }
        catch
        {
            this.logger.Warn(WorkerHost.DrainFailedLine, { [WorkerHost.EventKey]: WorkerHost.DrainFailedEvent, [WorkerHost.StepField]: name })
        }
    }

    /** Degrade-safe in-flight read for the begin log: a throwing source counts as zero, matching DrainController. */
    private CountOf(source: IInFlightSource): number
    {
        try
        {
            return source.InFlight()
        }
        catch
        {
            return 0
        }
    }

    /** Bounded wait for in-flight work; returns whether it fully drained. A failure is logged and never blocks teardown. */
    private async Drain(): Promise<boolean>
    {
        try
        {
            // Wait for in-flight ws RPC (and HTTP) to settle; on drain we close ws with GoingAway, on timeout we force-terminate.
            for (const handler of this.handlers)
            {
                handler.BeginDrain()
            }
            const source = this.drainSource ?? new WsInFlightSource(this.handlers, this.instrumentation)
            this.logger.Info(WorkerHost.DrainBeginLine, { [WorkerHost.EventKey]: WorkerHost.DrainBeginEvent, [WorkerHost.InFlightField]: this.CountOf(source) })
            const controller = this.drainController ?? new DrainController(this.drainTimeoutMs)
            const outcome = await controller.WaitForDrain(source)
            this.logger.Info(WorkerHost.DrainCompleteLine, { [WorkerHost.EventKey]: WorkerHost.DrainCompleteEvent, [WorkerHost.DrainedField]: outcome.Drained, [WorkerHost.RemainingField]: outcome.Remaining, [WorkerHost.ElapsedField]: outcome.ElapsedMs })
            return outcome.Drained
        }
        catch
        {
            this.logger.Warn(WorkerHost.DrainFailedLine, { [WorkerHost.EventKey]: WorkerHost.DrainFailedEvent, [WorkerHost.StepField]: WorkerHost.StepWait })
            return false
        }
    }

    private RejectRetryable(socket: Socket): void
    {
        if (!socket.writableEnded && !socket.destroyed)
        {
            socket.write(WorkerHost.ServiceUnavailableResponse)
        }
        socket.destroy()
    }

    private RejectRateLimited(socket: Socket, retryAfterMs: number): void
    {
        if (!socket.writableEnded && !socket.destroyed)
        {
            socket.write(RateLimitGuard.TooManyRequestsResponse(retryAfterMs))
        }
        socket.destroy()
    }

    private async Upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void>
    {
        if (this.disposed)
        {
            this.RejectRetryable(socket)
            return
        }
        const environmentId = this.TenantHint(req)
        if (environmentId === null)
        {
            socket.destroy()
            return
        }
        const limit = this.rateLimit.Check(
            { scope: RateLimitScope.Tenant, tenant: environmentId, key: environmentId },
            { surface: AuditSurface.Upgrade, tenant: environmentId, methodOrPath: RateLimitGuard.UpgradeMethodName() })
        if (!limit.Allowed)
        {
            this.RejectRateLimited(socket, limit.RetryAfterMs)
            return
        }
        let server: PragmaticServer
        try
        {
            server = await this.registry.ServerFor(environmentId)
        }
        catch (error)
        {
            if (error instanceof TenantOwnedElsewhereError)
            {
                this.RejectRetryable(socket)
            }
            else
            {
                socket.destroy()
            }
            return
        }
        this.registry.Acquire(environmentId)
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
            const parent = this.instrumentation !== undefined ? RequestCorrelation.Extract(req.headers) : undefined
            const languageService = await server.LanguageService()
            const manager = await server.Manager()
            const fieldMasks = await server.FieldReadMaskSource()
            const pack = await server.Pack()
            const admin = new AdminService(pack.Grants, pack.Audit, await server.TenantConfigStore(), server.Tenant(), () => this.registry.DisposeTenant(environmentId), pack.Accounts, pack.Registrar, pack.Tokens, {
                Invalidate: name => server.InvalidateAdapterPack(name),
                AllowScripts: name => server.AllowAdapterPackScripts(name),
                DenyScripts: name => server.DenyAdapterPackScripts(name),
                ListScriptAllowlist: () => server.ListAdapterPackScripts(),
            }, await server.SecurityModelReload())
            if (this.disposed)
            {
                this.RejectRetryable(socket)
                return
            }
            this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) =>
            {
                try
                {
                    const runtime = ServerConnectionHandler.RuntimeAttachArgs(server)
                    const resilience = this.wsResilience
                    const socket = new WsMessageSocket(ws, {
                        policy: new BackpressurePolicy(resilience.backpressureSoftBytes, resilience.backpressureHardBytes, resilience.backpressureGraceMs),
                        onShed: () => this.logger.Info(WorkerHost.ShedLine, { [WorkerHost.EventKey]: WorkerHost.ShedEvent }),
                    })
                    const handler = ServerConnectionHandler.Attach(socket, languageService, manager, context, () => server.Connectors(), ctx => server.Graph(ctx), this.instrumentation, parent, this.audit, this.rateLimit, admin, this.cypherLimits, server.Purpose(), runtime.applications, runtime.appGraphProvider, runtime.appWriteProvider, runtime.shareProvider, runtime.unshareProvider, runtime.listSharesProvider, runtime.assignProvider, this.paging, fieldMasks, ctx => server.ConnectorReadAuthorizationFor(ctx), (ctx, target) => server.ConnectorWriteAuthorizationFor(ctx, target), (ctx, id) => server.ModelGraph(ctx, id), (ctx, id, request) => server.ExecuteCypher(ctx, id, request), runtime.deployProvider)
                    this.handlers.add(handler)
                    this.heartbeat.Watch(ws)
                    ws.on(WorkerHost.CloseEvent, () =>
                    {
                        if (this.disposed)
                        {
                            return
                        }
                        handler.Dispose()
                        this.handlers.delete(handler)
                        this.registry.Release(environmentId)
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
                this.registry.Release(environmentId)
            }
        }
    }

    private async AuthenticateAgainst(req: IncomingMessage, server: PragmaticServer): Promise<AccessContext | null>
    {
        const header = req.headers[WorkerHost.AuthorizationHeader]
        if (header === undefined)
        {
            const credential = this.browserAuth.Credential(req, true)
            if (credential === null || credential.Tenant !== server.Tenant().Id)
            {
                return null
            }
            return this.authenticator.ResolveAsync(credential.Token, server.Tenant(), await server.Pack())
        }
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
            const path = new URL(req.url ?? '/', WorkerHost.BaseUrl).pathname
            if (AppServingEndpoint.Matches(path))
            {
                await new AppServingEndpoint(this.registry).Handle(req, res)
                return
            }
            const environmentId = this.TenantHint(req)
            if (environmentId === null)
            {
                res.writeHead(BrowserSessionAuth.IsSessionPath(path) ? WorkerHost.UnauthorizedStatus : WorkerHost.NotFoundStatus)
                res.end()
                return
            }
            const server = await this.registry.ServerFor(environmentId)
            const pack = await server.Pack()
            const endpoint = new AuthHttpEndpoint(pack, server.Tenant(), server.Oidc(), this.MachineContext(req, pack), this.instrumentation, this.audit, this.browserAuth)
            await endpoint.Handle(req, res)
        }
        catch
        {
            if (!res.headersSent && !res.writableEnded)
            {
                res.writeHead(this.IsSessionRequest(req) ? WorkerHost.UnauthorizedStatus : WorkerHost.NotFoundStatus)
                res.end()
            }
        }
    }

    private IsSessionRequest(req: IncomingMessage): boolean
    {
        return BrowserSessionAuth.IsSessionPath(new URL(req.url ?? '/', WorkerHost.BaseUrl).pathname)
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

    // Cluster cookie path (deferred beyond SP0): this assumes the mTLS gateway STRIPS any client-supplied `Cookie`
    // and `Origin` headers on the forwarded leg; the full cluster-cookie story is out of SP0 scope.
    private TenantHint(req: IncomingMessage): string | null
    {
        const header = req.headers[WorkerHost.TenantHeader]
        return typeof header === 'string' && header.length > 0 ? header : this.browserAuth.CookieTenant(req.headers)
    }
}
