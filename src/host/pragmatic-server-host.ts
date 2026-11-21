import { randomUUID } from 'node:crypto'
import { AppServingEndpoint } from './apps/app-serving-endpoint.js'
import { CookieAppSessionCheck } from './apps/app-session-check.js'
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as httpsCreateServer, type Server as HttpsServer } from 'node:https'
import type { TLSSocket } from 'node:tls'
import type { Socket, AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { WsMessageSocket, HeartbeatMonitor, BackpressurePolicy, TransportCloseCode } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AuthMethod, type AccessContext, type Realm } from '@pragmatic-tech-ai/pragmatic-identity'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/pragmatic-identity-store'
import { MachineTls, type MachineTlsRef, MachineCertIdentity, type MasterKeyRef, type PagingLimits, type AdapterPacksConfig, type WsResilienceConfig, RateLimitGuard, RateLimitScope, AuditSurface, NullAccessAuditSink, type IAccessAuditSink, HealthEndpoint, ClusterKeys, type DeploymentMode, type Observability, DrainController, type IInFlightSource, RequestCorrelation, type WebSocketAddress } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { type MachineAuthContext, AuthHttpEndpoint } from './auth-http-endpoint.js'
import type { CypherLimits } from '../config/cypher-limits.js'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'
import type { PragmaticServer } from '../pragmatic-server.js'
import { ServerConnectionHandler } from './server-connection-handler.js'
import { PrincipalConnectionRegistry, type IRevocableConnection } from './principal-connection-registry.js'
import { AdminService } from './admin-service.js'
import { BrowserSessionAuth } from './browser-session-auth.js'
import { ConnectionAuthenticator } from './connection-authenticator.js'
import { InMemoryEnvironmentCoordinator } from '../environments/environment-coordinator.js'
import { EnvironmentRegistry } from '../environments/environment-registry.js'
import { InMemoryEnvironmentOwnership, EnvironmentOwnedElsewhereError } from '../environments/environment-ownership.js'
import { RedisEnvironmentOwnership } from '../environments/redis-environment-ownership.js'
import { FetchHttpClient, InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { RedisOidcFlowStateStore } from '../identity/redis-oidc-flow-state-store.js'
import type { IdentityRuntime } from '../identity/identity-runtime.js'
import type { IEnvironmentProvisioning } from '../environments/environment-provisioning.js'
import type { PlatformServices } from '../platform/platform-services.js'
import { NullLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { RequestInstrumentation } from '../observability/request-instrumentation.js'
import { WsInFlightSource } from '../observability/ws-in-flight-source.js'
import { EnvironmentPurpose } from '../environments/environment-purpose.js'
import { EffectivePurposeResolver } from './effective-purpose-resolver.js'

export interface PragmaticServerHostOptions
{
    host?: string
    port: number
    baseDir: string
    masterKey: MasterKeyRef
    provisioning: IEnvironmentProvisioning
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

/** Stateless multi-environment front door: the ?environment hint selects an environment's pack, the bearer authenticated against that pack binds the environment,
 *  each environment is isolated in its own PragmaticServer, and idle environments are evicted by the registry sweep. */
export class PragmaticServerHost
{
    private static readonly DefaultHost = '127.0.0.1'
    private static readonly FlowKeySeparator = ':'
    private static readonly UpgradeEvent = 'upgrade'
    private static readonly RequestEvent = 'request'
    private static readonly CloseEvent = 'close'
    private static readonly RevokedCloseCode = 1008
    private static readonly RevokedTerminateGraceMs = 1000
    private static readonly ListeningEvent = 'listening'
    private static readonly ErrorEvent = 'error'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly EnvironmentParam = 'environment'
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
    private readonly registry: EnvironmentRegistry
    private readonly authenticator: ConnectionAuthenticator
    private readonly browserAuth: BrowserSessionAuth
    private readonly audit: IAccessAuditSink
    private readonly handlers = new Set<ServerConnectionHandler>()
    private readonly principalConnections = new PrincipalConnectionRegistry()
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
        registry: EnvironmentRegistry,
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
            FlowStateFor: environmentId => url === undefined
                ? new InMemoryOidcFlowStateStore()
                : new RedisOidcFlowStateStore(url, ClusterKeys.OidcFlowPrefix + environmentId + PragmaticServerHost.FlowKeySeparator),
        }
    }

    public static async StartAsync(options: PragmaticServerHostOptions): Promise<PragmaticServerHost>
    {
        const coordinator = new InMemoryEnvironmentCoordinator()
        const ownership = options.redisUrl !== undefined && options.redisUrl.length > 0
            ? new RedisEnvironmentOwnership(options.redisUrl, options.replicaId ?? randomUUID())
            : new InMemoryEnvironmentOwnership()
        await ownership.Start().catch(() => {})
        const registry = new EnvironmentRegistry(options.baseDir, options.masterKey, options.provisioning, coordinator, options.platform, options.deploymentMode, ownership, options.provisionedSecrets, PragmaticServerHost.BuildIdentityRuntime(options.redisUrl), options.adapterPacks, options.logger)
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

    public RegistryForTest(): EnvironmentRegistry
    {
        return this.registry
    }

    public async IdentityPackForTest(environmentId: string): Promise<ServerIdentityPack>
    {
        return (await this.registry.ServerFor(environmentId)).Pack()
    }

    public async RealmForTest(environmentId: string): Promise<Realm>
    {
        return (await this.registry.ServerFor(environmentId)).Realm()
    }

    public async LanguageServiceForTest(environmentId: string): Promise<ILanguageService>
    {
        return (await this.registry.ServerFor(environmentId)).LanguageService()
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
        const environmentId = this.EnvironmentHint(req)
        if (environmentId === null)
        {
            this.Reject(socket)
            return
        }
        const limit = this.rateLimit.Check(
            { scope: RateLimitScope.Environment, environment: environmentId, key: environmentId },
            { surface: AuditSurface.Upgrade, environment: environmentId, methodOrPath: RateLimitGuard.UpgradeMethodName() })
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
            if (error instanceof EnvironmentOwnedElsewhereError)
            {
                this.RejectRetryable(socket)
            }
            else
            {
                this.Reject(socket)
            }
            return
        }
        this.registry.Acquire(environmentId)
        let attached = false
        try
        {
            const authenticated = await this.AuthenticateAgainst(req, server)
            if (authenticated === null)
            {
                this.Reject(socket)
                return
            }
            const context = authenticated.context
            const effectivePurpose = authenticated.effectivePurpose
            const parent = this.instrumentation !== undefined ? RequestCorrelation.Extract(req.headers) : undefined
            const languageService = await server.LanguageService()
            const sourceChanges = await server.DevSourceChangeBridge()
            const solutionRoots = effectivePurpose === EnvironmentPurpose.Development && server.ServesDevelopment() ? await server.DevSolutionRoots() : undefined
            const manager = await server.Manager()
            const pack = await server.Pack()
            const admin = new AdminService(pack.Grants, pack.Audit, await server.RealmConfigStore(), server.Realm(), () => this.registry.DisposeEnvironment(environmentId), pack.Accounts, pack.Registrar, pack.Tokens, {
                Invalidate: name => server.InvalidateAdapterPack(name),
                AllowScripts: name => server.AllowAdapterPackScripts(name),
                DenyScripts: name => server.DenyAdapterPackScripts(name),
                ListScriptAllowlist: () => server.ListAdapterPackScripts(),
            }, await server.SecurityAdmin(), this.principalConnections, pack.Sessions)
            if (this.disposed)
            {
                this.RejectRetryable(socket)
                return
            }
            this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) =>
            {
                try
                {
                    const runtime = ServerConnectionHandler.RuntimeAttachArgs(server, effectivePurpose)
                    const development = ServerConnectionHandler.DevelopmentAttachArgs(server, effectivePurpose)
                    const resilience = this.wsResilience
                    const socket = new WsMessageSocket(ws, {
                        policy: new BackpressurePolicy(resilience.backpressureSoftBytes, resilience.backpressureHardBytes, resilience.backpressureGraceMs),
                        onShed: () => this.logger.Info(PragmaticServerHost.ShedLine, { [PragmaticServerHost.EventKey]: PragmaticServerHost.ShedEvent }),
                    })
                    const handler = ServerConnectionHandler.Attach(socket, languageService, manager, context, runtime.connectors ?? development.connectors, runtime.cypherQuery ?? development.cypherQuery, this.instrumentation, parent, this.audit, this.rateLimit, admin, this.cypherLimits, effectivePurpose, runtime.applications, runtime.data, this.paging, runtime.cypherExecute ?? development.cypherExecute, runtime.deployProvider, development.devGraphService, runtime.environmentGraphHost, runtime.modelView ?? development.modelView, runtime.dataChanges, undefined, sourceChanges, solutionRoots)
                    this.handlers.add(handler)
                    const revocable: IRevocableConnection =
                    {
                        Revoke: () =>
                        {
                            handler.Revoke()
                            ws.close(PragmaticServerHost.RevokedCloseCode)
                            const terminateTimer = setTimeout(() =>
                            {
                                if (ws.readyState !== WebSocket.CLOSED)
                                {
                                    ws.terminate()
                                }
                            }, PragmaticServerHost.RevokedTerminateGraceMs)
                            terminateTimer.unref?.()
                        },
                    }
                    this.principalConnections.Add(context.Realm.Id, context.Principal.Id, revocable)
                    this.heartbeat.Watch(ws)
                    ws.on(PragmaticServerHost.CloseEvent, () =>
                    {
                        if (this.disposed)
                        {
                            return
                        }
                        handler.Dispose()
                        this.handlers.delete(handler)
                        this.principalConnections.Remove(revocable)
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
            this.Reject(socket)
        }
        finally
        {
            if (!attached)
            {
                this.registry.Release(environmentId)
            }
        }
    }

    private async AuthenticateAgainst(req: IncomingMessage, server: PragmaticServer): Promise<{ context: AccessContext; effectivePurpose: EnvironmentPurpose } | null>
    {
        const header = req.headers[PragmaticServerHost.AuthorizationHeader]
        if (header === undefined)
        {
            const credential = this.browserAuth.Credential(req, true)
            if (credential === null || credential.Environment !== server.Realm().Id)
            {
                return null
            }
            return EffectivePurposeResolver.ResolveAuthenticated(await this.authenticator.ResolveAsync(credential.Token, server.Realm(), await server.Pack()), true, server)
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
        return EffectivePurposeResolver.ResolveAuthenticated(await this.authenticator.ResolveAsync(token, server.Realm(), await server.Pack()), false, server)
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
                await new AppServingEndpoint(this.registry, new CookieAppSessionCheck(this.browserAuth, this.registry)).Handle(req, res)
                return
            }
            const environmentId = this.EnvironmentHint(req)
            if (environmentId === null)
            {
                res.writeHead(BrowserSessionAuth.IsSessionPath(path) ? PragmaticServerHost.UnauthorizedStatus : PragmaticServerHost.NotFoundStatus)
                res.end()
                return
            }
            const server = await this.registry.ServerFor(environmentId)
            const pack = await server.Pack()
            const endpoint = new AuthHttpEndpoint(pack, server.Realm(), server.Oidc(), this.MachineContext(req, pack), this.instrumentation, this.audit, this.browserAuth, server.CallerCredentials())
            await endpoint.Handle(req, res)
        }
        catch (error)
        {
            if (!res.headersSent && !res.writableEnded)
            {
                if (error instanceof EnvironmentOwnedElsewhereError)
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

    private EnvironmentHint(req: IncomingMessage): string | null
    {
        const url = new URL(req.url ?? '/', PragmaticServerHost.BaseUrl)
        const environment = url.searchParams.get(PragmaticServerHost.EnvironmentParam)
        return environment !== null && environment.length > 0 ? environment : this.browserAuth.CookieEnvironment(req.headers)
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
