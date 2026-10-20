import { randomUUID } from 'node:crypto'
import { AppServingEndpoint } from './apps/app-serving-endpoint.js'
import { createServer } from 'node:http'
import { createServer as httpsCreateServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import type { TLSSocket } from 'node:tls'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { WsMessageSocket, HeartbeatMonitor, BackpressurePolicy, TransportCloseCode } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AuthMethod } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, Tenant } from '@pragmatic-tech-ai/todl-identity'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { MachineTls } from '../cluster/machine-tls.js'
import type { MachineTlsRef } from '../cluster/machine-tls.js'
import { MachineCertIdentity } from './machine-principal-map.js'
import type { MachineAuthContext } from './auth-http-endpoint.js'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { CypherLimits } from '../config/cypher-limits.js'
import type { PagingLimits } from '../config/paging-limits.js'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'
import type { AdapterPacksConfig, WsResilienceConfig } from '../config/server-config.js'
import type { PragmaticServer } from '../pragmatic-server.js'
import { ServerConnectionHandler } from './server-connection-handler.js'
import { AdminService } from './admin-service.js'
import { RateLimitGuard } from './rate-limit-guard.js'
import { RateLimitScope } from './rate-limiter.js'
import { AuditSurface, NullAccessAuditSink } from './access-audit.js'
import type { IAccessAuditSink } from './access-audit.js'
import { BrowserSessionAuth } from './browser-session-auth.js'
import { ConnectionAuthenticator } from './connection-authenticator.js'
import { AuthHttpEndpoint } from './auth-http-endpoint.js'
import { HealthEndpoint } from './health-endpoint.js'
import { InMemoryTenantCoordinator } from '../tenancy/tenant-coordinator.js'
import { TenantRegistry } from '../tenancy/tenant-registry.js'
import { InMemoryTenantOwnership, TenantOwnedElsewhereError } from '../tenancy/tenant-ownership.js'
import { RedisTenantOwnership } from '../tenancy/redis-tenant-ownership.js'
import { FetchHttpClient, InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'
import { RedisOidcFlowStateStore } from '../identity/redis-oidc-flow-state-store.js'
import { ClusterKeys } from '../cluster/cluster-keys.js'
import type { IdentityRuntime } from '../identity/identity-runtime.js'
import type { ITenantProvisioning } from '../tenancy/tenant-provisioning.js'
import type { PlatformServices } from '../platform/platform-services.js'
import type { DeploymentMode } from '../platform/deployment-mode.js'
import { NullLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'
import { RequestInstrumentation } from '../observability/request-instrumentation.js'
import type { Observability } from '../observability/observability.js'
import { DrainController } from '../observability/drain-controller.js'
import { WsInFlightSource } from '../observability/ws-in-flight-source.js'
import type { IInFlightSource } from '../observability/drain-controller.js'
import { RequestCorrelation } from '../observability/request-correlation.js'

export interface PragmaticServerHostOptions
{
    host?: string
    port: number
    baseDir: string
    masterKey: MasterKeyRef
    provisioning: ITenantProvisioning
    idleTtlMs?: number
    idleSweepMs?: number
    platform?: PlatformServices
    deploymentMode?: DeploymentMode
    redisUrl?: string
    replicaId?: string
    provisionedSecrets?: IProvisionedSecretSource
    adapterPacks?: AdapterPacksConfig
    clientTls?: MachineTlsRef
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

export interface WebSocketAddress
{
    host: string
    port: number
}

/** Stateless multi-tenant front door: the ?tenant hint selects a tenant's pack, the bearer authenticated against that pack binds the tenant,
 *  each tenant is isolated in its own PragmaticServer, and idle tenants are evicted by the registry sweep. */
export class PragmaticServerHost
{
    private static readonly DefaultHost = '127.0.0.1'
    private static readonly FlowKeySeparator = ':'
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
    private static readonly ServiceUnavailableResponse = 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n'
    private static readonly NotFoundStatus = 404
    private static readonly UnauthorizedStatus = 401
    private static readonly ServiceUnavailableStatus = 503
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly RetryAfterSeconds = '1'
    private static readonly DefaultIdleTtlMs = 300_000
    private static readonly DefaultIdleSweepMs = 30_000
    private static readonly DrainBeginEvent = 'drain-begin'
    private static readonly DrainCompleteEvent = 'drain-complete'
    private static readonly EventKey = 'event'
    private static readonly ShedLine = 'ws shed'
    private static readonly ShedEvent = 'ws-shed'
    private static readonly InFlightField = 'inFlight'
    private static readonly RemainingField = 'remaining'
    private static readonly ElapsedField = 'elapsedMs'
    private static readonly DrainedField = 'drained'
    private static readonly DrainBeginLine = 'drain begin'
    private static readonly DrainCompleteLine = 'drain complete'
    private static readonly DrainFailedLine = 'drain step failed'
    private static readonly DrainFailedEvent = 'drain-failed'
    private static readonly StepField = 'step'
    private static readonly StepReadiness = 'readiness-close'
    private static readonly StepHandlers = 'dispose-handlers'
    private static readonly DefaultWsResilience: WsResilienceConfig = { heartbeatIntervalMs: 30000, readIdleMs: 60000, backpressureSoftBytes: 1048576, backpressureHardBytes: 8388608, backpressureGraceMs: 5000, maxInboundBytes: 16777216 }
    private static readonly StepHeartbeat = 'heartbeat-stop'
    private static readonly StepTerminate = 'terminate-clients'
    private static readonly StepWss = 'close-wss'
    private static readonly StepHttp = 'close-http'
    private static readonly StepObservability = 'observability-shutdown'
    private static readonly StepRegistry = 'registry-dispose'
    private static readonly StepWait = 'in-flight-wait'
    private static readonly DefaultDrainTimeoutMs = 0

    private readonly httpServer: HttpServer | HttpsServer
    private readonly wss: WebSocketServer
    private readonly registry: TenantRegistry
    private readonly authenticator: ConnectionAuthenticator
    private readonly browserAuth: BrowserSessionAuth
    private readonly audit: IAccessAuditSink
    private readonly handlers = new Set<ServerConnectionHandler>()
    private readonly address: WebSocketAddress
    private readonly idleTtlMs: number
    private readonly clientTls: boolean
    private readonly logger: ILogger
    private readonly instrumentation: RequestInstrumentation | undefined
    private readonly rateLimit: RateLimitGuard
    private readonly sweep: NodeJS.Timeout
    private readonly health = new HealthEndpoint()
    private ready = false
    private disposed = false
    private readonly observability: Observability | undefined
    private readonly drainTimeoutMs: number
    private readonly cypherLimits: CypherLimits | undefined
    private readonly paging: PagingLimits | undefined
    private readonly wsResilience: WsResilienceConfig
    private readonly heartbeat: HeartbeatMonitor
    private drainSource: IInFlightSource | undefined
    private disposing: Promise<void> | undefined
    private drainController: DrainController | undefined

    private constructor(
        httpServer: HttpServer | HttpsServer,
        wss: WebSocketServer,
        registry: TenantRegistry,
        address: WebSocketAddress,
        idleTtlMs: number,
        idleSweepMs: number,
        clientTls: boolean,
        logger: ILogger,
        instrumentation?: RequestInstrumentation,
        rateLimit: RateLimitGuard = new RateLimitGuard(),
        audit: IAccessAuditSink = new NullAccessAuditSink(),
        observability?: Observability,
        drainTimeoutMs: number = PragmaticServerHost.DefaultDrainTimeoutMs,
        cypherLimits?: CypherLimits,
        wsResilience: WsResilienceConfig = PragmaticServerHost.DefaultWsResilience,
        paging?: PagingLimits,
        browserAuth: BrowserSessionAuth = new BrowserSessionAuth([], false))
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
        this.httpServer = httpServer
        this.wss = wss
        this.registry = registry
        this.address = address
        this.idleTtlMs = idleTtlMs
        this.clientTls = clientTls
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

    private static BuildIdentityRuntime(redisUrl: string | undefined): IdentityRuntime
    {
        const url = redisUrl !== undefined && redisUrl.length > 0 ? redisUrl : undefined
        return {
            HttpClient: new FetchHttpClient(),
            FlowStateFor: tenantId => url === undefined
                ? new InMemoryOidcFlowStateStore()
                : new RedisOidcFlowStateStore(url, ClusterKeys.OidcFlowPrefix + tenantId + PragmaticServerHost.FlowKeySeparator),
        }
    }

    public static async StartAsync(options: PragmaticServerHostOptions): Promise<PragmaticServerHost>
    {
        const coordinator = new InMemoryTenantCoordinator()
        const ownership = options.redisUrl !== undefined && options.redisUrl.length > 0
            ? new RedisTenantOwnership(options.redisUrl, options.replicaId ?? randomUUID())
            : new InMemoryTenantOwnership()
        await ownership.Start().catch(() => {})
        const registry = new TenantRegistry(options.baseDir, options.masterKey, options.provisioning, coordinator, options.platform, options.deploymentMode, ownership, options.provisionedSecrets, PragmaticServerHost.BuildIdentityRuntime(options.redisUrl), options.adapterPacks)
        const host = options.host ?? PragmaticServerHost.DefaultHost
        const httpServer = options.clientTls === undefined ? createServer() : httpsCreateServer(MachineTls.OptionalServer(options.clientTls))
        const resilience = options.wsResilience ?? PragmaticServerHost.DefaultWsResilience
        const wss = new WebSocketServer({ noServer: true, maxPayload: resilience.maxInboundBytes })
        await new Promise<void>((resolve, reject) =>
        {
            httpServer.once(PragmaticServerHost.ListeningEvent, () => resolve())
            httpServer.once(PragmaticServerHost.ErrorEvent, reject)
            httpServer.listen(options.port, host)
        })
        const resolved = httpServer.address() as AddressInfo
        const started = new PragmaticServerHost(httpServer, wss, registry, { host, port: resolved.port }, options.idleTtlMs ?? PragmaticServerHost.DefaultIdleTtlMs, options.idleSweepMs ?? PragmaticServerHost.DefaultIdleSweepMs, options.clientTls !== undefined, options.logger ?? new NullLogger(), options.observability !== undefined ? RequestInstrumentation.FromObservability(options.observability, options.logger ?? new NullLogger()) : undefined, options.rateLimit, options.audit, options.observability, options.drainTimeoutMs ?? PragmaticServerHost.DefaultDrainTimeoutMs, options.cypherLimits, resilience, options.paging, new BrowserSessionAuth(options.allowedOrigins ?? [], false))
        started.MarkReady()
        return started
    }

    /** Flips readiness on; called once StartAsync has finished so /readyz never reports a half-started host. */
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

    public HeartbeatCountForTest(): number
    {
        return this.heartbeat.WatchedCountForTest()
    }

    /** Test seam: number of live authenticated connections. */
    public HandlerCountForTest(): number
    {
        return this.handlers.size
    }

    /** Idempotent and safe to await concurrently: every caller awaits the same shared completion. */
    public DisposeAsync(): Promise<void>
    {
        this.disposing ??= this.DoDispose()
        return this.disposing
    }

    private async DoDispose(): Promise<void>
    {
        this.ready = false
        this.disposed = true
        await this.Step(PragmaticServerHost.StepReadiness, () =>
        {
            clearInterval(this.sweep)
            this.httpServer.closeIdleConnections()
        })
        const drained = await this.Drain()
        await this.Step(PragmaticServerHost.StepHandlers, () =>
        {
            for (const handler of this.handlers)
            {
                handler.Dispose()
            }
            this.handlers.clear()
        })
        await this.Step(PragmaticServerHost.StepHeartbeat, () => this.heartbeat.Stop())
        await this.Step(PragmaticServerHost.StepTerminate, () =>
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
        await this.Step(PragmaticServerHost.StepWss, () => new Promise<void>(resolve => this.wss.close(() => resolve())))
        await this.Step(PragmaticServerHost.StepHttp, () =>
        {
            const closed = new Promise<void>(resolve => this.httpServer.close(() => resolve()))
            this.httpServer.closeIdleConnections()
            if (!drained)
            {
                this.httpServer.closeAllConnections()
            }
            return closed
        })
        await this.Step(PragmaticServerHost.StepObservability, async () =>
        {
            await this.observability?.Shutdown()
        })
        await this.Step(PragmaticServerHost.StepRegistry, () => this.registry.DisposeAll())
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
            this.logger.Warn(PragmaticServerHost.DrainFailedLine, { [PragmaticServerHost.EventKey]: PragmaticServerHost.DrainFailedEvent, [PragmaticServerHost.StepField]: name })
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
            this.logger.Info(PragmaticServerHost.DrainBeginLine, { [PragmaticServerHost.EventKey]: PragmaticServerHost.DrainBeginEvent, [PragmaticServerHost.InFlightField]: this.CountOf(source) })
            const controller = this.drainController ?? new DrainController(this.drainTimeoutMs)
            const outcome = await controller.WaitForDrain(source)
            this.logger.Info(PragmaticServerHost.DrainCompleteLine, { [PragmaticServerHost.EventKey]: PragmaticServerHost.DrainCompleteEvent, [PragmaticServerHost.DrainedField]: outcome.Drained, [PragmaticServerHost.RemainingField]: outcome.Remaining, [PragmaticServerHost.ElapsedField]: outcome.ElapsedMs })
            return outcome.Drained
        }
        catch
        {
            this.logger.Warn(PragmaticServerHost.DrainFailedLine, { [PragmaticServerHost.EventKey]: PragmaticServerHost.DrainFailedEvent, [PragmaticServerHost.StepField]: PragmaticServerHost.StepWait })
            return false
        }
    }

    private async Upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void>
    {
        if (this.disposed)
        {
            this.RejectRetryable(socket)
            return
        }
        const tenantId = this.TenantHint(req)
        if (tenantId === null)
        {
            this.Reject(socket)
            return
        }
        const limit = this.rateLimit.Check(
            { scope: RateLimitScope.Tenant, tenant: tenantId, key: tenantId },
            { surface: AuditSurface.Upgrade, tenant: tenantId, methodOrPath: RateLimitGuard.UpgradeMethodName() })
        if (!limit.Allowed)
        {
            this.RejectRateLimited(socket, limit.RetryAfterMs)
            return
        }
        let server: PragmaticServer
        try
        {
            server = await this.registry.ServerFor(tenantId)
        }
        catch (error)
        {
            if (error instanceof TenantOwnedElsewhereError)
            {
                this.RejectRetryable(socket)
            }
            else
            {
                this.Reject(socket)
            }
            return
        }
        this.registry.Acquire(tenantId)
        let attached = false
        try
        {
            const context = await this.AuthenticateAgainst(req, server)
            if (context === null)
            {
                this.Reject(socket)
                return
            }
            const parent = this.instrumentation !== undefined ? RequestCorrelation.Extract(req.headers) : undefined
            const languageService = await server.LanguageService()
            const manager = await server.Manager()
            const fieldMasks = await server.FieldReadMaskSource()
            const pack = await server.Pack()
            const admin = new AdminService(pack.Grants, pack.Audit, await server.TenantConfigStore(), server.Tenant(), () => this.registry.DisposeTenant(tenantId), pack.Accounts, pack.Registrar, pack.Tokens, {
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
                    const development = ServerConnectionHandler.DevelopmentAttachArgs(server)
                    const resilience = this.wsResilience
                    const socket = new WsMessageSocket(ws, {
                        policy: new BackpressurePolicy(resilience.backpressureSoftBytes, resilience.backpressureHardBytes, resilience.backpressureGraceMs),
                        onShed: () => this.logger.Info(PragmaticServerHost.ShedLine, { [PragmaticServerHost.EventKey]: PragmaticServerHost.ShedEvent }),
                    })
                    const handler = ServerConnectionHandler.Attach(socket, languageService, manager, context, () => server.Connectors(), ctx => server.Graph(ctx), this.instrumentation, parent, this.audit, this.rateLimit, admin, this.cypherLimits, server.Purpose(), runtime.applications, runtime.appGraphProvider, runtime.appWriteProvider, runtime.shareProvider, runtime.unshareProvider, runtime.listSharesProvider, runtime.assignProvider, this.paging, fieldMasks, ctx => server.ConnectorReadAuthorizationFor(ctx), (ctx, target) => server.ConnectorWriteAuthorizationFor(ctx, target), (ctx, id) => server.ModelGraph(ctx, id), (ctx, id, request) => server.ExecuteCypher(ctx, id, request), runtime.deployProvider, development.devGraphService, runtime.environmentGraphHost)
                    this.handlers.add(handler)
                    this.heartbeat.Watch(ws)
                    ws.on(PragmaticServerHost.CloseEvent, () =>
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
            this.Reject(socket)
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
        const header = req.headers[PragmaticServerHost.AuthorizationHeader]
        if (header === undefined)
        {
            const credential = this.browserAuth.Credential(req, true)
            if (credential === null || credential.Tenant !== server.Tenant().Id)
            {
                return null
            }
            return this.authenticator.ResolveAsync(credential.Token, server.Tenant(), await server.Pack())
        }
        if (typeof header !== 'string' || !header.startsWith(PragmaticServerHost.BearerPrefix))
        {
            return null
        }
        const token = header.slice(PragmaticServerHost.BearerPrefix.length)
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
            const path = new URL(req.url ?? '/', PragmaticServerHost.BaseUrl).pathname
            const health = this.health.Handle(req.method ?? '', path, this.ready && this.registry.OwnershipHealthy())
            if (health !== null)
            {
                res.writeHead(health.status)
                res.end(health.body)
                return
            }
            if (this.disposed)
            {
                res.writeHead(PragmaticServerHost.ServiceUnavailableStatus, { [PragmaticServerHost.RetryAfterHeader]: PragmaticServerHost.RetryAfterSeconds })
                res.end()
                return
            }
            if (AppServingEndpoint.Matches(path))
            {
                await new AppServingEndpoint(this.registry).Handle(req, res)
                return
            }
            const tenantId = this.TenantHint(req)
            if (tenantId === null)
            {
                res.writeHead(BrowserSessionAuth.IsSessionPath(path) ? PragmaticServerHost.UnauthorizedStatus : PragmaticServerHost.NotFoundStatus)
                res.end()
                return
            }
            const server = await this.registry.ServerFor(tenantId)
            const pack = await server.Pack()
            const endpoint = new AuthHttpEndpoint(pack, server.Tenant(), server.Oidc(), this.MachineContext(req, pack), this.instrumentation, this.audit, this.browserAuth)
            await endpoint.Handle(req, res)
        }
        catch (error)
        {
            if (!res.headersSent && !res.writableEnded)
            {
                if (error instanceof TenantOwnedElsewhereError)
                {
                    res.writeHead(PragmaticServerHost.ServiceUnavailableStatus, { [PragmaticServerHost.RetryAfterHeader]: PragmaticServerHost.RetryAfterSeconds })
                    res.end()
                }
                else
                {
                    res.writeHead(this.IsSessionRequest(req) ? PragmaticServerHost.UnauthorizedStatus : PragmaticServerHost.NotFoundStatus)
                    res.end()
                }
            }
        }
    }

    private IsSessionRequest(req: IncomingMessage): boolean
    {
        return BrowserSessionAuth.IsSessionPath(new URL(req.url ?? '/', PragmaticServerHost.BaseUrl).pathname)
    }

    private MachineContext(req: IncomingMessage, pack: ServerIdentityPack): MachineAuthContext | undefined
    {
        if (!this.clientTls)
        {
            return undefined
        }
        const authenticator = pack.AuthenticatorFor(AuthMethod.Machine)
        if (authenticator === undefined)
        {
            return undefined
        }
        const socket = req.socket as TLSSocket
        return { authenticator, identity: MachineCertIdentity.FromPeerCertificate(socket.authorized === true, socket.getPeerCertificate()) }
    }

    private TenantHint(req: IncomingMessage): string | null
    {
        const url = new URL(req.url ?? '/', PragmaticServerHost.BaseUrl)
        const tenant = url.searchParams.get(PragmaticServerHost.TenantParam)
        return tenant !== null && tenant.length > 0 ? tenant : this.browserAuth.CookieTenant(req.headers)
    }

    private RejectRetryable(socket: Socket): void
    {
        if (!socket.writableEnded && !socket.destroyed)
        {
            socket.write(PragmaticServerHost.ServiceUnavailableResponse)
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

    private Reject(socket: Socket): void
    {
        if (!socket.writableEnded && !socket.destroyed)
        {
            socket.write(PragmaticServerHost.UnauthorizedResponse)
        }
        socket.destroy()
    }
}
