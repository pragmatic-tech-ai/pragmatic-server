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
import { EnvType, Template, type EnvironmentChange, type EnvironmentRecord } from './environment-record.js'
import { EnvironmentDtoMapper, type EnvironmentDto } from './environment-dto.js'
import type { HiveObservationRegistry } from './hive-observation-record.js'
import { InvalidTenantIdError } from './idp-service.js'
import { PortUnavailableError } from './port-allocator.js'
import type { TenantProvisioningService } from './tenant-provisioning-service.js'
import { InvalidEnvironmentNameError } from './template-catalog.js'
import { LastOperatorError, OperatorExistsError, OperatorNotFoundError, OperatorProtectedError, OperatorRole, OperatorSelfLockoutError, type IOperatorIdentity, type OperatorPrincipal } from './operator-identity.js'
import { OperatorAuthorization } from './operator-authorization.js'
import { Channel } from './channel.js'
import { SessionCookie } from './session-cookie.js'
import { EventsTicketStore } from './events-ticket-store.js'
import { OperatorSocketRegistry } from './operator-socket-registry.js'
import { AdminProxyError, AdminProxyErrorKind, type AdminSnapshot } from './admin-proxy.js'
import {
    ClientHasTenantsError,
    HiveHasEnvironmentsError,
    RecordExistsError,
    TenantHasHivesError,
    UnknownClientError,
    UnknownTenantError,
    type PlatformDirectory
} from './platform-directory.js'
import { HivePlacementError } from './hive-placement-error.js'
import { HiveBackend, InfraMode, InvalidRecordIdError } from './platform-records.js'
import { PlaneHttp } from './plane-http.js'
import { ProvisioningOrchestrator, ProvisionFailedError } from './provisioning-orchestrator.js'
import { UnsupportedBackendError } from './hive-orchestrator.js'
import { KubectlError } from './kubectl.js'
import type { HiveRolloutStatus, PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import type { ManifestRecord } from './manifest-record.js'
import { BodyTooLargeError, ChannelNotSubscribedError, HiveNotRegisteredError, ManifestExistsError, ManifestNotGatedError, ManifestWithdrawnError, PolicyStoreUnavailableError, TenantOnHoldError, UnknownHiveError, UnknownManifestError, VersionBelowFloorError } from './rollout-errors.js'
import type { ClientRecord, ClusterSpec, HiveRecord, RegistrySpec, TenantRecord } from './platform-records.js'
import type { CreateAccountParams, GraphLoadedDto, GrantMutationDto, IdentityConfigDto, SecurityModelDto, TokenIssuedDto, ServiceTokenSummaryDto, IssueTokenParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import { LoginThrottle } from './login-throttle.js'
import type { ILogProcess } from '../../environments/seed/docker.js'

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
    AdminListTokens(name: string): Promise<ServiceTokenSummaryDto[]>
    AdminIssueToken(name: string, params: IssueTokenParams): Promise<TokenIssuedDto>
    AdminRevokeToken(name: string, tokenRef: string): Promise<void>
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

export type FleetEnvDto = { name: string; ready: boolean; image?: string; detail: string }

export type FleetHiveDto = {
    id: string
    displayName: string
    tenant: { id: string; displayName: string } | null
    client: { id: string; displayName: string } | null
    clusterBackend: string
    clusterMode: string
    lastSeen: string | null
    environments: FleetEnvDto[]
}

export type ChangedEvent = { type: string }

type ErrorCtor = abstract new (...args: never[]) => Error
type LoginBody = { email?: unknown; password?: unknown }

export class ControlPlaneHost
{
    private static readonly LocalName = 'localhost'
    private static readonly HttpScheme = 'http://'
    private static readonly HttpsProto = 'https'
    private static readonly HttpsScheme = ControlPlaneHost.HttpsProto + '://'
    private static readonly ForwardedProtoHeader = 'x-forwarded-proto'
    private static readonly BaseUrl = ControlPlaneHost.HttpScheme + ControlPlaneHost.LocalName
    private static readonly PortSeparator = ':'
    private static readonly DefaultAllowedHosts: ReadonlySet<string> = new Set([ControlPlaneHost.LocalName, '127.0.0.1', '[::1]'])
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly NoStore = 'no-store'
    private static readonly JsonMediaType = 'application/json'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly TransferEncodingHeader = 'transfer-encoding'
    private static readonly StatusForbidden = 403
    private static readonly StatusUnsupported = 415
    private static readonly ForbiddenHostMessage = 'Host not allowed'
    private static readonly ForbiddenRoleMessage = 'Operator role does not permit this action'
    private static readonly OperatorsPath = '/api/operators'
    private static readonly OperatorRolePath = '/api/operators/role'
    private static readonly OperatorPasswordResetPath = '/api/operators/password-reset'
    private static readonly OperatorDisabledPath = '/api/operators/disabled'
    private static readonly OperatorRevokeSessionsPath = '/api/operators/revoke-sessions'
    private static readonly OperatorEmailMessage = 'email (non-empty string) is required'
    private static readonly OperatorRoleMessage = 'role (full|readonly) is required'
    private static readonly OperatorDisabledMessage = 'disabled (boolean) is required'
    private static readonly ProvisionPath = '/api/provision'
    private static readonly SubObjectRequiredMessage = 'client, tenant and hive (objects) are required'
    private static readonly MinOperatorPasswordLength = 12
    private static readonly EmailAt = '@'
    private static readonly OperatorFieldsMessage = 'a valid email, a password of at least ' + ControlPlaneHost.MinOperatorPasswordLength + ' characters and a role (full|readonly) are required'
    private static readonly RoleFullWire = 'full'
    private static readonly RoleReadOnlyWire = 'readonly'
    private static readonly OperatorRoles: ReadonlyMap<string, OperatorRole> = new Map([[ControlPlaneHost.RoleFullWire, OperatorRole.Full], [ControlPlaneHost.RoleReadOnlyWire, OperatorRole.ReadOnly]])
    private static readonly UnsupportedMediaMessage = 'Content-Type must be application/json'
    private static readonly BadNameMessage = 'Invalid environment name in path'
    private static readonly NotListeningMessage = 'ControlPlaneHost is not listening'
    private static readonly OperationFailedMessage = 'Environment operation failed'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly LogPrefix = '[control-plane] request failed:'
    private static readonly ApiPrefix = '/api/'
    private static readonly PingPath = '/api/ping'
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
    private static readonly RolloutSegment = 'rollout'
    private static readonly RolloutRegistrationSegment = 'rollout-registration'
    private static readonly RolloutPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + '(' + ControlPlaneHost.TenantsSegment + '|' + ControlPlaneHost.HivesSegment + ')/([^/]+)/(' +
        [ControlPlaneHost.ManifestsSegment, ControlPlaneHost.GatingSegment, ControlPlaneHost.RolloutSegment, ControlPlaneHost.RolloutRegistrationSegment].join('|') +
        ')(?:/([^/]+))?$')
    private static readonly PolicySegment = 'policy'
    private static readonly ChannelsSegment = 'channels'
    private static readonly MinVersionSegment = 'min-version'
    private static readonly HoldSegment = 'hold'
    private static readonly TenantPolicyPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.TenantsSegment + '/([^/]+)/' + ControlPlaneHost.PolicySegment + '/(' +
        [ControlPlaneHost.ChannelsSegment, ControlPlaneHost.MinVersionSegment, ControlPlaneHost.HoldSegment].join('|') + ')$')
    private static readonly VersionRequiredMessage = 'version (non-empty string) is required'
    private static readonly ImageRequiredMessage = 'image (non-empty string) is required'
    private static readonly NotesInvalidMessage = 'notes must be a string'
    private static readonly ChannelInvalidMessage = 'channel must be one of: stable, early'
    private static readonly ReasonRequiredMessage = 'reason (non-empty string) is required'
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
    private static RoleWire(role: OperatorRole): string
    {
        return role === OperatorRole.Full ? ControlPlaneHost.RoleFullWire : ControlPlaneHost.RoleReadOnlyWire
    }

    private static readonly SessionPath = '/api/session'
    private static readonly FleetPath = '/api/fleet'
    private static readonly GatingAllPath = '/api/gating'
    private static readonly PoliciesAllPath = '/api/policies'
    private static readonly SelectionsAllPath = '/api/selections'
    private static readonly RolloutsAllPath = '/api/rollouts'
    private static readonly EventsTicketPath = '/api/events-ticket'
    private static readonly ProtocolHeader = 'sec-websocket-protocol'
    private static readonly ProtocolSeparator = ','
    private static readonly RevalidateIntervalMs = 30_000
    private static readonly LogoutPath = OperatorAuthorization.LogoutPath
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly CookieHeader = 'cookie'
    private static readonly StatusUnauthorized = 401
    private static readonly StatusTooManyRequests = 429
    private static readonly RetryAfterHeader = 'retry-after'
    private static readonly ForwardedForHeader = 'x-forwarded-for'
    private static readonly ForwardedSeparator = ','
    private static readonly MsPerSecond = 1000
    private static readonly TooManyAttemptsMessage = 'Too many login attempts; try again later'
    private static readonly UnknownClientIp = ''
    private static readonly InvalidCredentialsMessage = 'Invalid email or password'
    private static readonly UnauthenticatedMessage = 'Authentication required'
    private static readonly BadOriginMessage = 'Origin not allowed'
    private static readonly CredentialsRequiredMessage = 'email and password (strings) are required'
    private static readonly GraphsSegment = 'graphs'
    private static readonly GraphPathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)/' + ControlPlaneHost.GraphsSegment + '(?:/([^/]+))?$')
    private static readonly PromoteSegment = 'promote'
    private static readonly PromotePathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)/' + ControlPlaneHost.GraphsSegment + '/([^/]+)/' + ControlPlaneHost.PromoteSegment + '$')
    private static readonly LoadedGraphSegment = 'loaded-graph'
    private static readonly LoadedGraphPathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)/' + ControlPlaneHost.LoadedGraphSegment + '$')
    private static readonly TargetEnvRequiredMessage = 'targetEnv (non-empty string) is required'
    private static readonly DescriptionRequiredMessage = 'description (string) is required'
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
    private static readonly ErrorStatuses: ReadonlyMap<ErrorCtor, number> = new Map<ErrorCtor, number>([
        [InvalidEnvironmentNameError, ControlPlaneHost.StatusBadRequest],
        [EnvironmentNotFoundError, PlaneHttp.StatusNotFound],
        [EnvironmentExistsError, ControlPlaneHost.StatusConflict],
        [OperatorExistsError, ControlPlaneHost.StatusConflict],
        [OperatorSelfLockoutError, ControlPlaneHost.StatusConflict],
        [LastOperatorError, ControlPlaneHost.StatusConflict],
        [OperatorProtectedError, ControlPlaneHost.StatusConflict],
        [OperatorNotFoundError, PlaneHttp.StatusNotFound],
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
        // Release-policy refusals: state conflicts are 409; a channel the tenant is not subscribed to is forbidden; an unreadable policy store fails closed as 500.
        [ManifestWithdrawnError, ControlPlaneHost.StatusConflict],
        [TenantOnHoldError, ControlPlaneHost.StatusConflict],
        [ChannelNotSubscribedError, ControlPlaneHost.StatusForbidden],
        [VersionBelowFloorError, ControlPlaneHost.StatusConflict],
        [PolicyStoreUnavailableError, ControlPlaneHost.StatusInternal],
        [ManifestExistsError, ControlPlaneHost.StatusConflict],
        [HiveNotRegisteredError, PlaneHttp.StatusNotFound],
        [UnknownHiveError, PlaneHttp.StatusNotFound],
    ])

    private httpServer: HttpServer | undefined
    private wsServer: WebSocketServer | undefined
    private changeSubscription: (() => void) | undefined
    private revalidating = false
    private revalidateTimer: ReturnType<typeof setInterval> | undefined
    private readonly staticRootAbs: string
    private readonly allowedHosts: ReadonlySet<string>
    private readonly orchestrator: ProvisioningOrchestrator

    public constructor(
        private readonly service: IEnvironmentService,
        private readonly graphService: IGraphService,
        staticRoot: string,
        private readonly operator: IOperatorIdentity,
        private readonly secureCookie: boolean,
        private readonly directory: PlatformDirectory,
        private readonly deployments: PlatformDeploymentRegistry,
        private readonly provisioning: TenantProvisioningService,
        private readonly observations: HiveObservationRegistry,
        private readonly loginThrottle: LoginThrottle = new LoginThrottle(),
        private readonly trustedProxy: boolean = false,
        private readonly ticketStore: EventsTicketStore = new EventsTicketStore(),
        private readonly registry: OperatorSocketRegistry<WebSocket> = new OperatorSocketRegistry<WebSocket>(),
        private readonly revalidateIntervalMs: number = ControlPlaneHost.RevalidateIntervalMs,
        allowedHosts: readonly string[] = [],
        private readonly authorization: OperatorAuthorization = new OperatorAuthorization())
    {
        this.allowedHosts = new Set([...ControlPlaneHost.DefaultAllowedHosts, ...allowedHosts.map(h => h.toLowerCase())])
        this.staticRootAbs = resolve(staticRoot)
        this.orchestrator = new ProvisioningOrchestrator(this.directory, this.provisioning, this.deployments)
    }

    public Listen(port: number, host: string): Promise<void>
    {
        const wss = new WebSocketServer({ noServer: true, handleProtocols: ControlPlaneHost.SelectProtocol })
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
        this.StartRevalidation()
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

    /** Accepts the single offered subprotocol (the ticket); false rejects negotiation when none is offered. */
    private static SelectProtocol(protocols: Set<string>): string | false
    {
        const first = protocols.values().next()
        return first.done === true ? false : first.value
    }

    /** Dispatches a ws upgrade. Only the operator `/api/events` branch exists; any other path destroys the socket. */
    private RouteUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void
    {
        const path = new URL(req.url ?? PlaneHttp.RootPath, ControlPlaneHost.BaseUrl).pathname
        if (path === ControlPlaneHost.EventsPath)
        {
            this.UpgradeOperatorEvents(req, socket, head, wss)
            return
        }
        socket.destroy()
    }

    /** The operator events ws: operator host + operator origin + a single-use ticket (the subprotocol), then tracked per session in the registry. */
    private UpgradeOperatorEvents(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void
    {
        if (!this.HostAllowed(req) || !this.OriginAllowed(req))
        {
            socket.destroy()
            return
        }
        const ticket = ControlPlaneHost.SingleProtocol(req)
        const token = ticket === undefined ? null : this.ticketStore.Redeem(ticket)
        if (token === null)
        {
            socket.destroy()
            return
        }
        void this.operator.ValidateToken(token).then(principal =>
        {
            if (principal === null)
            {
                socket.destroy()
                return
            }
            wss.handleUpgrade(req, socket, head, ws =>
            {
                // Re-check inside the handshake: a logout that ran after Redeem would otherwise find no socket to close.
                void this.AdmitClient(token, ws)
            })
        }, () => socket.destroy())
    }

    /** The lone Sec-WebSocket-Protocol value (the ticket), or undefined when absent, empty or multi-valued. */
    private static SingleProtocol(req: IncomingMessage): string | undefined
    {
        const raw = req.headers[ControlPlaneHost.ProtocolHeader]
        if (typeof raw !== 'string')
        {
            return undefined
        }
        const value = raw.trim()
        return value.length === 0 || value.includes(ControlPlaneHost.ProtocolSeparator) ? undefined : value
    }

    private async AdmitClient(token: string, ws: WebSocket): Promise<void>
    {
        // Attached synchronously, before any await: an error mid-validation must not surface as an unhandled event.
        ws.on(ControlPlaneHost.ErrorEvent, () => ws.terminate())
        let valid = false
        try
        {
            valid = (await this.operator.ValidateToken(token)) !== null
        }
        catch
        {
            valid = false
        }
        if (!valid || ws.readyState !== WebSocket.OPEN)
        {
            ws.terminate()
            return
        }
        this.AddClient(token, ws)
        ws.on(ControlPlaneHost.CloseEvent, () => this.OnClientGone())
    }

    /** Tracks an operator ws client; the first one subscribes to environment lifecycle changes (made on any plane) to push them. */
    private AddClient(token: string, ws: WebSocket): void
    {
        this.registry.Add(token, ws)
        if (this.changeSubscription === undefined)
        {
            this.changeSubscription = this.service.OnChanged(() => this.Broadcast(ControlPlaneHost.Changed()))
        }
    }

    private OnClientGone(): void
    {
        if (this.registry.Size() === 0)
        {
            this.ReleaseChangeSubscription()
        }
    }

    /** Periodically closes sockets whose session token no longer validates (expired or revoked elsewhere). */
    private StartRevalidation(): void
    {
        if (this.revalidateTimer !== undefined)
        {
            clearInterval(this.revalidateTimer)
        }
        this.revalidateTimer = setInterval(() => { void this.RevalidateSockets() }, this.revalidateIntervalMs)
        this.revalidateTimer.unref()
    }

    private async RevalidateSockets(): Promise<void>
    {
        if (this.revalidating)
        {
            return
        }
        this.revalidating = true
        try
        {
            for (const token of this.registry.Tokens())
            {
                try
                {
                    if ((await this.operator.ValidateToken(token)) === null)
                    {
                        this.registry.CloseToken(token)
                    }
                }
                catch
                {
                    // a transient validation failure must not kill the sweep; retry next tick
                }
            }
        }
        finally
        {
            this.revalidating = false
        }
    }

    private ReleaseChangeSubscription(): void
    {
        this.changeSubscription?.()
        this.changeSubscription = undefined
    }

    public async Close(): Promise<void>
    {
        if (this.revalidateTimer !== undefined)
        {
            clearInterval(this.revalidateTimer)
            this.revalidateTimer = undefined
        }
        for (const c of [...this.registry.All()])
        {
            c.terminate()
        }
        this.registry.Clear()
        this.ReleaseChangeSubscription()
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
            if (!this.HostAllowed(req))
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
            if (path.startsWith(ControlPlaneHost.ApiPrefix))
            {
                if (PlaneHttp.IsMutating(req) && !this.OriginAllowed(req))
                {
                    req.resume()
                    PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.BadOriginMessage })
                    return
                }
                if (!ControlPlaneHost.IsPublicApi(path))
                {
                    const who = await this.Principal(req)
                    if (who === null)
                    {
                        req.resume()
                        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
                        return
                    }
                    if (!this.authorization.Authorize(who.role, req.method ?? PlaneHttp.MethodGet, path))
                    {
                        req.resume()
                        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.ForbiddenRoleMessage })
                        return
                    }
                }
            }
            const handled = await this.RouteApi(req, res, path)
            if (!handled)
            {
                await PlaneHttp.ServeStatic(req, res, path, this.staticRootAbs)
            }
        }
        catch (err)
        {
            this.WriteError(res, err)
        }
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
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { email: who.email, principalId: who.principalId, role: ControlPlaneHost.RoleWire(who.role) })
            }
            return true
        }
        if (path === ControlPlaneHost.EventsTicketPath && method === PlaneHttp.MethodGet)
        {
            const token = SessionCookie.Read(req.headers[ControlPlaneHost.CookieHeader])
            if (!this.OriginAllowed(req))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.BadOriginMessage })
            }
            else if (token === undefined || token.length === 0 || (await this.operator.ValidateToken(token)) === null)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
            }
            else
            {
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ticket: this.ticketStore.Mint(token) })
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
            if (token !== undefined)
            {
                this.registry.CloseToken(token)
            }
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true })
            return true
        }
        if (path === ControlPlaneHost.OperatorsPath && method === PlaneHttp.MethodGet)
        {
            const roster = await this.operator.ListOperators()
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, roster.map(o => ({ email: o.email, role: ControlPlaneHost.RoleWire(o.role), disabled: o.disabled })))
            return true
        }
        if (path === ControlPlaneHost.OperatorsPath && method === PlaneHttp.MethodPost)
        {
            await this.HandleCreateOperator(req, res)
            return true
        }
        if (method === PlaneHttp.MethodPost && ControlPlaneHost.IsOperatorMutationPath(path))
        {
            await this.HandleOperatorMutation(path, req, res)
            return true
        }
        if (path === ControlPlaneHost.ProvisionPath && method === PlaneHttp.MethodPost)
        {
            await this.HandleProvision(req, res)
            return true
        }
        if (path === ControlPlaneHost.ManifestsPath)
        {
            if (method === PlaneHttp.MethodGet)
            {
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, [...this.deployments.AllManifests()])
                return true
            }
            return await this.RoutePublishManifest(req, res, method)
        }
        const mwm = ControlPlaneHost.ManifestWithdrawnPathPattern.exec(path)
        if (mwm !== null)
        {
            return await this.RouteManifestWithdrawn(req, res, method, mwm)
        }
        const rom = ControlPlaneHost.RolloutPathPattern.exec(path)
        if (rom !== null)
        {
            return await this.RouteRollout(req, res, method, rom)
        }
        const tpm = ControlPlaneHost.TenantPolicyPathPattern.exec(path)
        if (tpm !== null)
        {
            return await this.RouteTenantPolicy(req, res, method, tpm)
        }
        if (path === ControlPlaneHost.PoliciesAllPath && method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, [...this.deployments.AllPolicies()])
            return true
        }
        if (path === ControlPlaneHost.GatingAllPath && method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, [...this.deployments.AllGating()])
            return true
        }
        if (path === ControlPlaneHost.SelectionsAllPath && method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, [...this.deployments.AllSelections()])
            return true
        }
        if (path === ControlPlaneHost.RolloutsAllPath && method === PlaneHttp.MethodGet)
        {
            const rollouts = this.directory.ListHives().map(h =>
            {
                const s = this.deployments.StatusFor(h.id)
                return { hiveId: h.id, targetVersion: s.targetVersion, environments: s.environments }
            })
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, rollouts)
            return true
        }
        if (path === ControlPlaneHost.FleetPath && method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, this.BuildFleet())
            return true
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
            return false
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

    /** Joins every hive with its tenant, client and latest observation; carries no internal refs. */
    private BuildFleet(): FleetHiveDto[]
    {
        return this.directory.ListHives().map(hive =>
        {
            const tenant = this.directory.GetTenant(hive.tenantId)
            const client = tenant === undefined ? undefined : this.directory.GetClient(tenant.clientId)
            const obs = this.observations.Get(hive.id)
            return {
                id: hive.id,
                displayName: hive.displayName,
                tenant: tenant === undefined ? null : { id: tenant.id, displayName: tenant.displayName },
                client: client === undefined ? null : { id: client.id, displayName: client.displayName },
                clusterBackend: String(hive.cluster.backend),
                clusterMode: String(hive.cluster.mode),
                lastSeen: obs?.reportedAt ?? null,
                environments: (obs?.environments ?? []).map(h => ({ name: h.environmentName, ready: h.ready, image: h.runningImage, detail: h.detail }))
            }
        })
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
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, this.observations.LatestFor(id))
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
        const channel = body.channel
        if (channel !== undefined && !Object.values(Channel).includes(channel as Channel))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ChannelInvalidMessage })
            return true
        }
        const manifest: ManifestDto = await this.deployments.Publish(body.version as string, body.image as string, body.notes as string | undefined, channel as Channel | undefined)
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
        if (!withdraw)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.SetWithdrawn(version, false))
            return true
        }
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return true
        }
        if (typeof body.reason !== 'string' || body.reason.trim().length === 0)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ReasonRequiredMessage })
            return true
        }
        const who = await this.Principal(req)
        const actor = who?.email ?? who?.principalId ?? ''
        const manifest: ManifestDto = await this.deployments.SetWithdrawn(version, true, (body.reason as string).trim(), actor)
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, manifest)
        return true
    }

    /** Serves /api/tenants/ID/policy/(channels PUT | min-version PUT,DELETE | hold POST,DELETE); false for any other (action, method). */
    private async RouteTenantPolicy(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        const id = ControlPlaneHost.Decode(m[1] as string)
        if (id === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        const action = m[2]
        if (action === ControlPlaneHost.ChannelsSegment && method === PlaneHttp.MethodPut)
        {
            const body = await this.ReadJsonObject(req, res)
            if (body === undefined)
            {
                return true
            }
            const valid = Object.values(Channel) as unknown[]
            if (!Array.isArray(body.channels) || !body.channels.every(c => valid.includes(c)))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ChannelInvalidMessage })
                return true
            }
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.SetChannels(id, body.channels as Channel[]))
            return true
        }
        if (action === ControlPlaneHost.MinVersionSegment && method === PlaneHttp.MethodPut)
        {
            const v = await this.ReadVersion(req, res)
            if (v === undefined)
            {
                return true
            }
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.SetMinVersion(id, v))
            return true
        }
        if (action === ControlPlaneHost.MinVersionSegment && method === PlaneHttp.MethodDelete)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.ClearMinVersion(id))
            return true
        }
        if (action === ControlPlaneHost.HoldSegment && method === PlaneHttp.MethodPost)
        {
            const body = await this.ReadJsonObject(req, res)
            if (body === undefined)
            {
                return true
            }
            if (typeof body.reason !== 'string' || body.reason.trim().length === 0)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ReasonRequiredMessage })
                return true
            }
            const who = await this.Principal(req)
            const actor = who?.email ?? who?.principalId ?? ''
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.SetHold(id, body.reason.trim(), actor))
            return true
        }
        if (action === ControlPlaneHost.HoldSegment && method === PlaneHttp.MethodDelete)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.ClearHold(id))
            return true
        }
        return false
    }

    /** Dispatches /api/(tenants|hives)/ID/(manifests|gating[/VERSION]|rollout|rollout-registration); false for an unknown (resource, sub, method) combination. */
    private async RouteRollout(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        const resource = m[1] as string
        const sub = m[3] as string
        const tail = m[4]
        const known = resource === ControlPlaneHost.TenantsSegment
            ? sub === ControlPlaneHost.ManifestsSegment || sub === ControlPlaneHost.GatingSegment
            : sub === ControlPlaneHost.RolloutSegment || sub === ControlPlaneHost.RolloutRegistrationSegment
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
            const manifests: ManifestDto[] = [...this.deployments.AdoptableForTenant(id)]
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

    private async HandleProvision(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return
        }
        const client = body.client as Record<string, unknown> | undefined
        const tenant = body.tenant as Record<string, unknown> | undefined
        const hive = body.hive as Record<string, unknown> | undefined
        if (!ControlPlaneHost.IsObject(client) || !ControlPlaneHost.IsObject(tenant) || !ControlPlaneHost.IsObject(hive))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.SubObjectRequiredMessage })
            return
        }
        const idsOk = ControlPlaneHost.NonEmpty(client.id) && ControlPlaneHost.NonEmpty(tenant.id) && ControlPlaneHost.NonEmpty(hive.id)
        if (!idsOk)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.IdRequiredMessage })
            return
        }
        if (typeof client.displayName !== 'string' || typeof tenant.displayName !== 'string' || typeof hive.displayName !== 'string')
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.DisplayNameRequiredMessage })
            return
        }
        if (!ControlPlaneHost.NonEmpty(tenant.ownerEmail))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OwnerEmailRequiredMessage })
            return
        }
        if ((tenant.id as string).startsWith(ControlPlaneHost.ReservedIdPrefix))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ReservedIdMessage })
            return
        }
        const cluster = ControlPlaneHost.ParseCluster(hive.cluster)
        if (cluster === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ClusterInvalidMessage + Object.values(HiveBackend).join(', ') })
            return
        }
        const registry = ControlPlaneHost.ParseRegistry(hive.registry)
        if (registry === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.RegistryInvalidMessage + Object.values(InfraMode).join(', ') })
            return
        }
        if (!ControlPlaneHost.OptionalString(client.subscriptionRef) || !ControlPlaneHost.OptionalString(hive.trustRootRef))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OptionalStringMessage })
            return
        }
        try
        {
            const result = await this.orchestrator.Provision({
                client: { id: client.id as string, displayName: client.displayName, subscriptionRef: client.subscriptionRef as string | undefined },
                tenant: { id: tenant.id as string, displayName: tenant.displayName, ownerEmail: tenant.ownerEmail as string },
                hive: { id: hive.id as string, displayName: hive.displayName, cluster, registry, trustRootRef: hive.trustRootRef as string | undefined }
            })
            // Both one-time secrets are revealed exactly once here; never logged or stored.
            res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, { client: result.client, tenant: ControlPlaneHost.ToTenantDto(result.tenant), hive: result.hive, secrets: result.secrets })
        }
        catch (e)
        {
            if (e instanceof ProvisionFailedError)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusInternal, { error: e.message, rollback: e.rollback })
                return
            }
            throw e
        }
    }

    private static IsObject(v: unknown): v is Record<string, unknown>
    {
        return typeof v === 'object' && v !== null && !Array.isArray(v)
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

    /** Full-only (the central RBAC gate has already run). The password is never echoed. */
    private async HandleCreateOperator(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return
        }
        const role = typeof body.role === 'string' ? ControlPlaneHost.OperatorRoles.get(body.role) : undefined
        if (typeof body.email !== 'string' || !ControlPlaneHost.PlausibleEmail(body.email) || typeof body.password !== 'string'
            || body.password.length < ControlPlaneHost.MinOperatorPasswordLength || role === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OperatorFieldsMessage })
            return
        }
        await this.operator.CreateOperator(body.email, body.password, role)
        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusCreated, { email: body.email })
    }

    private static IsOperatorMutationPath(path: string): boolean
    {
        return path === ControlPlaneHost.OperatorRolePath || path === ControlPlaneHost.OperatorPasswordResetPath
            || path === ControlPlaneHost.OperatorDisabledPath || path === ControlPlaneHost.OperatorRevokeSessionsPath
    }

    /** Full-only (the central RBAC gate has already run). Validates the body, then applies one operator mutation as the session actor. */
    private async HandleOperatorMutation(path: string, req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return
        }
        if (typeof body.email !== 'string' || body.email.trim().length === 0)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OperatorEmailMessage })
            return
        }
        const email = body.email
        const who = await this.Principal(req)
        if (who === null)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
            return
        }
        if (path === ControlPlaneHost.OperatorPasswordResetPath)
        {
            const password = await this.operator.ResetOperatorPassword(email)
            res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { password })
            return
        }
        if (path === ControlPlaneHost.OperatorRevokeSessionsPath)
        {
            await this.operator.RevokeOperatorSessions(email)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, {})
            return
        }
        if (path === ControlPlaneHost.OperatorRolePath)
        {
            const role = typeof body.role === 'string' ? ControlPlaneHost.OperatorRoles.get(body.role) : undefined
            if (role === undefined)
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OperatorRoleMessage })
                return
            }
            await this.operator.SetOperatorRole(email, role, who.principalId)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, {})
            return
        }
        if (path === ControlPlaneHost.OperatorDisabledPath)
        {
            if (typeof body.disabled !== 'boolean')
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OperatorDisabledMessage })
                return
            }
            await this.operator.SetOperatorDisabled(email, body.disabled, who.principalId)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, {})
            return
        }
        PlaneHttp.WriteNotFound(res)
    }

    /** Minimal shape check: exactly one '@' with a non-empty local part and domain. */
    private static PlausibleEmail(email: string): boolean
    {
        const parts = email.split(ControlPlaneHost.EmailAt)
        return parts.length === 2 && (parts[0] as string).length > 0 && (parts[1] as string).length > 0
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
        const clientIp = this.ClientIp(req)
        const gate = this.loginThrottle.CheckAllowed(body.email, clientIp)
        if (!gate.allowed)
        {
            res.setHeader(ControlPlaneHost.RetryAfterHeader, String(Math.ceil(gate.retryAfterMs / ControlPlaneHost.MsPerSecond)))
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusTooManyRequests, { error: ControlPlaneHost.TooManyAttemptsMessage })
            return
        }
        // Count the attempt at the gate, synchronously (no await between Check and Record), so a parallel burst
        // serialises and only maxAttempts requests get through; success below wipes the optimistic count.
        this.loginThrottle.RecordFailure(body.email, clientIp)
        const session = await this.operator.Authenticate(body.email, body.password)
        if (session === null)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.InvalidCredentialsMessage })
            return
        }
        this.loginThrottle.Clear(body.email, clientIp)
        res.setHeader(ControlPlaneHost.SetCookieHeader, SessionCookie.Build(session.token, session.expiresAt, this.secureCookie))
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { email: body.email })
    }

    /** Socket peer address, or (only behind a trusted proxy) the last x-forwarded-for hop. */
    private ClientIp(req: IncomingMessage): string
    {
        if (this.trustedProxy)
        {
            const raw = req.headers[ControlPlaneHost.ForwardedForHeader]
            const header = Array.isArray(raw) ? raw.join(ControlPlaneHost.ForwardedSeparator) : raw
            const last = header?.split(ControlPlaneHost.ForwardedSeparator).pop()?.trim()
            if (last !== undefined && last.length > 0)
            {
                return last
            }
        }
        return req.socket.remoteAddress ?? ControlPlaneHost.UnknownClientIp
    }

    private async Principal(req: IncomingMessage): Promise<OperatorPrincipal | null>
    {
        const token = SessionCookie.Read(req.headers[ControlPlaneHost.CookieHeader])
        return token === undefined || token.length === 0 ? null : await this.operator.ValidateToken(token)
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
        for (const c of this.registry.All())
        {
            if (c.readyState === WebSocket.OPEN)
            {
                c.send(text)
            }
        }
    }

    private HostAllowed(req: IncomingMessage): boolean
    {
        return PlaneHttp.HostIn(req, this.allowedHosts)
    }

    private static IsPublicApi(path: string): boolean
    {
        return path === ControlPlaneHost.PingPath || path === ControlPlaneHost.LoginPath || path === ControlPlaneHost.SessionPath
    }

    /** Absent Origin is allowed (non-browser / same-origin navigation); a present one must equal our own origin,
     *  scheme included. The scheme is http unless a trusted proxy reports https via x-forwarded-proto. */
    private OriginAllowed(req: IncomingMessage): boolean
    {
        const origin = req.headers[PlaneHttp.OriginHeader]
        return origin === undefined || origin === this.OwnScheme(req) + req.headers[PlaneHttp.HostHeader]
    }

    private OwnScheme(req: IncomingMessage): string
    {
        if (this.trustedProxy)
        {
            const raw = req.headers[ControlPlaneHost.ForwardedProtoHeader]
            const header = Array.isArray(raw) ? raw.join(ControlPlaneHost.ForwardedSeparator) : raw
            const last = header?.split(ControlPlaneHost.ForwardedSeparator).pop()?.trim().toLowerCase()
            if (last !== undefined && last + '://' === ControlPlaneHost.HttpsScheme)
            {
                return ControlPlaneHost.HttpsScheme
            }
        }
        return ControlPlaneHost.HttpScheme
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
