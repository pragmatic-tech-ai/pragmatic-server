import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import {
    CreateFailedError,
    DockerUnavailableError,
    EnvironmentExistsError,
    EnvironmentNotFoundError,
    ImageMissingError,
    EnvironmentNotDevelopmentError,
    EnvironmentNotRuntimeError
} from './environment-service.js'
import { GraphExistsError, GraphNameInvalidError, GraphNotFoundError } from './graph-service.js'
import { EnvType, Template, EnvironmentChangeKind, type EnvironmentChange, type EnvironmentRecord } from './environment-record.js'
import { EnvironmentDtoMapper, type EnvironmentDto } from './environment-dto.js'
import { HiveHealthProducer } from './hive-health-producer.js'
import { InvalidTenantIdError } from './idp-service.js'
import { PortUnavailableError } from './port-allocator.js'
import type { TenantProvisioningService } from './tenant-provisioning-service.js'
import { InvalidEnvironmentNameError, TemplateCatalog } from './template-catalog.js'
import type { IOperatorIdentity } from './operator-identity.js'
import { SessionCookie } from './session-cookie.js'
import { AdminProxyError, AdminProxyErrorKind, type AdminSnapshot } from './admin-proxy.js'
import {
    ClientHasTenantsError,
    HiveHasEnvironmentsError,
    HivePlacementError,
    RecordExistsError,
    TenantHasHivesError,
    UnknownClientError,
    UnknownTenantError,
    type PlatformDirectory
} from './platform-directory.js'
import { HiveBackend, InfraMode, InvalidRecordIdError } from './platform-records.js'
import { PlaneHttp } from './plane-http.js'
import { UnsupportedBackendError } from './hive-orchestrator.js'
import type { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { KubectlError } from './kubectl.js'
import type { HiveRolloutStatus, PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import type { ManifestRecord } from './manifest-record.js'
import { AgentUnauthorizedError, HiveNotRegisteredError, ManifestExistsError, ManifestNotGatedError, UnknownHiveError, UnknownManifestError } from './rollout-errors.js'
import type { ClientRecord, ClusterSpec, HiveRecord, RegistrySpec, TenantRecord } from './platform-records.js'
import type { CreateAccountParams, GraphLoadedDto, GrantMutationDto, IdentityConfigDto, SecurityModelDto, TokenIssuedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILogProcess } from '../../environments/seed/docker.js'
import type { TenantPlane } from './tenant-auth/tenant-plane.js'
import { TenantEventType } from './tenant-api/tenant-events.js'
import { TenantLogSocket } from './tenant-api/tenant-log-socket.js'

export interface IEnvironmentService
{
    Create(name: string, template: Template, type: EnvType, hostPort?: number, hiveId?: string): Promise<EnvironmentRecord>
    Start(name: string): Promise<EnvironmentRecord>
    Stop(name: string): Promise<EnvironmentRecord>
    Restart(name: string): Promise<EnvironmentRecord>
    Delete(name: string): Promise<void>
    List(): readonly EnvironmentRecord[]
    ListReconciled(): Promise<readonly EnvironmentRecord[]>
    Logs(name: string): Promise<string>
    LogStream(name: string, onData: (chunk: string) => void): ILogProcess
    /** Additive lifecycle-change subscription (RULING 5): fires on create, every status change, and delete; returns an unsubscribe. */
    OnChanged(cb: (change: EnvironmentChange) => void): () => void
    AdminSnapshot(name: string): Promise<AdminSnapshot>
    AdminCreateAccount(name: string, params: CreateAccountParams): Promise<void>
    AdminDisableAccount(name: string, principalId: string): Promise<void>
    AdminGrantRole(name: string, mutation: GrantMutationDto): Promise<void>
    AdminRevokeRole(name: string, mutation: GrantMutationDto): Promise<void>
    AdminGetConfig(name: string): Promise<IdentityConfigDto>
    AdminSetConfig(name: string, config: IdentityConfigDto): Promise<void>
    AdminGetSecurityModel(name: string): Promise<SecurityModelDto | undefined>
    AdminSetSecurityModel(name: string, securityModel: SecurityModelDto): Promise<void>
    AdminIssueMakerToken(name: string): Promise<TokenIssuedDto>
    AdminGrantAppReader(name: string): Promise<void>
}

export interface IGraphService
{
    Create(envName: string, name: string, description: string): Promise<GraphDto>
    List(envName: string): Promise<readonly GraphDto[]>
    Get(envName: string, graphName: string): Promise<GraphDto>
    Delete(envName: string, graphName: string): Promise<void>
    Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
    GetLoaded(runtimeEnv: string): Promise<GraphLoadedDto | null>
}

export type { EnvironmentDto }

/** The only fields of an issued maker token revealed to the operator. */
export interface MakerTokenDto
{
    token: string
    principalId: string
    expiresAt: string | null
}

export type GraphDto = {
    name: string
    description: string
    packageCount: number
    createdAt: string
}

/** The result of promoting a dev graph into a runtime environment: non-secret refs only. */
export type PromotionResultDto = {
    graphName: string
    packageCount: number
    targetEnv: string
}

/** Platform record DTOs mirror the stored records 1:1. */
export type ClientDto = ClientRecord
/** The tenant shape exposed over HTTP: public coordinates only. The record's internal IdP refs
 *  (idpBaseUrl, idpCaRef — a host filesystem path — and idpAdminTokenRef) are deliberately omitted. */
export type TenantDto =
{
    id: string
    clientId: string
    displayName: string
    createdAt: string
    ownerEmail?: string
    ownerPrincipalId?: string
}
export type HiveDto = HiveRecord

export type { HiveHealthDto } from './hive-health-producer.js'

/** A published manifest as shown to the operator: version id, image reference, notes; no secrets. */
export type ManifestDto = ManifestRecord

/** A hive's rollout state: target version plus per-environment reported state; no secrets. */
export type HiveRolloutDto = HiveRolloutStatus

/** The one-time reveal of a hive's agent token. Returned by the rollout-registration route and nowhere else; no record stores the raw token. */
export type RolloutRegistrationDto = {
    token: string
}

export type ChangedEvent = { type: string }

type ErrorCtor = abstract new (...args: never[]) => Error
type CreateBody = { name?: unknown; template?: unknown; type?: unknown; hostPort?: unknown; hiveId?: unknown }
type LoginBody = { email?: unknown; password?: unknown }

class BodyTooLargeError extends Error
{
}

export class ControlPlaneHost
{
    private static readonly HiveIdInvalidMessage = 'hiveId must be a non-empty string'
    private static readonly LocalName = 'localhost'
    private static readonly HttpScheme = 'http://'
    private static readonly BaseUrl = ControlPlaneHost.HttpScheme + ControlPlaneHost.LocalName
    private static readonly PortSeparator = ':'
    private static readonly AllowedHosts: ReadonlySet<string> = new Set([ControlPlaneHost.LocalName, '127.0.0.1', '[::1]'])
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly NoStore = 'no-store'
    private static readonly JsonMediaType = 'application/json'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly TransferEncodingHeader = 'transfer-encoding'
    private static readonly StatusForbidden = 403
    private static readonly StatusUnsupported = 415
    private static readonly ForbiddenHostMessage = 'Host not allowed'
    private static readonly UnsupportedMediaMessage = 'Content-Type must be application/json'
    private static readonly BadNameMessage = 'Invalid environment name in path'
    private static readonly NotListeningMessage = 'ControlPlaneHost is not listening'
    private static readonly OperationFailedMessage = 'Environment operation failed'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly LogPrefix = '[control-plane] request failed:'
    private static readonly ApiPrefix = '/api/'
    private static readonly TenantAuthPrefix = '/tenant-auth/'
    private static readonly TenantApiPrefix = '/tenant-api/'
    private static readonly TenantEventsPath = '/tenant-api/events'
    private static readonly TenantLogsStreamPattern = new RegExp(
        '^' + ControlPlaneHost.TenantApiPrefix + 'environments/([^/]+)/logs/stream$')
    private static readonly PingPath = '/api/ping'
    private static readonly TemplatesPath = '/api/templates'
    private static readonly EnvironmentsPath = '/api/environments'
    private static readonly EventsPath = '/api/events'
    private static readonly ClientsSegment = 'clients'
    private static readonly TenantsSegment = 'tenants'
    private static readonly HivesSegment = 'hives'
    private static readonly PlatformPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + '(' +
        [ControlPlaneHost.ClientsSegment, ControlPlaneHost.TenantsSegment, ControlPlaneHost.HivesSegment].join('|') + ')(?:/([^/]+))?$')
    private static readonly HealthSegment = 'health'
    private static readonly HiveHealthPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.HealthSegment + '$')
    private static readonly ManifestsSegment = 'manifests'
    private static readonly ManifestsPath = ControlPlaneHost.ApiPrefix + ControlPlaneHost.ManifestsSegment
    private static readonly WithdrawnSegment = 'withdrawn'
    private static readonly ManifestWithdrawnPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.ManifestsSegment + '/([^/]+)/' + ControlPlaneHost.WithdrawnSegment + '$')
    private static readonly GatingSegment = 'gating'
    private static readonly TargetSegment = 'target'
    private static readonly RolloutSegment = 'rollout'
    private static readonly RolloutRegistrationSegment = 'rollout-registration'
    private static readonly RolloutPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + '(' + ControlPlaneHost.TenantsSegment + '|' + ControlPlaneHost.HivesSegment + ')/([^/]+)/(' +
        [ControlPlaneHost.ManifestsSegment, ControlPlaneHost.GatingSegment, ControlPlaneHost.TargetSegment, ControlPlaneHost.RolloutSegment, ControlPlaneHost.RolloutRegistrationSegment].join('|') +
        ')(?:/([^/]+))?$')
    private static readonly AgentSegment = 'agent'
    private static readonly ReportSegment = 'report'
    private static readonly AgentPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.AgentSegment + '/(' +
        [ControlPlaneHost.TargetSegment, ControlPlaneHost.ReportSegment].join('|') + ')$')
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPattern = /^Bearer (\S+)$/
    private static readonly ReportInvalidMessage = 'environmentName (non-empty string), runningImage (string) and ready (boolean) are required'
    private static readonly VersionRequiredMessage = 'version (non-empty string) is required'
    private static readonly ImageRequiredMessage = 'image (non-empty string) is required'
    private static readonly NotesInvalidMessage = 'notes must be a string'
    private static readonly StatusNoContent = 204
    private static readonly IdRequiredMessage = 'id (non-empty string) is required'
    private static readonly DisplayNameRequiredMessage = 'displayName (string) is required'
    private static readonly OwnerEmailRequiredMessage = 'ownerEmail (non-empty string) is required'
    private static readonly ReservedIdMessage = "id must not start with '_' (reserved for the IdP namespace)"
    private static readonly ReservedIdPrefix = '_'
    private static readonly ClientIdRequiredMessage = 'clientId (non-empty string) is required'
    private static readonly TenantIdRequiredMessage = 'tenantId (non-empty string) is required'
    private static readonly OptionalStringMessage = 'optional reference fields must be strings'
    private static readonly ClusterInvalidMessage = 'cluster must be { backend, mode } with valid values; backend one of: '
    private static readonly RegistryInvalidMessage = 'registry must be { mode, endpoint?, credentialRef? } with a valid mode; mode one of: '
    private static readonly LoginPath = '/api/login'
    private static readonly SessionPath = '/api/session'
    private static readonly LogoutPath = '/api/logout'
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly CookieHeader = 'cookie'
    private static readonly StatusUnauthorized = 401
    private static readonly InvalidCredentialsMessage = 'Invalid email or password'
    private static readonly UnauthenticatedMessage = 'Authentication required'
    private static readonly BadOriginMessage = 'Origin not allowed'
    private static readonly CredentialsRequiredMessage = 'email and password (strings) are required'
    private static readonly StartAction = 'start'
    private static readonly StopAction = 'stop'
    private static readonly LogsAction = 'logs'
    private static readonly EnvPathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)(?:/(' +
        [ControlPlaneHost.StartAction, ControlPlaneHost.StopAction, ControlPlaneHost.LogsAction].join('|') + '))?$')
    private static readonly AdminSegment = 'admin'
    private static readonly SnapshotPath = 'snapshot'
    private static readonly AccountsPath = 'accounts'
    private static readonly GrantsPath = 'grants'
    private static readonly ConfigPath = 'config'
    private static readonly SecurityModelPath = 'security-model'
    private static readonly AdminPathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)/' + ControlPlaneHost.AdminSegment + '/(' +
        [ControlPlaneHost.SnapshotPath, ControlPlaneHost.AccountsPath, ControlPlaneHost.GrantsPath, ControlPlaneHost.ConfigPath, ControlPlaneHost.SecurityModelPath].join('|') + ')(?:/([^/]+))?$')
    private static readonly GraphsSegment = 'graphs'
    private static readonly GraphPathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)/' + ControlPlaneHost.GraphsSegment + '(?:/([^/]+))?$')
    private static readonly MakerTokenSegment = 'maker-token'
    private static readonly MakerTokenPathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)/' + ControlPlaneHost.MakerTokenSegment + '$')
    private static readonly AppReaderSegment = 'app-reader-grant'
    private static readonly AppReaderPathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)/' + ControlPlaneHost.AppReaderSegment + '$')
    private static readonly PromoteSegment = 'promote'
    private static readonly PromotePathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)/' + ControlPlaneHost.GraphsSegment + '/([^/]+)/' + ControlPlaneHost.PromoteSegment + '$')
    private static readonly LoadedGraphSegment = 'loaded-graph'
    private static readonly LoadedGraphPathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)/' + ControlPlaneHost.LoadedGraphSegment + '$')
    private static readonly TargetEnvRequiredMessage = 'targetEnv (non-empty string) is required'
    private static readonly DescriptionRequiredMessage = 'description (string) is required'
    private static readonly AccountFieldsMessage = 'email, principalId and password (non-empty strings) are required'
    private static readonly GrantFieldsMessage = 'subject and role (strings) are required'
    private static readonly ConfigFieldsMessage = 'packId and delegationDepth (strings) are required'
    private static readonly SecurityModelFieldMessage = 'securityModel (object) is required'
    private static readonly BodyObjectMessage = 'Request body must be a JSON object'
    private static readonly ConnectUnavailableMessage = 'Environment is not reachable'
    private static readonly Utf8 = 'utf8'
    private static readonly ChangedType = 'environments-changed'
    private static readonly MaxBodyBytes = 4096
    private static readonly StatusCreated = 201
    private static readonly StatusBadRequest = 400
    private static readonly StatusConflict = 409
    private static readonly StatusTooLarge = 413
    private static readonly StatusInternal = 500
    private static readonly StatusBadGateway = 502
    private static readonly StatusUnavailable = 503
    private static readonly GenericError = 'Internal server error'
    private static readonly TooLargeMessage = 'Request body too large'
    private static readonly BadJsonMessage = 'Request body must be valid JSON'
    private static readonly NameRequiredMessage = 'name (string) is required'
    private static readonly TemplateInvalidMessage = 'template must be one of: '
    private static readonly TypeInvalidMessage = 'type must be one of: '
    private static readonly HostPortInvalidMessage = 'hostPort must be an integer between 1 and 65535'
    private static readonly MaxPort = 65535
    private static readonly ErrorStatuses: ReadonlyMap<ErrorCtor, number> = new Map<ErrorCtor, number>([
        [InvalidEnvironmentNameError, ControlPlaneHost.StatusBadRequest],
        [EnvironmentNotFoundError, PlaneHttp.StatusNotFound],
        [EnvironmentExistsError, ControlPlaneHost.StatusConflict],
        [PortUnavailableError, ControlPlaneHost.StatusConflict],
        [ImageMissingError, ControlPlaneHost.StatusConflict],
        [DockerUnavailableError, ControlPlaneHost.StatusUnavailable],
        [CreateFailedError, ControlPlaneHost.StatusInternal],
        [GraphExistsError, ControlPlaneHost.StatusConflict],
        [GraphNotFoundError, PlaneHttp.StatusNotFound],
        [GraphNameInvalidError, ControlPlaneHost.StatusBadRequest],
        [EnvironmentNotDevelopmentError, ControlPlaneHost.StatusBadRequest],
        [EnvironmentNotRuntimeError, ControlPlaneHost.StatusBadRequest],
        [InvalidRecordIdError, ControlPlaneHost.StatusBadRequest],
        [InvalidTenantIdError, ControlPlaneHost.StatusBadRequest],
        [RecordExistsError, ControlPlaneHost.StatusConflict],
        [UnknownClientError, PlaneHttp.StatusNotFound],
        [UnknownTenantError, PlaneHttp.StatusNotFound],
        [ClientHasTenantsError, ControlPlaneHost.StatusConflict],
        [TenantHasHivesError, ControlPlaneHost.StatusConflict],
        [HiveHasEnvironmentsError, ControlPlaneHost.StatusConflict],
        [HivePlacementError, ControlPlaneHost.StatusConflict],
        [UnsupportedBackendError, ControlPlaneHost.StatusBadRequest],
        [KubectlError, ControlPlaneHost.StatusBadGateway],
        // The tenant is not authorized to that version (it was never gated to it): forbidden, not missing.
        [ManifestNotGatedError, ControlPlaneHost.StatusForbidden],
        [UnknownManifestError, PlaneHttp.StatusNotFound],
        [ManifestExistsError, ControlPlaneHost.StatusConflict],
        [HiveNotRegisteredError, PlaneHttp.StatusNotFound],
        [UnknownHiveError, PlaneHttp.StatusNotFound],
        [AgentUnauthorizedError, ControlPlaneHost.StatusUnauthorized]
    ])

    private httpServer: HttpServer | undefined
    private wsServer: WebSocketServer | undefined
    private readonly clients = new Set<WebSocket>()
    /** Tenant ws sockets mapped to their teardown (events: unsubscribe; logs: kill the stream). Close() runs each. */
    private readonly tenantClients = new Map<WebSocket, () => void>()
    private tenantChangeSubscription: (() => void) | undefined
    private readonly staticRootAbs: string
    private readonly tenantStaticRootAbs?: string

    public constructor(
        private readonly service: IEnvironmentService,
        private readonly graphService: IGraphService,
        staticRoot: string,
        private readonly operator: IOperatorIdentity,
        private readonly secureCookie: boolean,
        private readonly directory: PlatformDirectory,
        private readonly orchestrators: HiveOrchestratorFactory,
        private readonly deployments: PlatformDeploymentRegistry,
        private readonly provisioning: TenantProvisioningService,
        private readonly tenantAuth?: TenantPlane)
    {
        this.staticRootAbs = resolve(staticRoot)
        if (tenantAuth !== undefined)
        {
            this.tenantStaticRootAbs = resolve(tenantAuth.staticRoot)
            // RULING 5: route every environment lifecycle change to the tenant bus, scoped by the env's owning tenant.
            // An unbound env (no tenantId) has no tenant audience, so it is skipped.
            this.tenantChangeSubscription = this.service.OnChanged(change =>
            {
                const rec = change.record
                if (rec.tenantId !== undefined)
                {
                    tenantAuth.events.Emit(rec.tenantId, { type: ControlPlaneHost.TenantEventFor(change.kind), environmentName: rec.name })
                }
            })
        }
    }

    /** Maps an environment lifecycle-change kind to the tenant event type fanned out over the tenant bus. */
    private static TenantEventFor(kind: EnvironmentChangeKind): TenantEventType
    {
        switch (kind)
        {
            case EnvironmentChangeKind.Created:
                return TenantEventType.EnvironmentCreated
            case EnvironmentChangeKind.Deleted:
                return TenantEventType.EnvironmentDeleted
            default:
                return TenantEventType.EnvironmentChanged
        }
    }

    public Listen(port: number, host: string): Promise<void>
    {
        const wss = new WebSocketServer({ noServer: true })
        const server = createServer((req, res) =>
        {
            void this.Handle(req, res)
        })
        server.on('upgrade', (req, socket, head) =>
        {
            this.RouteUpgrade(req, socket, head, wss)
        })
        this.httpServer = server
        this.wsServer = wss
        return new Promise((res, rej) =>
        {
            server.once('error', rej)
            server.listen(port, host, () =>
            {
                server.off('error', rej)
                res()
            })
        })
    }

    /**
     * Dispatches a ws upgrade. The operator `/api/events` branch is unchanged (operator gate + operator host/origin).
     * The two tenant branches are reached only when a tenant plane is mounted and are gated by the tenant host, the
     * tenant origin, and a resolved `pts_session` principal; any failure destroys the socket.
     */
    private RouteUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void
    {
        const path = new URL(req.url ?? PlaneHttp.RootPath, ControlPlaneHost.BaseUrl).pathname
        if (path === ControlPlaneHost.EventsPath)
        {
            this.UpgradeOperatorEvents(req, socket, head, wss)
            return
        }
        const tenant = this.tenantAuth
        if (tenant === undefined)
        {
            socket.destroy()
            return
        }
        if (path === ControlPlaneHost.TenantEventsPath)
        {
            this.UpgradeTenantEvents(req, socket, head, wss, tenant)
            return
        }
        const lm = ControlPlaneHost.TenantLogsStreamPattern.exec(path)
        if (lm !== null)
        {
            this.UpgradeTenantLogs(req, socket, head, wss, tenant, lm)
            return
        }
        socket.destroy()
    }

    /** The operator events ws: operator host + operator origin + operator session, then tracked in `clients`. Unchanged. */
    private UpgradeOperatorEvents(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void
    {
        if (!ControlPlaneHost.HostAllowed(req) || !ControlPlaneHost.OriginAllowed(req))
        {
            socket.destroy()
            return
        }
        void this.Authenticated(req).then(ok =>
        {
            if (!ok)
            {
                socket.destroy()
                return
            }
            wss.handleUpgrade(req, socket, head, ws =>
            {
                this.clients.add(ws)
                ws.on(ControlPlaneHost.CloseEvent, () => this.clients.delete(ws))
                ws.on(ControlPlaneHost.ErrorEvent, () => this.clients.delete(ws))
            })
        }, () => socket.destroy())
    }

    /** The tenant events ws: on success subscribes the bus for the session's tenant and forwards each event as JSON. */
    private UpgradeTenantEvents(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer, tenant: TenantPlane): void
    {
        if (!ControlPlaneHost.TenantUpgradeAllowed(req, tenant))
        {
            socket.destroy()
            return
        }
        void tenant.gate.Principal(req).then(session =>
        {
            if (session === null)
            {
                socket.destroy()
                return
            }
            wss.handleUpgrade(req, socket, head, ws =>
            {
                const unsubscribe = tenant.events.On(session.tenantId, ev =>
                {
                    if (ws.readyState === WebSocket.OPEN)
                    {
                        ws.send(JSON.stringify(ev))
                    }
                })
                this.TrackTenant(ws, unsubscribe)
            })
        }, () => socket.destroy())
    }

    /** The tenant log-stream ws: on success hands the socket to TenantLogSocket, which enforces env ownership and streams. */
    private UpgradeTenantLogs(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer, tenant: TenantPlane, m: RegExpExecArray): void
    {
        if (!ControlPlaneHost.TenantUpgradeAllowed(req, tenant))
        {
            socket.destroy()
            return
        }
        const name = ControlPlaneHost.Decode(m[1] as string)
        if (name === undefined)
        {
            socket.destroy()
            return
        }
        void tenant.gate.Principal(req).then(session =>
        {
            if (session === null)
            {
                socket.destroy()
                return
            }
            wss.handleUpgrade(req, socket, head, ws =>
            {
                const logSocket = new TenantLogSocket(session, name, this.service)
                if (!logSocket.Attach(ws))
                {
                    // Not the session tenant's env (or unknown): the socket is already closed and no stream started.
                    return
                }
                this.TrackTenant(ws, () => logSocket.Dispose())
            })
        }, () => socket.destroy())
    }

    /** Records a tenant socket with its teardown and wires close/error to run that teardown and drop the entry. */
    private TrackTenant(ws: WebSocket, teardown: () => void): void
    {
        this.tenantClients.set(ws, teardown)
        ws.on(ControlPlaneHost.CloseEvent, () => this.RemoveTenant(ws))
        ws.on(ControlPlaneHost.ErrorEvent, () => this.RemoveTenant(ws))
    }

    private RemoveTenant(ws: WebSocket): void
    {
        const teardown = this.tenantClients.get(ws)
        if (teardown === undefined)
        {
            return
        }
        this.tenantClients.delete(ws)
        teardown()
    }

    /** Both tenant ws routes share this gate: the request host and (present) origin must be configured tenant hosts. */
    private static TenantUpgradeAllowed(req: IncomingMessage, tenant: TenantPlane): boolean
    {
        return PlaneHttp.HostIn(req, tenant.allowedHosts) && PlaneHttp.OriginInHosts(req, tenant.allowedHosts)
    }

    public async Close(): Promise<void>
    {
        if (this.tenantChangeSubscription !== undefined)
        {
            this.tenantChangeSubscription()
            this.tenantChangeSubscription = undefined
        }
        for (const [ws, teardown] of this.tenantClients)
        {
            teardown()
            ws.terminate()
        }
        this.tenantClients.clear()
        for (const c of this.clients)
        {
            c.terminate()
        }
        this.clients.clear()
        const wss = this.wsServer
        const server = this.httpServer
        this.wsServer = undefined
        this.httpServer = undefined
        if (wss !== undefined)
        {
            await new Promise<void>(res => wss.close(() => res()))
        }
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
            throw new Error(ControlPlaneHost.NotListeningMessage)
        }
        return { address: a.address, port: a.port }
    }

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        try
        {
            if (!this.HostAccepted(req))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.ForbiddenHostMessage })
                return
            }
            if (ControlPlaneHost.HasBody(req) && !ControlPlaneHost.IsJson(req))
            {
                req.resume()
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnsupported, { error: ControlPlaneHost.UnsupportedMediaMessage })
                return
            }
            const path = new URL(req.url ?? PlaneHttp.RootPath, ControlPlaneHost.BaseUrl).pathname
            if (this.tenantAuth !== undefined && await this.RouteTenant(req, res, path, this.tenantAuth))
            {
                return
            }
            if (path.startsWith(ControlPlaneHost.ApiPrefix))
            {
                // The operator surface is operator-hosts-only: a tenant origin accepted above cannot reach /api/*.
                if (!ControlPlaneHost.HostAllowed(req))
                {
                    req.resume()
                    PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.ForbiddenHostMessage })
                    return
                }
                if (PlaneHttp.IsMutating(req) && !ControlPlaneHost.OriginAllowed(req))
                {
                    req.resume()
                    PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.BadOriginMessage })
                    return
                }
                // Agent routes skip the operator-session gate; RouteAgent demands the per-hive bearer instead.
                if (!ControlPlaneHost.IsPublicApi(path) && !ControlPlaneHost.IsAgentApi(path) && !(await this.Authenticated(req)))
                {
                    req.resume()
                    PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
                    return
                }
            }
            const handled = await this.RouteApi(req, res, path)
            if (!handled)
            {
                await PlaneHttp.ServeStatic(req, res, path, this.StaticRootFor(req))
            }
        }
        catch (err)
        {
            this.WriteError(res, err)
        }
    }

    /**
     * Dispatches the tenant plane and returns whether it answered. `/tenant-auth/*` is public (no operator gate,
     * no tenant gate) and delegates to the auth endpoint. `/tenant-api/*` is gated: a mutating request's Origin is
     * checked against the tenant hosts, then the gate must resolve a principal (else 401); the validated session is
     * handed to the data API. Any other path is not ours (returns false, so the operator surface and static serving
     * are reached unchanged).
     */
    private async RouteTenant(req: IncomingMessage, res: ServerResponse, path: string, tenant: TenantPlane): Promise<boolean>
    {
        const isAuth = path.startsWith(ControlPlaneHost.TenantAuthPrefix)
        if (!isAuth && !path.startsWith(ControlPlaneHost.TenantApiPrefix))
        {
            return false
        }
        // CSRF: every mutating /tenant-* request's Origin must be a configured tenant host (mirrors the operator /api/* rule),
        // checked once for the whole prefix so /tenant-auth mutating routes (e.g. the logout POST) are covered too.
        if (PlaneHttp.IsMutating(req) && !PlaneHttp.OriginInHosts(req, tenant.allowedHosts))
        {
            req.resume()
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.BadOriginMessage })
            return true
        }
        if (isAuth)
        {
            return await tenant.endpoint.Handle(req, res, path)
        }
        const session = await tenant.gate.Principal(req)
        if (session === null)
        {
            req.resume()
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
            return true
        }
        return await tenant.api.Handle(req, res, path, session)
    }

    /** Returns false when the request does not match any API route (falls through to static). */
    private async RouteApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
    {
        const method = req.method ?? PlaneHttp.MethodGet
        if (path === ControlPlaneHost.PingPath && method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            return true
        }
        if (path === ControlPlaneHost.LoginPath && method === PlaneHttp.MethodPost)
        {
            await this.HandleLogin(req, res)
            return true
        }
        if (path === ControlPlaneHost.SessionPath && method === PlaneHttp.MethodGet)
        {
            const who = await this.Principal(req)
            if (who === null)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
            }
            else
            {
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { email: who.email })
            }
            return true
        }
        if (path === ControlPlaneHost.LogoutPath && method === PlaneHttp.MethodPost)
        {
            const token = SessionCookie.Read(req.headers[ControlPlaneHost.CookieHeader])
            if (token !== undefined)
            {
                await this.operator.Revoke(token)
            }
            res.setHeader(ControlPlaneHost.SetCookieHeader, SessionCookie.BuildClearing(this.secureCookie))
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            return true
        }
        if (path === ControlPlaneHost.TemplatesPath && method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, TemplateCatalog.All())
            return true
        }
        if (path === ControlPlaneHost.ManifestsPath)
        {
            return await this.RoutePublishManifest(req, res, method)
        }
        const mwm = ControlPlaneHost.ManifestWithdrawnPathPattern.exec(path)
        if (mwm !== null)
        {
            return await this.RouteManifestWithdrawn(req, res, method, mwm)
        }
        const agm = ControlPlaneHost.AgentPathPattern.exec(path)
        if (agm !== null)
        {
            return await this.RouteAgent(req, res, method, agm)
        }
        const rom = ControlPlaneHost.RolloutPathPattern.exec(path)
        if (rom !== null)
        {
            return await this.RouteRollout(req, res, method, rom)
        }
        const hhm = ControlPlaneHost.HiveHealthPathPattern.exec(path)
        if (hhm !== null)
        {
            return await this.RouteHiveHealth(res, method, hhm)
        }
        const plm = ControlPlaneHost.PlatformPathPattern.exec(path)
        if (plm !== null)
        {
            return await this.RoutePlatform(req, res, method, plm)
        }
        if (path === ControlPlaneHost.EnvironmentsPath)
        {
            if (method === PlaneHttp.MethodGet)
            {
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, (await this.service.ListReconciled()).map(r => ControlPlaneHost.ToDto(r)))
                return true
            }
            if (method === PlaneHttp.MethodPost)
            {
                await this.HandleCreate(req, res)
                return true
            }
            return false
        }
        const am = ControlPlaneHost.AdminPathPattern.exec(path)
        if (am !== null)
        {
            return await this.RouteAdmin(req, res, method, am)
        }
        const tm = ControlPlaneHost.MakerTokenPathPattern.exec(path)
        if (tm !== null)
        {
            return await this.RouteMakerToken(req, res, method, tm)
        }
        const rm = ControlPlaneHost.AppReaderPathPattern.exec(path)
        if (rm !== null)
        {
            return await this.RouteAppReaderGrant(res, method, rm)
        }
        const pm = ControlPlaneHost.PromotePathPattern.exec(path)
        if (pm !== null)
        {
            return await this.RoutePromote(req, res, method, pm)
        }
        const lm = ControlPlaneHost.LoadedGraphPathPattern.exec(path)
        if (lm !== null)
        {
            return await this.RouteLoadedGraph(res, method, lm)
        }
        const gm = ControlPlaneHost.GraphPathPattern.exec(path)
        if (gm !== null)
        {
            return await this.RouteGraphs(req, res, method, gm)
        }
        const m = ControlPlaneHost.EnvPathPattern.exec(path)
        if (m === null)
        {
            return false
        }
        const name = ControlPlaneHost.Decode(m[1] as string)
        if (name === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        const action = m[2]
        if (action === ControlPlaneHost.StartAction && method === PlaneHttp.MethodPost)
        {
            const rec = await this.service.Start(name)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, ControlPlaneHost.ToDto(rec))
            this.Broadcast(ControlPlaneHost.Changed())
            return true
        }
        if (action === ControlPlaneHost.StopAction && method === PlaneHttp.MethodPost)
        {
            const rec = await this.service.Stop(name)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, ControlPlaneHost.ToDto(rec))
            this.Broadcast(ControlPlaneHost.Changed())
            return true
        }
        if (action === ControlPlaneHost.LogsAction && method === PlaneHttp.MethodGet)
        {
            const logs = await this.service.Logs(name)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { logs })
            return true
        }
        if (action === undefined && method === PlaneHttp.MethodDelete)
        {
            await this.service.Delete(name)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            this.Broadcast(ControlPlaneHost.Changed())
            return true
        }
        return false
    }

    /** Dispatches /api/(clients|tenants|hives)[/ID]; false when the (resource, method) combination is unknown. */
    private async RoutePlatform(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        const resource = m[1] as string
        if (m[2] === undefined)
        {
            if (method === PlaneHttp.MethodGet)
            {
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, this.ListPlatform(resource))
                return true
            }
            if (method === PlaneHttp.MethodPost)
            {
                await this.HandleCreatePlatform(resource, req, res)
                return true
            }
            return false
        }
        const id = ControlPlaneHost.Decode(m[2])
        if (id === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        if (method === PlaneHttp.MethodGet)
        {
            const record = this.GetPlatform(resource, id)
            if (record === undefined)
            {
                PlaneHttp.WriteNotFound(res)
            }
            else
            {
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, record)
            }
            return true
        }
        if (method === PlaneHttp.MethodDelete)
        {
            await this.DeletePlatform(resource, id)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            return true
        }
        return false
    }

    /** Serves GET /api/hives/ID/health: live workload health for each environment bound to the hive; false for any other method. */
    private async RouteHiveHealth(res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        if (method !== PlaneHttp.MethodGet)
        {
            return false
        }
        const id = ControlPlaneHost.Decode(m[1] as string)
        if (id === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        const hive = this.directory.GetHive(id)
        if (hive === undefined)
        {
            PlaneHttp.WriteNotFound(res)
            return true
        }
        const producer = new HiveHealthProducer(this.service, this.orchestrators, new EnvironmentPlacement(this.directory))
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await producer.Produce(hive))
        return true
    }

    /** Serves POST /api/manifests: publishes a version/image pair; false for any other method. */
    private async RoutePublishManifest(req: IncomingMessage, res: ServerResponse, method: string): Promise<boolean>
    {
        if (method !== PlaneHttp.MethodPost)
        {
            return false
        }
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return true
        }
        if (!ControlPlaneHost.NonEmpty(body.version))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.VersionRequiredMessage })
            return true
        }
        if (!ControlPlaneHost.NonEmpty(body.image))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ImageRequiredMessage })
            return true
        }
        if (!ControlPlaneHost.OptionalString(body.notes))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.NotesInvalidMessage })
            return true
        }
        const manifest: ManifestDto = await this.deployments.Publish(body.version as string, body.image as string, body.notes as string | undefined)
        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, manifest)
        return true
    }

    /** Serves POST /api/manifests/:version/withdrawn (withdraw) and DELETE (restore); 404 for an unknown version, false for any other method. */
    private async RouteManifestWithdrawn(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        const withdraw = method === PlaneHttp.MethodPost
        if (!withdraw && method !== PlaneHttp.MethodDelete)
        {
            return false
        }
        const version = decodeURIComponent(m[1] as string)
        const manifest: ManifestDto = await this.deployments.SetWithdrawn(version, withdraw)
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, manifest)
        return true
    }

    /** Dispatches /api/(tenants|hives)/ID/(manifests|gating[/VERSION]|target|rollout|rollout-registration); false for an unknown (resource, sub, method) combination. */
    private async RouteRollout(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        const resource = m[1] as string
        const sub = m[3] as string
        const tail = m[4]
        const known = resource === ControlPlaneHost.TenantsSegment
            ? sub === ControlPlaneHost.ManifestsSegment || sub === ControlPlaneHost.GatingSegment
            : sub === ControlPlaneHost.TargetSegment || sub === ControlPlaneHost.RolloutSegment || sub === ControlPlaneHost.RolloutRegistrationSegment
        if (!known || (tail !== undefined && sub !== ControlPlaneHost.GatingSegment))
        {
            return false
        }
        const id = ControlPlaneHost.Decode(m[2] as string)
        const version = tail === undefined ? undefined : ControlPlaneHost.Decode(tail)
        if (id === undefined || (tail !== undefined && version === undefined))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        if (sub === ControlPlaneHost.ManifestsSegment && method === PlaneHttp.MethodGet)
        {
            const manifests: ManifestDto[] = [...this.deployments.ManifestsFor(id)]
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, manifests)
            return true
        }
        if (sub === ControlPlaneHost.GatingSegment && tail === undefined && method === PlaneHttp.MethodPost)
        {
            const requested = await this.ReadVersion(req, res)
            if (requested === undefined)
            {
                return true
            }
            await this.deployments.Gate(id, requested)
            res.writeHead(ControlPlaneHost.StatusNoContent)
            res.end()
            return true
        }
        if (sub === ControlPlaneHost.GatingSegment && version !== undefined && method === PlaneHttp.MethodDelete)
        {
            await this.deployments.Ungate(id, version)
            res.writeHead(ControlPlaneHost.StatusNoContent)
            res.end()
            return true
        }
        if (sub === ControlPlaneHost.TargetSegment && method === PlaneHttp.MethodPost)
        {
            const requested = await this.ReadVersion(req, res)
            if (requested === undefined)
            {
                return true
            }
            // Records the selection and pushes it to the hive's environments; an unreachable backend leaves it for the pull agent.
            await this.deployments.SelectTarget(id, requested)
            res.writeHead(ControlPlaneHost.StatusNoContent)
            res.end()
            return true
        }
        if (sub === ControlPlaneHost.RolloutSegment && method === PlaneHttp.MethodGet)
        {
            const status: HiveRolloutDto = this.deployments.StatusFor(id)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, status)
            return true
        }
        if (sub === ControlPlaneHost.RolloutRegistrationSegment && method === PlaneHttp.MethodPost)
        {
            if (this.directory.GetHive(id) === undefined)
            {
                PlaneHttp.WriteNotFound(res)
                return true
            }
            // The one-time reveal: the raw agent token appears in this response body only; the registry stores just its hash.
            const dto: RolloutRegistrationDto = { token: await this.deployments.RegisterHive(id) }
            res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, dto)
            return true
        }
        return false
    }

    /** Machine-credential routes for the in-cluster pull agent: the per-hive bearer is verified before anything else; a bad one throws AgentUnauthorizedError (401). */
    private async RouteAgent(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        const sub = m[2] as string
        const isTarget = sub === ControlPlaneHost.TargetSegment && method === PlaneHttp.MethodGet
        const isReport = sub === ControlPlaneHost.ReportSegment && method === PlaneHttp.MethodPost
        if (!isTarget && !isReport)
        {
            // A matched agent path skipped the session gate, so a wrong method is answered here (401), never left to fall through to static serving.
            req.resume()
            throw new AgentUnauthorizedError(m[1] as string)
        }
        const id = ControlPlaneHost.Decode(m[1] as string)
        if (id === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        const bearer = ControlPlaneHost.BearerToken(req)
        if (bearer === undefined)
        {
            req.resume()
            throw new AgentUnauthorizedError(id)
        }
        await this.deployments.VerifyAgentToken(id, bearer)
        if (isTarget)
        {
            const target = this.deployments.TargetFor(id)
            if (target === undefined)
            {
                PlaneHttp.WriteNotFound(res)
                return true
            }
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { version: target.version, image: target.image })
            return true
        }
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return true
        }
        if (typeof body.environmentName !== 'string' || body.environmentName.length === 0 || typeof body.runningImage !== 'string' || typeof body.ready !== 'boolean')
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ReportInvalidMessage })
            return true
        }
        await this.deployments.Report(id, body.environmentName, body.runningImage, body.ready)
        res.writeHead(ControlPlaneHost.StatusNoContent)
        res.end()
        return true
    }

    /** The token from a well-formed "Authorization: Bearer <token>" header, else undefined. */
    private static BearerToken(req: IncomingMessage): string | undefined
    {
        const header = req.headers[ControlPlaneHost.AuthorizationHeader]
        const m = typeof header === 'string' ? ControlPlaneHost.BearerPattern.exec(header) : null
        return m === null ? undefined : m[1]
    }

    private static IsAgentApi(path: string): boolean
    {
        return ControlPlaneHost.AgentPathPattern.test(path)
    }

    /** Reads the { version } body; writes the 400 and returns undefined when it is missing or invalid. */
    private async ReadVersion(req: IncomingMessage, res: ServerResponse): Promise<string | undefined>
    {
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return undefined
        }
        if (!ControlPlaneHost.NonEmpty(body.version))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.VersionRequiredMessage })
            return undefined
        }
        return body.version as string
    }

    private ListPlatform(resource: string): readonly (ClientDto | TenantDto | HiveDto)[]
    {
        switch (resource)
        {
            case ControlPlaneHost.ClientsSegment:
                return this.directory.ListClients()
            case ControlPlaneHost.TenantsSegment:
                return this.directory.ListTenants().map(t => ControlPlaneHost.ToTenantDto(t))
            default:
                return this.directory.ListHives()
        }
    }

    /** Projects a stored tenant to its HTTP shape, dropping the internal IdP refs (base URL, CA path, admin-token ref). */
    private static ToTenantDto(record: TenantRecord): TenantDto
    {
        return { id: record.id, clientId: record.clientId, displayName: record.displayName, createdAt: record.createdAt, ownerEmail: record.ownerEmail, ownerPrincipalId: record.ownerPrincipalId }
    }

    private GetPlatform(resource: string, id: string): ClientDto | TenantDto | HiveDto | undefined
    {
        switch (resource)
        {
            case ControlPlaneHost.ClientsSegment:
                return this.directory.GetClient(id)
            case ControlPlaneHost.TenantsSegment:
            {
                const tenant = this.directory.GetTenant(id)
                return tenant === undefined ? undefined : ControlPlaneHost.ToTenantDto(tenant)
            }
            default:
                return this.directory.GetHive(id)
        }
    }

    private async DeletePlatform(resource: string, id: string): Promise<void>
    {
        switch (resource)
        {
            case ControlPlaneHost.ClientsSegment:
                await this.directory.DeleteClient(id)
                break
            case ControlPlaneHost.TenantsSegment:
                await this.directory.DeleteTenant(id)
                break
            default:
                await this.directory.DeleteHive(id)
                break
        }
    }

    private async HandleCreatePlatform(resource: string, req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return
        }
        if (!ControlPlaneHost.NonEmpty(body.id))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.IdRequiredMessage })
            return
        }
        if (typeof body.displayName !== 'string')
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.DisplayNameRequiredMessage })
            return
        }
        const id = body.id as string
        const displayName = body.displayName
        let created: ClientDto | TenantDto | HiveDto
        if (resource === ControlPlaneHost.ClientsSegment)
        {
            if (!ControlPlaneHost.OptionalString(body.subscriptionRef))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OptionalStringMessage })
                return
            }
            created = await this.directory.CreateClient({ id, displayName, subscriptionRef: body.subscriptionRef as string | undefined })
        }
        else if (resource === ControlPlaneHost.TenantsSegment)
        {
            if (!ControlPlaneHost.NonEmpty(body.clientId))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ClientIdRequiredMessage })
                return
            }
            if (!ControlPlaneHost.NonEmpty(body.ownerEmail))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OwnerEmailRequiredMessage })
                return
            }
            if (id.startsWith(ControlPlaneHost.ReservedIdPrefix))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ReservedIdMessage })
                return
            }
            const { record, ownerPassword } = await this.provisioning.Provision({ id, clientId: body.clientId as string, displayName, ownerEmail: body.ownerEmail as string })
            // The one-time Owner password is revealed exactly once here; never logged or stored.
            res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, { ...ControlPlaneHost.ToTenantDto(record), owner: { email: record.ownerEmail, principalId: record.ownerPrincipalId, password: ownerPassword } })
            return
        }
        else
        {
            if (!ControlPlaneHost.NonEmpty(body.tenantId))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.TenantIdRequiredMessage })
                return
            }
            const cluster = ControlPlaneHost.ParseCluster(body.cluster)
            if (cluster === undefined)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ClusterInvalidMessage + Object.values(HiveBackend).join(', ') })
                return
            }
            const registry = ControlPlaneHost.ParseRegistry(body.registry)
            if (registry === undefined)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.RegistryInvalidMessage + Object.values(InfraMode).join(', ') })
                return
            }
            if (!ControlPlaneHost.OptionalString(body.trustRootRef))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OptionalStringMessage })
                return
            }
            created = await this.directory.CreateHive({
                id,
                tenantId: body.tenantId as string,
                displayName,
                cluster,
                registry,
                trustRootRef: body.trustRootRef as string | undefined
            })
        }
        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, created)
    }

    private static OptionalString(v: unknown): boolean
    {
        return v === undefined || typeof v === 'string'
    }

    private static ParseCluster(v: unknown): ClusterSpec | undefined
    {
        if (v === null || typeof v !== 'object')
        {
            return undefined
        }
        const c = v as Record<string, unknown>
        if (!(Object.values(HiveBackend) as unknown[]).includes(c.backend) || !(Object.values(InfraMode) as unknown[]).includes(c.mode) || !ControlPlaneHost.OptionalString(c.configRef))
        {
            return undefined
        }
        return { backend: c.backend as HiveBackend, mode: c.mode as InfraMode, configRef: c.configRef as string | undefined }
    }

    private static ParseRegistry(v: unknown): RegistrySpec | undefined
    {
        if (v === null || typeof v !== 'object')
        {
            return undefined
        }
        const r = v as Record<string, unknown>
        if (!(Object.values(InfraMode) as unknown[]).includes(r.mode) || !ControlPlaneHost.OptionalString(r.endpoint) || !ControlPlaneHost.OptionalString(r.credentialRef))
        {
            return undefined
        }
        return { mode: r.mode as InfraMode, endpoint: r.endpoint as string | undefined, credentialRef: r.credentialRef as string | undefined }
    }

    /** Dispatches POST /api/environments/NAME/maker-token; false (unknown route) for any other method. */
    private async RouteMakerToken(_req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        if (method !== PlaneHttp.MethodPost)
        {
            return false
        }
        const name = ControlPlaneHost.Decode(m[1] as string)
        if (name === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        await this.HandleIssueMakerToken(res, name)
        return true
    }

    /** Mints a maker token; the secret is returned once in the response body and never logged. */
    private async HandleIssueMakerToken(res: ServerResponse, name: string): Promise<void>
    {
        const issued = await this.service.AdminIssueMakerToken(name)
        const dto: MakerTokenDto = { token: issued.token, principalId: issued.principalId, expiresAt: issued.expiresAt }
        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, dto)
    }

    /** Dispatches POST /api/environments/NAME/app-reader-grant; false (unknown route) for any other method. */
    private async RouteAppReaderGrant(res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        if (method !== PlaneHttp.MethodPost)
        {
            return false
        }
        const name = ControlPlaneHost.Decode(m[1] as string)
        if (name === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        // Grants the well-known app-reader principal a read role on the runtime; no token or secret is minted or returned.
        await this.service.AdminGrantAppReader(name)
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
        return true
    }

    /** Relays POST /api/environments/SOURCE/graphs/GRAPH/promote into the runtime target; false for any other method. */
    private async RoutePromote(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        if (method !== PlaneHttp.MethodPost)
        {
            return false
        }
        const env = ControlPlaneHost.Decode(m[1] as string)
        const graph = ControlPlaneHost.Decode(m[2] as string)
        if (env === undefined || graph === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return true
        }
        if (!ControlPlaneHost.NonEmpty(body.targetEnv))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.TargetEnvRequiredMessage })
            return true
        }
        const dto = await this.graphService.Promote(env, graph, body.targetEnv as string)
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, dto)
        return true
    }

    /** Serves GET /api/environments/RUNTIME/loaded-graph (the promoted-graph manifest, or JSON null); false for any other method. */
    private async RouteLoadedGraph(res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        if (method !== PlaneHttp.MethodGet)
        {
            return false
        }
        const env = ControlPlaneHost.Decode(m[1] as string)
        if (env === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.graphService.GetLoaded(env))
        return true
    }

    /** Dispatches /api/environments/NAME/graphs[/GRAPH]; false when the (graph, method) combination is unknown. */
    private async RouteGraphs(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        const env = ControlPlaneHost.Decode(m[1] as string)
        if (env === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        if (m[2] === undefined)
        {
            if (method === PlaneHttp.MethodGet)
            {
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.graphService.List(env))
                return true
            }
            if (method === PlaneHttp.MethodPost)
            {
                await this.HandleCreateGraph(env, req, res)
                return true
            }
            return false
        }
        const graph = ControlPlaneHost.Decode(m[2])
        if (graph === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        if (method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.graphService.Get(env, graph))
            return true
        }
        if (method === PlaneHttp.MethodDelete)
        {
            await this.graphService.Delete(env, graph)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            return true
        }
        return false
    }

    private async HandleCreateGraph(env: string, req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return
        }
        if (!ControlPlaneHost.NonEmpty(body.name))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.NameRequiredMessage })
            return
        }
        if (!ControlPlaneHost.NonEmpty(body.description))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.DescriptionRequiredMessage })
            return
        }
        const rec = await this.graphService.Create(env, body.name as string, body.description as string)
        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, rec)
    }

    /** Dispatches /api/environments/NAME/admin/SUB[/TAIL]; false when the (sub, method, tail) combination is unknown. */
    private async RouteAdmin(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        const name = ControlPlaneHost.Decode(m[1] as string)
        if (name === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        const sub = m[2]
        const tail = m[3]
        if (sub === ControlPlaneHost.SnapshotPath && tail === undefined && method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.service.AdminSnapshot(name))
            return true
        }
        if (sub === ControlPlaneHost.ConfigPath && tail === undefined && method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.service.AdminGetConfig(name))
            return true
        }
        if (sub === ControlPlaneHost.SecurityModelPath && tail === undefined && method === PlaneHttp.MethodGet)
        {
            // JSON null (not undefined) so the body is always valid JSON when no model is stored.
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.service.AdminGetSecurityModel(name) ?? null)
            return true
        }
        if (sub === ControlPlaneHost.AccountsPath && tail !== undefined && method === PlaneHttp.MethodDelete)
        {
            const principalId = ControlPlaneHost.Decode(tail)
            if (principalId === undefined)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
                return true
            }
            await this.service.AdminDisableAccount(name, principalId)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            return true
        }
        if (tail !== undefined)
        {
            return false
        }
        if (sub === ControlPlaneHost.AccountsPath && method === PlaneHttp.MethodPost)
        {
            const body = await this.ReadJsonObject(req, res)
            if (body === undefined)
            {
                return true
            }
            if (!ControlPlaneHost.NonEmpty(body.email) || !ControlPlaneHost.NonEmpty(body.principalId) || !ControlPlaneHost.NonEmpty(body.password))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.AccountFieldsMessage })
                return true
            }
            const account = { email: body.email, principalId: body.principalId, password: body.password } as unknown as CreateAccountParams
            await this.service.AdminCreateAccount(name, account)
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, { ok: true })
            return true
        }
        if (sub === ControlPlaneHost.GrantsPath && (method === PlaneHttp.MethodPost || method === PlaneHttp.MethodDelete))
        {
            const body = await this.ReadJsonObject(req, res)
            if (body === undefined)
            {
                return true
            }
            if (typeof body.subject !== 'string' || typeof body.role !== 'string')
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.GrantFieldsMessage })
                return true
            }
            const mutation = {
                subject: body.subject,
                role: body.role,
                resourceKind: body.resourceKind,
                resourcePath: body.resourcePath
            } as unknown as GrantMutationDto
            if (method === PlaneHttp.MethodPost)
            {
                await this.service.AdminGrantRole(name, mutation)
            }
            else
            {
                await this.service.AdminRevokeRole(name, mutation)
            }
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            return true
        }
        if (sub === ControlPlaneHost.SecurityModelPath && method === PlaneHttp.MethodPut)
        {
            const body = await this.ReadJsonObject(req, res)
            if (body === undefined)
            {
                return true
            }
            if (typeof body.securityModel !== 'object' || body.securityModel === null)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.SecurityModelFieldMessage })
                return true
            }
            await this.service.AdminSetSecurityModel(name, body.securityModel as SecurityModelDto)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            return true
        }
        if (sub === ControlPlaneHost.ConfigPath && method === PlaneHttp.MethodPut)
        {
            const body = await this.ReadJsonObject(req, res)
            if (body === undefined)
            {
                return true
            }
            if (typeof body.packId !== 'string' || typeof body.delegationDepth !== 'string')
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ConfigFieldsMessage })
                return true
            }
            const config = {
                packId: body.packId,
                delegationDepth: body.delegationDepth,
                providerSettings: body.providerSettings,
                groupRoleMap: body.groupRoleMap,
                claimsMapping: body.claimsMapping,
                securityModel: body.securityModel
            } as unknown as IdentityConfigDto
            await this.service.AdminSetConfig(name, config)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            return true
        }
        return false
    }

    /** Reads and parses a JSON object body; writes the 400 and returns undefined when it is not one. */
    private async ReadJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined>
    {
        const raw = await this.ReadBody(req)
        let body: unknown
        try
        {
            body = JSON.parse(raw)
        }
        catch
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadJsonMessage })
            return undefined
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BodyObjectMessage })
            return undefined
        }
        return body as Record<string, unknown>
    }

    private async HandleLogin(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const raw = await this.ReadBody(req)
        let body: LoginBody
        try
        {
            body = JSON.parse(raw) as LoginBody
        }
        catch
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadJsonMessage })
            return
        }
        if (body === null || typeof body !== 'object' || typeof body.email !== 'string' || typeof body.password !== 'string')
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.CredentialsRequiredMessage })
            return
        }
        const session = await this.operator.Authenticate(body.email, body.password)
        if (session === null)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.InvalidCredentialsMessage })
            return
        }
        res.setHeader(ControlPlaneHost.SetCookieHeader, SessionCookie.Build(session.token, session.expiresAt, this.secureCookie))
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { email: body.email })
    }

    private async Principal(req: IncomingMessage): Promise<{ email: string } | null>
    {
        const token = SessionCookie.Read(req.headers[ControlPlaneHost.CookieHeader])
        return token === undefined || token.length === 0 ? null : await this.operator.ValidateToken(token)
    }

    private async Authenticated(req: IncomingMessage): Promise<boolean>
    {
        return (await this.Principal(req)) !== null
    }

    private async HandleCreate(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const raw = await this.ReadBody(req)
        let body: CreateBody
        try
        {
            body = JSON.parse(raw) as CreateBody
        }
        catch
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadJsonMessage })
            return
        }
        const valid = Object.values(Template) as string[]
        if (body === null || typeof body !== 'object' || typeof body.name !== 'string' || body.name.length === 0)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.NameRequiredMessage })
            return
        }
        if (typeof body.template !== 'string' || !valid.includes(body.template))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.TemplateInvalidMessage + valid.join(', ') })
            return
        }
        const validTypes = Object.values(EnvType) as string[]
        if (typeof body.type !== 'string' || !validTypes.includes(body.type))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.TypeInvalidMessage + validTypes.join(', ') })
            return
        }
        let hostPort: number | undefined
        if (body.hostPort !== undefined)
        {
            if (typeof body.hostPort !== 'number' || !Number.isInteger(body.hostPort) || body.hostPort < 1 || body.hostPort > ControlPlaneHost.MaxPort)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.HostPortInvalidMessage })
                return
            }
            hostPort = body.hostPort
        }
        if (body.hiveId !== undefined && (typeof body.hiveId !== 'string' || body.hiveId.length === 0))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.HiveIdInvalidMessage })
            return
        }
        const rec = await this.service.Create(body.name, body.template as Template, body.type as EnvType, hostPort, body.hiveId)
        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, ControlPlaneHost.ToDto(rec))
        this.Broadcast(ControlPlaneHost.Changed())
    }

    private ReadBody(req: IncomingMessage): Promise<string>
    {
        return new Promise((resolveBody, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on('data', (c: Buffer) =>
            {
                size += c.length
                if (size > ControlPlaneHost.MaxBodyBytes)
                {
                    tooLarge = true
                    return
                }
                chunks.push(c)
            })
            req.on('end', () =>
            {
                if (tooLarge)
                {
                    reject(new BodyTooLargeError(ControlPlaneHost.TooLargeMessage))
                    return
                }
                resolveBody(Buffer.concat(chunks).toString(ControlPlaneHost.Utf8))
            })
            req.on('error', reject)
        })
    }

    /** The bundle root for this request: the tenant portal on a tenant host, otherwise the operator portal. */
    private StaticRootFor(req: IncomingMessage): string
    {
        if (this.tenantAuth !== undefined && this.tenantStaticRootAbs !== undefined && PlaneHttp.HostIn(req, this.tenantAuth.allowedHosts))
        {
            return this.tenantStaticRootAbs
        }
        return this.staticRootAbs
    }

    private WriteError(res: ServerResponse, err: unknown): void
    {
        if (res.headersSent)
        {
            res.end()
            return
        }
        if (err instanceof BodyTooLargeError)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusTooLarge, { error: ControlPlaneHost.TooLargeMessage })
            return
        }
        const status = this.StatusFor(err)
        if (status === undefined || status >= ControlPlaneHost.StatusInternal && status !== ControlPlaneHost.StatusUnavailable)
        {
            console.error(ControlPlaneHost.LogPrefix, err)
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusInternal, { error: ControlPlaneHost.OperationFailedMessage })
            return
        }
        if (err instanceof AdminProxyError && err.Kind === AdminProxyErrorKind.Connect)
        {
            console.error(ControlPlaneHost.LogPrefix, err)
            PlaneHttp.WriteJson(res, status, { error: ControlPlaneHost.ConnectUnavailableMessage })
            return
        }
        if (err instanceof ImageMissingError)
        {
            PlaneHttp.WriteJson(res, status, { error: err.message, buildCommand: err.buildCommand })
            return
        }
        PlaneHttp.WriteJson(res, status, { error: (err as Error).message })
    }

    private StatusFor(err: unknown): number | undefined
    {
        if (!(err instanceof Error))
        {
            return undefined
        }
        if (err instanceof AdminProxyError)
        {
            return ControlPlaneHost.AdminStatus(err)
        }
        return ControlPlaneHost.ErrorStatuses.get(err.constructor as ErrorCtor)
    }

    private static AdminStatus(err: AdminProxyError): number
    {
        switch (err.Kind)
        {
            case AdminProxyErrorKind.Connect:
                return ControlPlaneHost.StatusUnavailable
            case AdminProxyErrorKind.Rbac:
                return ControlPlaneHost.StatusConflict
            case AdminProxyErrorKind.Invalid:
                return ControlPlaneHost.StatusBadRequest
            default:
                return ControlPlaneHost.StatusInternal
        }
    }

    private static Decode(segment: string): string | undefined
    {
        try
        {
            return decodeURIComponent(segment)
        }
        catch
        {
            return undefined
        }
    }

    private static NonEmpty(v: unknown): boolean
    {
        return typeof v === 'string' && v.length > 0
    }

    private Broadcast(event: ChangedEvent): void
    {
        const text = JSON.stringify(event)
        for (const c of this.clients)
        {
            if (c.readyState === WebSocket.OPEN)
            {
                c.send(text)
            }
        }
    }

    /** Accepts a request whose host is an operator host OR (when a tenant plane is mounted) a configured tenant host.
     *  With no tenant plane this is exactly HostAllowed, so the operator surface is unchanged. */
    private HostAccepted(req: IncomingMessage): boolean
    {
        return ControlPlaneHost.HostAllowed(req)
            || (this.tenantAuth !== undefined && PlaneHttp.HostIn(req, this.tenantAuth.allowedHosts))
    }

    private static HostAllowed(req: IncomingMessage): boolean
    {
        return PlaneHttp.HostIn(req, ControlPlaneHost.AllowedHosts)
    }

    private static IsPublicApi(path: string): boolean
    {
        return path === ControlPlaneHost.PingPath || path === ControlPlaneHost.LoginPath || path === ControlPlaneHost.SessionPath
    }

    /** Absent Origin is allowed (non-browser / same-origin navigation); a present one must equal our own origin. */
    private static OriginAllowed(req: IncomingMessage): boolean
    {
        const origin = req.headers[PlaneHttp.OriginHeader]
        return origin === undefined || origin === ControlPlaneHost.HttpScheme + req.headers[PlaneHttp.HostHeader]
    }

    private static HasBody(req: IncomingMessage): boolean
    {
        if (req.method !== PlaneHttp.MethodPost && req.method !== PlaneHttp.MethodPut && req.method !== PlaneHttp.MethodDelete)
        {
            return false
        }
        const len = req.headers[ControlPlaneHost.ContentLengthHeader]
        return (len !== undefined && len !== '0') || req.headers[ControlPlaneHost.TransferEncodingHeader] !== undefined
    }

    private static IsJson(req: IncomingMessage): boolean
    {
        const type = req.headers[ControlPlaneHost.ContentTypeHeader] ?? ''
        return type.split(';')[0]!.trim().toLowerCase() === ControlPlaneHost.JsonMediaType
    }

    private static Changed(): ChangedEvent
    {
        return { type: ControlPlaneHost.ChangedType }
    }

    private static ToDto(r: EnvironmentRecord): EnvironmentDto
    {
        return EnvironmentDtoMapper.ToDto(r)
    }
}
