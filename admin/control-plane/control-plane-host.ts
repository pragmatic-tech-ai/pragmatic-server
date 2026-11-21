import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import {
    AppHost,
    AppHostConfig,
    AuditTrail,
    CacheControl,
    ClaimsAuthorizer,
    HttpMethod,
    JsonApi,
    MuralBundle,
    PasswordLoginEndpoint,
    RateLimiter,
    RouteAuth,
    RouteTable,
    SessionStore,
    WsTicketEndpoint,
    type IAuditRepository,
    type RequestContext,
    type SocketContext,
} from '@pragmatic-tech-ai/pragmatic-app-host'
import type { EnvType, Template, EnvironmentChange, EnvironmentRecord } from './environment-record.js'
import { EnvironmentDtoMapper, type EnvironmentDto } from './environment-dto.js'
import type { HiveObservationRegistry } from './hive-observation-record.js'
import type { IIdpService } from './idp-service.js'
import type { OwnerPasswordReset, TenantProvisioningService } from './tenant-provisioning-service.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal } from './operator-identity.js'
import { OperatorPasswordAuthenticator, OperatorRoleClaims, OperatorSessions, type OperatorSessionGate } from './operator-sessions.js'
import { type DesktopDiscoveryEndpoint, ReleaseRegistryUnavailableError } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { Channel, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { OperatorSocketRegistry } from './operator-socket-registry.js'
import type { AdminSnapshot } from './admin-proxy.js'
import type { PlatformDirectory } from './platform-directory.js'
import { HiveBootstrapBundle } from './hive-bootstrap-bundle.js'
import { DevPlatformImages, PlatformImages, type IPlatformImages } from './platform-images.js'
import type { ConsoleAdvertRegistry } from './console-advert-registry.js'
import type { ConsoleDomainApprovals } from './console-domain-approvals.js'
import type { PlatformEmailDomains } from './platform-email-domains.js'
import { TenantEmailDomainsLimits } from './tenant-api/tenant-email-domains.js'
import { HiveConsoleSpecs } from './hive-console-spec.js'
import type { HiveAgentInstaller, InstallStatus } from './hive-agent-installer.js'
import { ConsoleUninstallError, HiveClusterDestroyError, type HiveAgentUninstaller } from './hive-agent-uninstaller.js'
import type { ConsoleInstallStatus, ConsoleRemovalOutcome, TenantConsoleInstaller } from './tenant-console-installer.js'
import type { InHiveOwnerPassword } from './in-hive-idp-admin.js'
import { HiveBackend, InfraMode, type ClientRecord, type ClusterSpec, type HiveRecord, type RegistrySpec, type TenantRecord } from './platform-records.js'
import { ProvisioningOrchestrator, ProvisionFailedError } from './provisioning-orchestrator.js'
import { KubectlError } from '@pragmatic-tech-ai/pragmatic-kube'
import type { HiveRolloutStatus, PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import type { ManifestRecord } from './manifest-record.js'
import { ReleaseRefresher } from './release/release-refresher.js'
import type { ReleaseRefreshResult } from './release/release-catalog.js'
import type { CreateAccountParams, GraphLoadedDto, GrantMutationDto, IdentityConfigDto, SecurityCatalogDto, SecurityChangesDto, SecurityModelDto, TeamMemberDto, TokenIssuedDto, ServiceTokenSummaryDto, IssueTokenParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILogProcess } from '../../environments/seed/docker.js'
import { ControlPlaneProblems } from './control-plane-problems.js'

export interface IEnvironmentService
{
    Create(name: string, template: Template, type: EnvType, hostPort?: number, hiveId?: string, creatorPrincipalId?: string): Promise<EnvironmentRecord>
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
    AdminGetSecurityCatalog(name: string): Promise<SecurityCatalogDto>
    AdminListTeamMembers(name: string, teamId: string): Promise<TeamMemberDto[]>
    AdminListSecurityChanges(name: string): Promise<SecurityChangesDto[]>
    AdminIssueMakerToken(name: string): Promise<TokenIssuedDto>
    AdminIssueDeployToken(name: string): Promise<TokenIssuedDto>
    AdminIssueDeveloperToken(name: string): Promise<TokenIssuedDto>
    AdminIssueRunTestToken(name: string): Promise<TokenIssuedDto>
    AdminIssueReaderToken(name: string): Promise<TokenIssuedDto>
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

/** One activity-log entry as the portal reads it (an audit entry of the host's trail). */
export type ActivityDto = { id: string; actor: string; method: string; path: string; status: number; at: string; note?: string }

export type ChangedEvent = { type: string }

/**
 * A hive delete's outcome for the operator: what was deliberately kept, what could not be removed (environment namespaces whose
 * delete failed), and what a delete anyway may have left behind.
 */
type HiveDeleteOutcome = { retained: string[]; failed: string[]; notice?: string }

/** A platform record collection the generic record routes serve. */
enum PlatformResource
{
    Clients = 'clients',
    Tenants = 'tenants',
    Hives = 'hives',
}

/** A release-policy setting under /api/(tenants|hives)/:id/policy/. */
enum PolicySetting
{
    Channels = 'channels',
    MinVersion = 'min-version',
    Hold = 'hold',
}

/** An operator mutation under /api/operators/. */
enum OperatorMutation
{
    Role = 'role',
    PasswordReset = 'password-reset',
    Disabled = 'disabled',
    RevokeSessions = 'revoke-sessions',
}

/** A one-domain action under /api/tenants/:id/email-domains/. */
enum EmailDomainAction
{
    Approve = 'approve',
    Revoke = 'revoke',
    Verify = 'verify',
}

/**
 * What the platform admin console's host is composed of. Service, Graphs, Operator, Sessions, Directory, Deployments,
 * Provisioning and Observations are required; everything else is optional (an absent installer, catalogue or domain
 * service leaves its routes refusing or unmounted, as each route says).
 */
export interface ControlPlaneHostOptions
{
    Service: IEnvironmentService
    Graphs: IGraphService
    /** The operator portal bundle (MuralBundle); a folder without an index.html serves no UI (non-API paths are 404). */
    PortalRoot?: string
    Operator: IOperatorIdentity
    /** Sessions, the cookie, event-socket tickets and the sign-in throttle (Postgres in production). */
    Sessions: OperatorSessions
    Directory: PlatformDirectory
    Deployments: PlatformDeploymentRegistry
    Provisioning: TenantProvisioningService
    Observations: HiveObservationRegistry
    /** Behind a trusted reverse proxy: the last x-forwarded-for / x-forwarded-proto hop is honoured. */
    TrustedProxy?: boolean
    /** Host names besides the loopback names. */
    AllowedHosts?: readonly string[]
    /** The operator activity log; without it nothing is audited and /api/activity is empty. */
    Audit?: IAuditRepository
    /** Limits refused unauthenticated mutations per client address (default: the session layer's, 30 a minute). */
    DenialLimiter?: RateLimiter
    Sockets?: OperatorSocketRegistry<WebSocket>
    /** How often live event sockets are re-checked against their sessions. */
    RevalidateIntervalMs?: number
    Idp?: IIdpService
    /** The pod-visible agent channel URL a hive's bootstrap points its agent at; undefined while the channel is off. */
    AgentChannelUrl?: string
    /** Installs a Local hive's agent from the control plane itself; undefined disables the automatic path. */
    AgentInstaller?: HiveAgentInstaller
    /** Removes a hive's agent from its cluster when the hive is deleted; undefined removes only platform state. */
    AgentUninstaller?: HiveAgentUninstaller
    /** Public desktop email discovery (POST /api/desktop/discover); undefined leaves the route unmounted. */
    Discovery?: DesktopDiscoveryEndpoint
    /** Installs (and removes) a Local hive's in-hive tenant console; undefined disables the console routes' actions. */
    ConsoleInstaller?: TenantConsoleInstaller
    /** The console adverts in-hive consoles reported; forgotten with the console, the hive or the tenant. */
    Adverts?: ConsoleAdvertRegistry
    /** Email-domain standing per tenant; forgotten with the tenant only (it belongs to the tenant, not a hive). */
    Approvals?: ConsoleDomainApprovals
    /** Tenant email domains (/api/tenants/ID/email-domains); undefined leaves those routes unmounted. */
    EmailDomains?: PlatformEmailDomains
    /** Refreshes the release catalogue (POST /api/releases/refresh); undefined when no registry is configured (409). */
    Releases?: ReleaseRefresher
    /** Where the hive agent image in a bootstrap bundle comes from; without a release the bundle is refused (409). */
    PlatformImages?: IPlatformImages
}

/**
 * The platform admin console's HTTP server: a pragmatic-app-host AppHost (one ordered pipeline: health, allowed Host, body
 * type, Origin, authentication, authorization, route, UI bundle) with the console's declared routes. Operators sign in
 * with their password (PasswordLoginEndpoint over the operator accounts) into the console's session store; each route
 * names, as its AppRole, the operator role (operator.full, operator.read-only, as session claims) it admits; every authorized mutation is
 * audited once with its final status. Domain errors answer through ControlPlaneProblems. Live updates go out on the
 * `/api/events` socket, opened with a single-use ticket.
 */
export class ControlPlaneHost
{
    private static readonly NotListeningMessage = 'ControlPlaneHost is not listening'
    private static readonly IndexFile = 'index.html'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly SetCookieHeader = 'Set-Cookie'
    private static readonly RetryAfterHeader = 'Retry-After'
    /** Request bodies are small JSON objects: 4 KiB unless a route declares more. */
    private static readonly MaxBodyBytes = 4096
    private static readonly MaxAuditTargetLength = 256
    private static readonly RevalidateIntervalMs = 30_000
    private static readonly ActivityLimitMax = 200
    private static readonly ActivityLimitParam = 'limit'
    private static readonly ChangedType = 'environments-changed'
    // Routes.
    private static readonly PingPath = '/api/ping'
    private static readonly LoginPath = '/api/login'
    private static readonly SessionPath = '/api/session'
    private static readonly LogoutPath = '/api/logout'
    private static readonly SessionPasswordPath = '/api/session/password'
    private static readonly DiscoverPath = '/api/desktop/discover'
    private static readonly EventsPath = '/api/events'
    private static readonly TicketPath = '/api/ws-ticket'
    private static readonly ActivityPath = '/api/activity'
    private static readonly OperatorsPath = '/api/operators'
    private static readonly OperatorMutationPath = '/api/operators/:mutation'
    private static readonly ProvisionPath = '/api/provision'
    private static readonly ManifestsPath = '/api/manifests'
    private static readonly ReleasesRefreshPath = '/api/releases/refresh'
    private static readonly ManifestWithdrawnPath = '/api/manifests/:version/withdrawn'
    private static readonly PoliciesPath = '/api/policies'
    private static readonly GatingAllPath = '/api/gating'
    private static readonly SelectionsPath = '/api/selections'
    private static readonly RolloutsPath = '/api/rollouts'
    private static readonly FleetPath = '/api/fleet'
    private static readonly EnvironmentsPath = '/api/environments'
    private static readonly TenantManifestsPath = '/api/tenants/:id/manifests'
    private static readonly TenantGatingPath = '/api/tenants/:id/gating'
    private static readonly TenantGatingVersionPath = '/api/tenants/:id/gating/:version'
    private static readonly HiveRolloutPath = '/api/hives/:id/rollout'
    private static readonly HiveRegistrationPath = '/api/hives/:id/rollout-registration'
    private static readonly TenantOwnerPasswordPath = '/api/tenants/:id/owner-password'
    private static readonly TenantEmailDomainsPath = '/api/tenants/:id/email-domains'
    private static readonly TenantPolicyPrefix = '/api/tenants/:id/policy/'
    private static readonly HivePolicyPrefix = '/api/hives/:id/policy/'
    private static readonly ResourcePrefix = '/api/'
    private static readonly ItemSuffix = '/:id'
    private static readonly PathSeparator = '/'
    private static readonly HiveHealthPath = '/api/hives/:id/health'
    private static readonly HiveObservationsPath = '/api/hives/:id/observations'
    private static readonly HiveLedgerPath = '/api/hives/:id/ledger'
    private static readonly HiveBootstrapPath = '/api/hives/:id/bootstrap'
    private static readonly HiveAgentInstallPath = '/api/hives/:id/agent-install'
    private static readonly HiveConsolePath = '/api/hives/:id/console'
    private static readonly HiveConsoleInstallPath = '/api/hives/:id/console-install'
    private static readonly HiveConsoleOwnerPasswordPath = '/api/hives/:id/console/owner-password'
    private static readonly GraphsPath = '/api/environments/:env/graphs'
    private static readonly GraphPath = '/api/environments/:env/graphs/:graph'
    private static readonly PromotePath = '/api/environments/:env/graphs/:graph/promote'
    private static readonly LoadedGraphPath = '/api/environments/:env/loaded-graph'
    // Route parameters.
    private static readonly SubjectField = 'subject'
    private static readonly ClaimsField = 'claims'
    private static readonly IdParam = 'id'
    private static readonly VersionParam = 'version'
    private static readonly MutationParam = 'mutation'
    private static readonly EnvParam = 'env'
    private static readonly GraphParam = 'graph'
    // Messages.
    private static readonly UnauthenticatedMessage = 'Authentication required'
    private static readonly OperatorEmailMessage = 'email (non-empty string) is required'
    private static readonly OperatorRoleMessage = 'role (full|readonly) is required'
    private static readonly OperatorDisabledMessage = 'disabled (boolean) is required'
    private static readonly SubObjectRequiredMessage = 'client, tenant and hive (objects) are required'
    private static readonly MinOperatorPasswordLength = 12
    private static readonly EmailAt = '@'
    private static readonly OperatorFieldsMessage = 'a valid email, a password of at least ' + ControlPlaneHost.MinOperatorPasswordLength + ' characters and a role (full|readonly) are required'
    private static readonly CurrentPasswordField = 'currentPassword'
    private static readonly NewPasswordField = 'newPassword'
    private static readonly ConfirmPasswordField = 'confirmPassword'
    private static readonly PasswordFieldsMessage = 'currentPassword and newPassword (strings) are required'
    private static readonly WeakPasswordMessage = 'The new password must be at least ' + ControlPlaneHost.MinOperatorPasswordLength + ' characters.'
    private static readonly PasswordMismatchMessage = 'The new password and its confirmation do not match.'
    private static readonly SamePasswordMessage = 'The new password must differ from the current one.'
    private static readonly WrongCurrentPasswordMessage = 'The current password is not correct.'
    private static readonly TooManyPasswordAttemptsMessage = 'Too many attempts; try again later'
    private static readonly PasswordChangeBusyMessage = 'A password change for this account is already running.'
    private static readonly OthersNotEndedWarning = 'Your password is changed, but your other sessions could not be signed out. Revoke them from Settings, or ask another operator.'
    private static readonly SignInAgainWarning = 'Your password is changed. Sign in again with the new password.'
    private static readonly RoleFullWire = 'full'
    private static readonly RoleReadOnlyWire = 'readonly'
    private static readonly OperatorRoles: ReadonlyMap<string, OperatorRole> = new Map([[ControlPlaneHost.RoleFullWire, OperatorRole.Full], [ControlPlaneHost.RoleReadOnlyWire, OperatorRole.ReadOnly]])
    private static readonly AgentChannelOffMessage = 'The agent channel is not configured: start the control plane with PRAGMATIC_AGENT_CHANNEL_PORT so hives can dial home.'
    /** `DELETE /api/hives/ID?force=true`: delete anyway, skipping the agent's removal from an unreachable cluster. */
    private static readonly ForceParam = 'force'
    private static readonly ForceValue = 'true'
    /** The audit note of a delete anyway (the query itself is never audited). */
    private static readonly ForcedNote = 'deleted anyway (force=true)'
    private static readonly ConsoleInstallOffMessage = 'Installing the console is not available on this control plane.'
    private static readonly ConsoleInstallRunningMessage = 'A console install is running for this hive. Wait for it to finish (or fail), then try again.'
    private static readonly AgentInstallRunningMessage = 'An agent install is running for this hive. Wait for it to finish (or fail) before installing the console.'
    private static readonly AgentInstallBeforeRemovalMessage = 'An agent install is running for this hive. Wait for it to finish (or fail) before removing the console.'
    private static readonly AgentInstallBeforeSettingsMessage = 'An agent install is running for this hive. Wait for it to finish (or fail) before changing the console settings.'
    private static readonly ConsoleRemoveFailedPrefix = "Could not remove the hive's console from its cluster: "
    private static readonly ConsoleLeftNotice = 'The console was not removed: its objects (including its cluster-wide grants) and the environment namespaces it created may remain in the cluster until someone removes them.'
    private static readonly ForgetFailedLogPrefix = '[hive-delete] hive '
    private static readonly TenantDeleteLogPrefix = '[tenant-delete] tenant '
    private static readonly ForgetFailedLogInfix = ': forgetting its console keys failed: '
    private static readonly ForgetAdvertLogInfix = ': forgetting its console advert failed: '
    private static readonly ForgetApprovalsLogInfix = ': forgetting its email domain standing failed: '
    private static readonly ForgetOwnerResetLogInfix = ': forgetting its recorded Owner reset failed: '
    private static readonly ConsoleRemoveLogPrefix = '[console-remove] hive '
    private static readonly UnknownErrorName = 'Error'
    private static readonly NamespacesLeftNoticePrefix = 'These environment namespaces could not be deleted and may remain in the cluster: '
    private static readonly NoticeSeparator = ' '
    private static readonly SentenceEnd = '.'
    private static readonly FailedNotePrefix = 'failed: '
    private static readonly AuditNoteSeparator = '; '
    private static readonly AgentLeftNotice = 'The agent was not removed: the agent may remain in the cluster, locked out (its token is revoked), until someone removes it.'
    private static readonly KindClusterLeftNotice = "The hive's kind cluster was not destroyed: the kind cluster may be left behind on this machine."
    private static readonly RetainedNotePrefix = 'retained: '
    private static readonly KeptNotListedNote = 'kept objects not listed'
    private static readonly NoteSeparator = ', '
    private static readonly AutoInstallOffMessage = 'Automatic install is not available on this control plane. Install the agent manually.'
    private static readonly ReissueDuringInstallMessage = 'An agent install is running for this hive and issues its own token. Wait for it to finish (or fail) before reissuing the token.'
    private static readonly DeleteDuringInstallMessage = 'An agent install is running for this hive. Wait for it to finish (or fail) before deleting the hive.'
    private static readonly HiveBusyMessage = "Another operation on this hive's agent token or lifecycle (a token reissue or a delete) is in progress. Wait for it to finish, then try again."
    private static readonly ReleasesNotConfiguredMessage = 'The release registry is not configured.'
    private static readonly ReleaseRefreshFailedLog = 'release refresh failed: '
    private static readonly ReleaseRefreshFailedMessage = 'The release refresh failed.'
    private static readonly ReleaseLogPrefix = '[control-plane] request failed:'
    private static readonly DomainNotePrefix = 'domain: '
    private static readonly ApprovedOnSaveNotePrefix = 'approved on save: '
    private static readonly DomainsKey = 'domains'
    private static readonly DomainKey = 'domain'
    private static readonly VersionRequiredMessage = 'version (non-empty string) is required'
    private static readonly ChannelsInvalidMessage = 'channels must be an array of: stable, early'
    private static readonly ChannelValues: readonly string[] = Object.values(Channel)
    private static readonly ReasonRequiredMessage = 'reason (non-empty string) is required'
    private static readonly IdRequiredMessage = 'id (non-empty string) is required'
    private static readonly DisplayNameRequiredMessage = 'displayName (string) is required'
    private static readonly OwnerEmailRequiredMessage = 'ownerEmail (non-empty string) is required'
    private static readonly ReservedIdMessage = "id must not start with '_' (reserved for the IdP namespace)"
    private static readonly ReservedIdPrefix = '_'
    private static readonly ClientIdRequiredMessage = 'clientId (non-empty string) is required'
    private static readonly TenantIdRequiredMessage = 'tenantId (non-empty string) is required'
    private static readonly OptionalStringMessage = 'optional reference fields must be strings'
    private static readonly ExistingFlagMessage = 'existing must be a boolean when given'
    private static readonly ClusterInvalidMessage = 'cluster must be { backend, mode } with valid values; backend one of: '
    private static readonly RegistryInvalidMessage = 'registry must be { mode, endpoint?, credentialRef? } with a valid mode; mode one of: '
    private static readonly ValueListSeparator = ', '
    private static readonly TargetEnvRequiredMessage = 'targetEnv (non-empty string) is required'
    private static readonly DescriptionRequiredMessage = 'description (string) is required'
    private static readonly NameRequiredMessage = 'name (string) is required'
    private static readonly BodyObjectMessage = 'Request body must be a JSON object'
    private static readonly BadJsonMessage = 'Request body must be valid JSON'
    // Statuses.
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly StatusAccepted = 202
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusForbidden = 403
    private static readonly StatusNotFound = 404
    private static readonly StatusConflict = 409
    private static readonly StatusTooManyRequests = 429
    private static readonly StatusInternal = 500
    private static readonly NotFoundMessage = 'Not found'

    private appHost: AppHost | undefined
    private readonly sessions: OperatorSessions
    private readonly gate: OperatorSessionGate
    private readonly audit: AuditTrail | undefined
    private readonly registry: OperatorSocketRegistry<WebSocket>
    private readonly revalidateIntervalMs: number
    private readonly platformImages: IPlatformImages
    private readonly orchestrator: ProvisioningOrchestrator
    private changeSubscription: (() => void) | undefined
    private revalidating = false
    private revalidateTimer: ReturnType<typeof setInterval> | undefined
    /** Operators (principal ids) with an own-password change in flight: a second one is refused (409). */
    private readonly passwordChanges = new Set<string>()
    /** Session ids the socket sweep must not close: their own-password change is moving their sockets to a fresh session. */
    private readonly protectedSessions = new Set<string>()
    /**
     * Hives with a token reissue or a delete in flight. One token- or lifecycle-writing operation per hive at a time: an
     * install, a reissue and a delete each refuse (409) while another runs (a running install counts too), so e.g. an
     * install cannot recreate the cluster a delete is tearing down.
     */
    private readonly hiveWrites = new Set<string>()

    public constructor(private readonly options: ControlPlaneHostOptions)
    {
        this.sessions = options.Sessions
        this.gate = options.Sessions.GateOver(options.Operator)
        this.audit = options.Audit === undefined ? undefined : new AuditTrail(options.Audit, { MaxTargetLength: ControlPlaneHost.MaxAuditTargetLength })
        this.registry = options.Sockets ?? new OperatorSocketRegistry<WebSocket>()
        this.revalidateIntervalMs = options.RevalidateIntervalMs ?? ControlPlaneHost.RevalidateIntervalMs
        this.platformImages = options.PlatformImages ?? new DevPlatformImages()
        this.orchestrator = new ProvisioningOrchestrator(options.Directory, options.Provisioning, options.Deployments)
    }

    public async Listen(port: number, host: string): Promise<void>
    {
        const appHost = new AppHost(new AppHostConfig({
            AllowedHosts: this.options.AllowedHosts ?? [],
            TrustedProxy: this.options.TrustedProxy ?? false,
            DefaultBodyLimit: ControlPlaneHost.MaxBodyBytes,
            AuditActorClaim: OperatorRoleClaims.EmailClaim,
        }), {
            Routes: this.Routes(),
            Sessions: this.gate,
            Authorizer: new ClaimsAuthorizer(),
            Audit: this.audit,
            Bundle: this.Bundle(),
            Problems: new ControlPlaneProblems(),
            DenialLimiter: this.options.DenialLimiter ?? this.sessions.Denials,
            Tickets: this.sessions.Tickets,
        })
        await appHost.Listen(port, host)
        this.appHost = appHost
        this.StartRevalidation()
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
        const appHost = this.appHost
        this.appHost = undefined
        // AppHost.Close resolves only once no audit write is still running (each one starts after its response).
        await appHost?.Close()
    }

    public Address(): { address: string; port: number }
    {
        if (this.appHost === undefined)
        {
            throw new Error(ControlPlaneHost.NotListeningMessage)
        }
        return this.appHost.Address()
    }

    /** The portal bundle, when its folder holds a built index.html. */
    private Bundle(): MuralBundle | undefined
    {
        const root = this.options.PortalRoot
        return root !== undefined && existsSync(join(root, ControlPlaneHost.IndexFile)) ? MuralBundle.Load(root) : undefined
    }

    /**
     * The console's routes. Public: ping, sign-in, the session probe, sign-out and desktop discovery. Every other route needs
     * an operator session: a read admits both operator roles (the operator roster only operator.full), every mutation
     * operator.full, except signing out and changing one's own password, which every operator may. Mutations are audited
     * (sign-in, sign-out and discovery are not).
     */
    public Routes(): RouteTable
    {
        const C = ControlPlaneHost
        const any = OperatorRoleClaims.Any
        const full = OperatorRoleClaims.Full
        const table = new RouteTable()
        const read = (pattern: string, handler: (ctx: RequestContext) => Promise<void> | void, role: string | readonly string[] = any): void =>
        {
            table.Add({ Method: HttpMethod.Get, Pattern: pattern, Auth: RouteAuth.Session, AppRole: role, Handler: async ctx => { await handler(ctx) } })
        }
        const write = (method: HttpMethod, pattern: string, handler: (ctx: RequestContext) => Promise<void> | void, bodyLimit?: number): void =>
        {
            table.Add({ Method: method, Pattern: pattern, Auth: RouteAuth.Session, AppRole: full, Handler: async ctx => { await handler(ctx) }, ...(bodyLimit === undefined ? {} : { BodyLimit: bodyLimit }) })
        }
        // Public.
        table.Add({ Method: HttpMethod.Get, Pattern: C.PingPath, Auth: RouteAuth.Public, Handler: async ctx => ctx.WriteJson(C.StatusOk, { ok: true }) })
        new PasswordLoginEndpoint(new OperatorPasswordAuthenticator(this.options.Operator), this.gate, this.sessions.LoginThrottle).Register(table, C.LoginPath)
        table.Add({ Method: HttpMethod.Get, Pattern: C.SessionPath, Auth: RouteAuth.Public, Handler: async ctx => this.HandleSession(ctx) })
        table.Add({ Method: HttpMethod.Post, Pattern: C.LogoutPath, Auth: RouteAuth.Public, Audited: false, Handler: ctx => this.HandleLogout(ctx) })
        const discovery = this.options.Discovery
        if (discovery !== undefined)
        {
            table.Add({ Method: HttpMethod.Post, Pattern: C.DiscoverPath, Auth: RouteAuth.Public, Audited: false, Handler: ctx => discovery.Handle(ctx.Request, ctx.Response, ctx.ClientAddress) })
        }
        // The operator's own session.
        new WsTicketEndpoint(this.sessions.Tickets).Register(table, C.TicketPath)
        table.Add({ Method: HttpMethod.Post, Pattern: C.SessionPasswordPath, Auth: RouteAuth.Session, AppRole: any, Handler: ctx => this.HandleChangeOwnPassword(ctx) })
        table.AddSocket({ Pattern: C.EventsPath, Auth: RouteAuth.Session, AppRole: any, Handler: (ws, ctx) => this.AdmitClient(ws, ctx) })
        // Operators.
        read(C.OperatorsPath, ctx => this.HandleListOperators(ctx), full)
        write(HttpMethod.Post, C.OperatorsPath, ctx => this.HandleCreateOperator(ctx))
        write(HttpMethod.Post, C.OperatorMutationPath, ctx => this.HandleOperatorMutation(ctx))
        // Activity, releases, fleet-wide reads.
        read(C.ActivityPath, ctx => this.HandleActivity(ctx))
        read(C.ManifestsPath, ctx => ctx.WriteJson(C.StatusOk, [...this.options.Deployments.AllManifests()]))
        write(HttpMethod.Post, C.ReleasesRefreshPath, ctx => this.HandleReleasesRefresh(ctx))
        write(HttpMethod.Post, C.ManifestWithdrawnPath, ctx => this.HandleWithdraw(ctx))
        write(HttpMethod.Delete, C.ManifestWithdrawnPath, ctx => this.HandleRestore(ctx))
        read(C.PoliciesPath, ctx => ctx.WriteJson(C.StatusOk, [...this.options.Deployments.AllPolicies()]))
        read(C.GatingAllPath, ctx => ctx.WriteJson(C.StatusOk, [...this.options.Deployments.AllGating()]))
        read(C.SelectionsPath, ctx => ctx.WriteJson(C.StatusOk, [...this.options.Deployments.AllSelections()]))
        read(C.RolloutsPath, ctx => this.HandleRollouts(ctx))
        read(C.FleetPath, ctx => ctx.WriteJson(C.StatusOk, this.BuildFleet()))
        write(HttpMethod.Post, C.ProvisionPath, ctx => this.HandleProvision(ctx))
        // Platform records.
        for (const resource of Object.values(PlatformResource))
        {
            const collection = C.ResourcePrefix + resource
            read(collection, ctx => ctx.WriteJson(C.StatusOk, this.ListPlatform(resource)))
            write(HttpMethod.Post, collection, ctx => this.HandleCreatePlatform(resource, ctx))
            read(collection + C.ItemSuffix, ctx => this.HandleGetPlatform(resource, ctx))
            write(HttpMethod.Delete, collection + C.ItemSuffix, ctx => this.HandleDeletePlatform(resource, ctx))
        }
        // Tenant rollout, policy, owner and email domains.
        read(C.TenantManifestsPath, ctx => ctx.WriteJson(C.StatusOk, [...this.options.Deployments.AdoptableForTenant(ctx.Param(C.IdParam))]))
        write(HttpMethod.Post, C.TenantGatingPath, ctx => this.HandleGate(ctx))
        write(HttpMethod.Delete, C.TenantGatingVersionPath, ctx => this.HandleUngate(ctx))
        write(HttpMethod.Post, C.TenantOwnerPasswordPath, ctx => this.HandleOwnerPasswordReset(ctx))
        this.AddPolicyRoutes(write, C.TenantPolicyPrefix, false)
        this.AddPolicyRoutes(write, C.HivePolicyPrefix, true)
        const domains = this.options.EmailDomains
        if (domains !== undefined)
        {
            read(C.TenantEmailDomainsPath, ctx => this.HandleEmailDomainsReport(ctx, domains))
            write(HttpMethod.Put, C.TenantEmailDomainsPath, ctx => this.HandleSetEmailDomains(ctx, domains), TenantEmailDomainsLimits.MaxBodyBytes)
            for (const action of Object.values(EmailDomainAction))
            {
                write(HttpMethod.Post, C.TenantEmailDomainsPath + C.PathSeparator + action, ctx => this.HandleEmailDomainAction(ctx, domains, action), TenantEmailDomainsLimits.MaxBodyBytes)
            }
        }
        // Hives.
        read(C.HiveRolloutPath, ctx => this.HandleHiveRollout(ctx))
        write(HttpMethod.Post, C.HiveRegistrationPath, ctx => this.HandleRegisterHive(ctx))
        read(C.HiveHealthPath, ctx => this.HandleHiveHealth(ctx))
        read(C.HiveObservationsPath, ctx => this.HandleHiveObservations(ctx))
        read(C.HiveLedgerPath, ctx => this.HandleHiveLedger(ctx))
        read(C.HiveBootstrapPath, ctx => this.HandleHiveBootstrap(ctx))
        read(C.HiveAgentInstallPath, ctx => this.HandleAgentInstallStatus(ctx))
        write(HttpMethod.Post, C.HiveAgentInstallPath, ctx => this.HandleStartAgentInstall(ctx))
        read(C.HiveConsoleInstallPath, ctx => this.HandleConsoleInstallStatus(ctx))
        write(HttpMethod.Post, C.HiveConsoleInstallPath, ctx => this.HandleStartConsoleInstall(ctx))
        write(HttpMethod.Post, C.HiveConsoleOwnerPasswordPath, ctx => this.HandleHiveConsoleOwnerPassword(ctx))
        write(HttpMethod.Put, C.HiveConsolePath, ctx => this.HandleSetHiveConsole(ctx))
        write(HttpMethod.Delete, C.HiveConsolePath, ctx => this.HandleRemoveHiveConsole(ctx))
        // Environments and graphs.
        read(C.EnvironmentsPath, async ctx => ctx.WriteJson(C.StatusOk, (await this.options.Service.ListReconciled()).map(r => EnvironmentDtoMapper.ToDto(r))))
        read(C.LoadedGraphPath, async ctx => ctx.WriteJson(C.StatusOk, await this.options.Graphs.GetLoaded(ctx.Param(C.EnvParam))))
        read(C.GraphsPath, async ctx => ctx.WriteJson(C.StatusOk, await this.options.Graphs.List(ctx.Param(C.EnvParam))))
        write(HttpMethod.Post, C.GraphsPath, ctx => this.HandleCreateGraph(ctx))
        read(C.GraphPath, async ctx => ctx.WriteJson(C.StatusOk, await this.options.Graphs.Get(ctx.Param(C.EnvParam), ctx.Param(C.GraphParam))))
        write(HttpMethod.Delete, C.GraphPath, ctx => this.HandleDeleteGraph(ctx))
        write(HttpMethod.Post, C.PromotePath, ctx => this.HandlePromote(ctx))
        return table
    }

    /** The release-policy routes under `prefix` (a tenant's or, resolved to its tenant, a hive's). */
    private AddPolicyRoutes(write: (method: HttpMethod, pattern: string, handler: (ctx: RequestContext) => Promise<void>) => void, prefix: string, forHive: boolean): void
    {
        write(HttpMethod.Put, prefix + PolicySetting.Channels, ctx => this.HandlePolicy(ctx, forHive, PolicySetting.Channels, true))
        write(HttpMethod.Put, prefix + PolicySetting.MinVersion, ctx => this.HandlePolicy(ctx, forHive, PolicySetting.MinVersion, true))
        write(HttpMethod.Delete, prefix + PolicySetting.MinVersion, ctx => this.HandlePolicy(ctx, forHive, PolicySetting.MinVersion, false))
        write(HttpMethod.Post, prefix + PolicySetting.Hold, ctx => this.HandlePolicy(ctx, forHive, PolicySetting.Hold, true))
        write(HttpMethod.Delete, prefix + PolicySetting.Hold, ctx => this.HandlePolicy(ctx, forHive, PolicySetting.Hold, false))
    }

    // ---- The operator's session -------------------------------------------------------------------------------------

    private static RoleWire(role: OperatorRole): string
    {
        return role === OperatorRole.Full ? ControlPlaneHost.RoleFullWire : ControlPlaneHost.RoleReadOnlyWire
    }

    /** The signed-in operator of a Session route. */
    private static Who(ctx: RequestContext): OperatorPrincipal
    {
        return OperatorRoleClaims.PrincipalOf(ctx.RequireSession())
    }

    /**
     * GET /api/session: the signed-in operator as the app-host session answer `{ subject, claims }` (claims `email`,
     * `app_roles`, `amr`, refreshed from the operator's account by the gate), or 401. Public, so it never refuses earlier.
     */
    private HandleSession(ctx: RequestContext): void
    {
        CacheControl.NoStore(ctx.Response)
        if (ctx.Session === null)
        {
            ctx.WriteJson(ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
            return
        }
        ctx.WriteJson(ControlPlaneHost.StatusOk, { [ControlPlaneHost.SubjectField]: ctx.Session.Subject, [ControlPlaneHost.ClaimsField]: ctx.Session.Claims.ToJson() })
    }

    /** POST /api/logout: ends the cookie's session (if any) and its event sockets, clears the cookie. Public, so a stale cookie can still sign out. */
    private async HandleLogout(ctx: RequestContext): Promise<void>
    {
        JsonApi.Drain(ctx.Request)
        const token = this.gate.Token(ctx.Request)
        if (token !== null)
        {
            try
            {
                await this.sessions.Store.Revoke(token)
            }
            catch
            {
                // Refused in this process anyway (the store fails closed); the token is never logged.
            }
            this.registry.CloseToken(SessionStore.DigestOf(token))
        }
        ctx.Response.setHeader(ControlPlaneHost.SetCookieHeader, this.sessions.Cookie.BuildClearing())
        ctx.WriteJson(ControlPlaneHost.StatusOk, { ok: true })
    }

    /**
     * POST /api/session/password: the signed-in operator changes their own password. The identity is the session's, never
     * the body's. Throttled per (email, client address) through the sign-in throttle (a wrong current password is a password
     * guess); the attempt is counted at the gate, as sign-in counts it. On success the session store's Rotate ends every
     * session of the operator, the caller's own included, and hands the caller a fresh one, so the request making the change
     * stays signed in while every other session (and its live sockets) is cut. A wrong current password is 403, not 401: 401
     * means "your session is gone" to the portal. Every reply is no-store; no password is ever echoed, logged or audited
     * (the audit records the path and status only).
     */
    private async HandleChangeOwnPassword(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        CacheControl.NoStore(ctx.Response)
        const token = this.gate.Token(ctx.Request)
        const session = ctx.RequireSession()
        if (token === null)
        {
            JsonApi.Drain(ctx.Request)
            ctx.WriteJson(C.StatusUnauthorized, { error: C.UnauthenticatedMessage })
            return
        }
        const who = OperatorRoleClaims.PrincipalOf(session)
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        const current = body[C.CurrentPasswordField]
        const next = body[C.NewPasswordField]
        const confirm = body[C.ConfirmPasswordField]
        if (typeof current !== 'string' || current.length === 0 || typeof next !== 'string')
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.PasswordFieldsMessage })
            return
        }
        if (next.length < C.MinOperatorPasswordLength)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.WeakPasswordMessage })
            return
        }
        if (confirm !== undefined && confirm !== next)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.PasswordMismatchMessage })
            return
        }
        if (next === current)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.SamePasswordMessage })
            return
        }
        // One change per operator at a time: a second one's rotate would end the first's fresh session.
        if (this.passwordChanges.has(who.principalId))
        {
            ctx.WriteJson(C.StatusConflict, { error: C.PasswordChangeBusyMessage })
            return
        }
        this.passwordChanges.add(who.principalId)
        try
        {
            await this.ChangeOwnPasswordFor(ctx, who, token, session.Id, current, next)
        }
        finally
        {
            this.passwordChanges.delete(who.principalId)
        }
    }

    /** The throttled verify + change + session rotate of HandleChangeOwnPassword, run while the operator's in-flight guard is held. */
    private async ChangeOwnPasswordFor(ctx: RequestContext, who: OperatorPrincipal, token: string, sessionId: string, current: string, next: string): Promise<void>
    {
        const C = ControlPlaneHost
        const gate = await this.sessions.LoginThrottle.Attempt(who.email, ctx.ClientAddress)
        if (!gate.Allowed)
        {
            ctx.Response.setHeader(C.RetryAfterHeader, String(gate.RetryAfterSeconds()))
            ctx.WriteJson(C.StatusTooManyRequests, { error: C.TooManyPasswordAttemptsMessage })
            return
        }
        // The caller's session is shielded from the socket sweep until its sockets have moved to the fresh session: a sweep
        // running between the rotate and the Rekey would otherwise find it ended and close the caller's socket.
        this.protectedSessions.add(sessionId)
        let changed = false
        let fresh: { Token: string; Session: { Id: string; ExpiresAt: Date } } | null = null
        let otherSessionsEnded = true
        try
        {
            changed = await this.options.Operator.ChangeOwnPassword(who.principalId, current, next)
            if (changed)
            {
                const outcome = await this.RotateAfterPasswordChange(token, who.principalId)
                fresh = outcome.fresh
                otherSessionsEnded = outcome.otherSessionsEnded
                if (fresh !== null)
                {
                    this.registry.Rekey(sessionId, fresh.Session.Id)
                }
            }
        }
        finally
        {
            this.protectedSessions.delete(sessionId)
        }
        if (!changed)
        {
            ctx.WriteJson(C.StatusForbidden, { error: C.WrongCurrentPasswordMessage })
            return
        }
        await this.sessions.LoginThrottle.Succeeded(who.email, ctx.ClientAddress)
        // Every other socket of the operator held an ended session and closes now.
        await this.CloseRevokedSockets()
        if (fresh !== null)
        {
            ctx.Response.setHeader(C.SetCookieHeader, this.sessions.Cookie.Build(fresh.Token, fresh.Session.ExpiresAt))
        }
        // Sessions left un-ended are the warning that matters most (the caller's own is refused in this process anyway).
        const warning = !otherSessionsEnded ? C.OthersNotEndedWarning : (fresh === null ? C.SignInAgainWarning : undefined)
        ctx.WriteJson(C.StatusOk, { ok: true, otherSessionsEnded, ...(warning === undefined ? {} : { warning }) })
    }

    /**
     * After a completed password change: the session store's Rotate (every session of the operator ends, the caller gets one
     * fresh session, atomically). When the rotate cannot be written, every session of the operator is ended instead (the
     * caller signs in again); when even that cannot be written, the store refuses them in this process anyway and the
     * answer says the other sessions could not be signed out.
     */
    private async RotateAfterPasswordChange(token: string, principalId: string): Promise<{ fresh: { Token: string; Session: { Id: string; ExpiresAt: Date } } | null; otherSessionsEnded: boolean }>
    {
        try
        {
            const fresh = await this.sessions.Store.Rotate(token)
            if (fresh !== null)
            {
                return { fresh, otherSessionsEnded: true }
            }
        }
        catch
        {
            // The rotate was not written: fall back to ending every session of the operator.
        }
        try
        {
            await this.sessions.Store.RevokeSubject(principalId)
            return { fresh: null, otherSessionsEnded: true }
        }
        catch
        {
            return { fresh: null, otherSessionsEnded: false }
        }
    }

    // ---- Operators ----------------------------------------------------------------------------------------------------

    private async HandleListOperators(ctx: RequestContext): Promise<void>
    {
        const roster = await this.options.Operator.ListOperators()
        ctx.WriteJson(ControlPlaneHost.StatusOk, roster.map(o => ({ email: o.email, role: ControlPlaneHost.RoleWire(o.role), disabled: o.disabled })))
    }

    /** The password is never echoed. */
    private async HandleCreateOperator(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        const role = typeof body.role === 'string' ? C.OperatorRoles.get(body.role) : undefined
        if (typeof body.email !== 'string' || !C.PlausibleEmail(body.email) || typeof body.password !== 'string'
            || body.password.length < C.MinOperatorPasswordLength || role === undefined)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.OperatorFieldsMessage })
            return
        }
        await this.options.Operator.CreateOperator(body.email, body.password, role)
        ctx.WriteJson(C.StatusCreated, { email: body.email })
    }

    /** POST /api/operators/(role|password-reset|disabled|revoke-sessions): one operator mutation as the session actor. */
    private async HandleOperatorMutation(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        const mutation = ctx.Param(C.MutationParam)
        if (!(Object.values(OperatorMutation) as string[]).includes(mutation))
        {
            JsonApi.Drain(ctx.Request)
            ctx.WriteJson(C.StatusNotFound, { error: C.NotFoundMessage })
            return
        }
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        if (typeof body.email !== 'string' || body.email.trim().length === 0)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.OperatorEmailMessage })
            return
        }
        const email = body.email
        const who = C.Who(ctx)
        const operator = this.options.Operator
        switch (mutation as OperatorMutation)
        {
            case OperatorMutation.PasswordReset:
            {
                // The reset ends every session of the target (the caller's own too when they reset themselves); their live
                // event sockets close with them.
                const password = await operator.ResetOperatorPassword(email)
                await this.CloseRevokedSockets()
                CacheControl.NoStore(ctx.Response)
                ctx.WriteJson(C.StatusOk, { password })
                return
            }
            case OperatorMutation.RevokeSessions:
                await operator.RevokeOperatorSessions(email)
                await this.CloseRevokedSockets()
                ctx.WriteJson(C.StatusOk, {})
                return
            case OperatorMutation.Role:
            {
                const role = typeof body.role === 'string' ? C.OperatorRoles.get(body.role) : undefined
                if (role === undefined)
                {
                    ctx.WriteJson(C.StatusBadRequest, { error: C.OperatorRoleMessage })
                    return
                }
                await operator.SetOperatorRole(email, role, who.principalId)
                ctx.WriteJson(C.StatusOk, {})
                return
            }
            case OperatorMutation.Disabled:
                if (typeof body.disabled !== 'boolean')
                {
                    ctx.WriteJson(C.StatusBadRequest, { error: C.OperatorDisabledMessage })
                    return
                }
                await operator.SetOperatorDisabled(email, body.disabled, who.principalId)
                await this.CloseRevokedSockets()
                ctx.WriteJson(C.StatusOk, {})
                return
        }
    }

    /** Minimal shape check: exactly one '@' with a non-empty local part and domain. */
    private static PlausibleEmail(email: string): boolean
    {
        const parts = email.split(ControlPlaneHost.EmailAt)
        return parts.length === 2 && (parts[0] as string).length > 0 && (parts[1] as string).length > 0
    }

    // ---- Activity and fleet ---------------------------------------------------------------------------------------------

    /** GET /api/activity[?limit=N]: the newest operator audit entries (at most 200), newest first. */
    private async HandleActivity(ctx: RequestContext): Promise<void>
    {
        const entries = this.audit === undefined ? [] : await this.audit.Repository.Recent(this.ActivityLimit(ctx))
        const activity: ActivityDto[] = entries.map(e => ({ id: e.Id, actor: e.Actor, method: e.Action, path: e.Target, status: e.Status, at: e.At.toISOString(), ...(e.Note === undefined ? {} : { note: e.Note }) }))
        ctx.WriteJson(ControlPlaneHost.StatusOk, activity)
    }

    private ActivityLimit(ctx: RequestContext): number
    {
        const raw = ctx.Query.get(ControlPlaneHost.ActivityLimitParam)
        const n = raw === null ? NaN : Number.parseInt(raw, 10)
        return Number.isFinite(n) ? Math.min(Math.max(n, 1), ControlPlaneHost.ActivityLimitMax) : ControlPlaneHost.ActivityLimitMax
    }

    private HandleRollouts(ctx: RequestContext): void
    {
        const rollouts = this.options.Directory.ListHives().map(h =>
        {
            const s = this.options.Deployments.StatusFor(h.id)
            return { hiveId: h.id, targetVersion: s.targetVersion, environments: s.environments }
        })
        ctx.WriteJson(ControlPlaneHost.StatusOk, rollouts)
    }

    /** Joins every hive with its tenant, client and latest observation; carries no internal refs. */
    private BuildFleet(): FleetHiveDto[]
    {
        const directory = this.options.Directory
        return directory.ListHives().map(hive =>
        {
            const tenant = directory.GetTenant(hive.tenantId)
            const client = tenant === undefined ? undefined : directory.GetClient(tenant.clientId)
            const obs = this.options.Observations.LatestRecord(hive.id)
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

    // ---- Hives ----------------------------------------------------------------------------------------------------------

    /** The route's hive id when that hive exists; writes 404 and answers undefined otherwise. */
    private KnownHiveId(ctx: RequestContext): string | undefined
    {
        const id = ctx.Param(ControlPlaneHost.IdParam)
        if (this.options.Directory.GetHive(id) === undefined)
        {
            JsonApi.Drain(ctx.Request)
            ctx.WriteJson(ControlPlaneHost.StatusNotFound, { error: ControlPlaneHost.NotFoundMessage })
            return undefined
        }
        return id
    }

    /** GET /api/hives/ID/health: live workload health for each environment bound to the hive. */
    private HandleHiveHealth(ctx: RequestContext): void
    {
        const id = this.KnownHiveId(ctx)
        if (id !== undefined)
        {
            ctx.WriteJson(ControlPlaneHost.StatusOk, this.options.Observations.LatestFor(id))
        }
    }

    /** GET /api/hives/ID/observations: the hive's bounded health time-series, newest first. */
    private HandleHiveObservations(ctx: RequestContext): void
    {
        const id = this.KnownHiveId(ctx)
        if (id !== undefined)
        {
            ctx.WriteJson(ControlPlaneHost.StatusOk, [...this.options.Observations.HistoryFor(id, this.ActivityLimit(ctx))])
        }
    }

    /** GET /api/hives/ID/ledger: the hive's version-change timeline, newest first. */
    private HandleHiveLedger(ctx: RequestContext): void
    {
        const id = this.KnownHiveId(ctx)
        if (id !== undefined)
        {
            ctx.WriteJson(ControlPlaneHost.StatusOk, [...this.options.Deployments.LedgerFor(id, this.ActivityLimit(ctx))])
        }
    }

    /** GET /api/hives/ID/bootstrap: the agent's objects for the client's cluster. Secret-free; 409 while the agent channel is off or no platform release is verified. */
    private HandleHiveBootstrap(ctx: RequestContext): void
    {
        const C = ControlPlaneHost
        const id = this.KnownHiveId(ctx)
        if (id === undefined)
        {
            return
        }
        const channelUrl = this.options.AgentChannelUrl
        if (channelUrl === undefined)
        {
            ctx.WriteJson(C.StatusConflict, { error: C.AgentChannelOffMessage })
            return
        }
        const agentImage = this.platformImages.ImageOf(ReleaseApp.HiveAgent)
        if (agentImage === undefined)
        {
            ctx.WriteJson(C.StatusConflict, { error: PlatformImages.NoReleaseMessage })
            return
        }
        const hive = this.options.Directory.GetHive(id)
        const installer = this.options.AgentInstaller
        const autoInstall = hive !== undefined && installer !== undefined && installer.Supports(hive)
        ctx.WriteJson(C.StatusOk, HiveBootstrapBundle.For(id, channelUrl, autoInstall, agentImage))
    }

    /** GET /api/hives/ID/agent-install: the latest install's status (404 when none has run). Never carries the agent token. */
    private HandleAgentInstallStatus(ctx: RequestContext): void
    {
        const id = this.KnownHiveId(ctx)
        if (id === undefined)
        {
            return
        }
        const status = this.options.AgentInstaller?.StatusFor(id)
        if (status === undefined)
        {
            ctx.WriteJson(ControlPlaneHost.StatusNotFound, { error: ControlPlaneHost.NotFoundMessage })
            return
        }
        this.WriteInstallStatus(ctx, ControlPlaneHost.StatusOk, status)
    }

    /** POST /api/hives/ID/agent-install: starts the automatic agent install (202 + its first status; 409 when it cannot run or one is already running). */
    private HandleStartAgentInstall(ctx: RequestContext): void
    {
        const C = ControlPlaneHost
        const id = this.KnownHiveId(ctx)
        if (id === undefined)
        {
            return
        }
        JsonApi.Drain(ctx.Request)
        const installer = this.options.AgentInstaller
        if (installer === undefined)
        {
            ctx.WriteJson(C.StatusConflict, { error: C.AutoInstallOffMessage })
            return
        }
        if (this.hiveWrites.has(id))
        {
            ctx.WriteJson(C.StatusConflict, { error: C.HiveBusyMessage })
            return
        }
        if (this.options.ConsoleInstaller?.IsInstalling(id) === true)
        {
            ctx.WriteJson(C.StatusConflict, { error: C.ConsoleInstallRunningMessage })
            return
        }
        this.WriteInstallStatus(ctx, C.StatusAccepted, installer.Start(id))
    }

    /** GET /api/hives/ID/console-install: the latest console install's status (404 when none has run). Carries no secret. */
    private HandleConsoleInstallStatus(ctx: RequestContext): void
    {
        const id = this.KnownHiveId(ctx)
        if (id === undefined)
        {
            return
        }
        const status = this.options.ConsoleInstaller?.StatusFor(id)
        if (status === undefined)
        {
            ctx.WriteJson(ControlPlaneHost.StatusNotFound, { error: ControlPlaneHost.NotFoundMessage })
            return
        }
        this.WriteConsoleInstallStatus(ctx, ControlPlaneHost.StatusOk, status)
    }

    /**
     * POST /api/hives/ID/console-install: starts the in-hive console install (202 + its first status, no-store; 409 when it cannot
     * run, one is running, the agent is being installed, or another hive operation is in flight).
     */
    private HandleStartConsoleInstall(ctx: RequestContext): void
    {
        const C = ControlPlaneHost
        const id = this.KnownHiveId(ctx)
        if (id === undefined)
        {
            return
        }
        JsonApi.Drain(ctx.Request)
        const installer = this.options.ConsoleInstaller
        if (installer === undefined)
        {
            ctx.WriteJson(C.StatusConflict, { error: C.ConsoleInstallOffMessage })
            return
        }
        if (this.RefuseIfHiveBusy(ctx, id, C.AgentInstallRunningMessage))
        {
            return
        }
        this.WriteConsoleInstallStatus(ctx, C.StatusAccepted, installer.Start(id))
    }

    /**
     * POST /api/hives/ID/console/owner-password: sets a fresh Owner password in the hive's in-hive IdP and returns
     * { ownerEmail, ownerPassword } once (no-store). The installer records the reset first, so the console ends the Owner's
     * sessions at its next advert. The password is never logged or audited.
     */
    private async HandleHiveConsoleOwnerPassword(ctx: RequestContext): Promise<void>
    {
        const id = this.KnownHiveId(ctx)
        if (id === undefined)
        {
            return
        }
        JsonApi.Drain(ctx.Request)
        const installer = this.options.ConsoleInstaller
        if (installer === undefined)
        {
            ctx.WriteJson(ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.ConsoleInstallOffMessage })
            return
        }
        const reset: InHiveOwnerPassword = await installer.ResetOwnerPassword(id)
        CacheControl.NoStore(ctx.Response)
        ctx.WriteJson(ControlPlaneHost.StatusOk, reset)
    }

    /** PUT /api/hives/ID/console: stores where the hive serves its tenant's console and returns the updated hive (409 while any hive operation runs). */
    private async HandleSetHiveConsole(ctx: RequestContext): Promise<void>
    {
        const id = this.KnownHiveId(ctx)
        if (id === undefined)
        {
            return
        }
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        // Checked after the body is read, right before the write: a removal, delete or install that began meanwhile still wins.
        if (this.RefuseIfHiveBusy(ctx, id, ControlPlaneHost.AgentInstallBeforeSettingsMessage))
        {
            return
        }
        const hive: HiveDto = await this.options.Directory.SetHiveConsole(id, HiveConsoleSpecs.Parse(body))
        ctx.WriteJson(ControlPlaneHost.StatusOk, hive)
    }

    /**
     * DELETE /api/hives/ID/console: removes the console from a cluster the control plane drives (a refusing cluster answers 409
     * with kubectl's redacted text and keeps the setting), then clears the setting and returns { hive, retained }: retained names
     * what stays in the cluster, also in the audit note. Runs under the per-hive operation lock.
     */
    private async HandleRemoveHiveConsole(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        const id = this.KnownHiveId(ctx)
        if (id === undefined)
        {
            return
        }
        JsonApi.Drain(ctx.Request)
        if (this.RefuseIfHiveBusy(ctx, id, C.AgentInstallBeforeRemovalMessage))
        {
            return
        }
        this.hiveWrites.add(id)
        try
        {
            const hive = this.options.Directory.GetHive(id)
            const installer = this.options.ConsoleInstaller
            let outcome: ConsoleRemovalOutcome = { retained: [] }
            if (hive?.console !== undefined && installer?.CanUninstall(hive) === true)
            {
                try
                {
                    outcome = await installer.Uninstall(hive)
                }
                catch (err)
                {
                    if (!(err instanceof KubectlError))
                    {
                        throw err
                    }
                    ctx.WriteJson(C.StatusConflict, { error: C.ConsoleRemoveFailedPrefix + err.message })
                    return
                }
            }
            // The sealed IdP credentials stay: the kept IdP and environments still use that CA (forgotten on hive or tenant delete).
            const updated: HiveDto = await this.options.Directory.SetHiveConsole(id, undefined)
            await this.ForgetHiveAdvert(C.ConsoleRemoveLogPrefix, id)
            const note = C.ConsoleRemovalNote(outcome)
            if (note !== undefined)
            {
                ctx.NoteAudit(note)
            }
            ctx.WriteJson(C.StatusOk, { hive: updated, ...outcome })
        }
        finally
        {
            this.hiveWrites.delete(id)
        }
    }

    /** GET /api/hives/ID/rollout: the hive's target version and per-environment reported state. */
    private HandleHiveRollout(ctx: RequestContext): void
    {
        const status: HiveRolloutDto = this.options.Deployments.StatusFor(ctx.Param(ControlPlaneHost.IdParam))
        ctx.WriteJson(ControlPlaneHost.StatusOk, status)
    }

    /** POST /api/hives/ID/rollout-registration: (re)issues the hive's agent token, revealed once (no-store); 409 while another hive operation runs. */
    private async HandleRegisterHive(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        const id = this.KnownHiveId(ctx)
        if (id === undefined)
        {
            return
        }
        JsonApi.Drain(ctx.Request)
        // A reissue now would revoke the token a running install just stored, or race a delete.
        if (this.RefuseIfHiveBusy(ctx, id, C.ReissueDuringInstallMessage))
        {
            return
        }
        this.hiveWrites.add(id)
        let token: string
        try
        {
            token = await this.options.Deployments.RegisterHive(id)
        }
        finally
        {
            this.hiveWrites.delete(id)
        }
        // The one-time reveal: the raw agent token appears in this response body only; the registry stores just its hash.
        const dto: RolloutRegistrationDto = { token }
        CacheControl.NoStore(ctx.Response)
        ctx.WriteJson(C.StatusCreated, dto)
    }

    /**
     * Writes 409 and returns true when a token- or lifecycle-writing operation is already in flight for the hive: a running
     * agent install (with its own message), a running console install, or a reissue / delete / console removal.
     */
    private RefuseIfHiveBusy(ctx: RequestContext, id: string, installingMessage: string): boolean
    {
        const C = ControlPlaneHost
        if (this.options.AgentInstaller?.IsInstalling(id) === true)
        {
            ctx.WriteJson(C.StatusConflict, { error: installingMessage })
            return true
        }
        if (this.options.ConsoleInstaller?.IsInstalling(id) === true)
        {
            ctx.WriteJson(C.StatusConflict, { error: C.ConsoleInstallRunningMessage })
            return true
        }
        if (this.hiveWrites.has(id))
        {
            ctx.WriteJson(C.StatusConflict, { error: C.HiveBusyMessage })
            return true
        }
        return false
    }

    private WriteInstallStatus(ctx: RequestContext, status: number, body: InstallStatus): void
    {
        CacheControl.NoStore(ctx.Response)
        ctx.WriteJson(status, body)
    }

    private WriteConsoleInstallStatus(ctx: RequestContext, status: number, body: ConsoleInstallStatus): void
    {
        CacheControl.NoStore(ctx.Response)
        ctx.WriteJson(status, body)
    }

    // ---- Tenants: owner, email domains, gating, policy ---------------------------------------------------------------------

    /**
     * POST /api/tenants/ID/owner-password: sets a fresh Owner password in the tenant's IdP and returns { ownerEmail,
     * ownerPassword } once (no-store). The password is never logged or audited.
     */
    private async HandleOwnerPasswordReset(ctx: RequestContext): Promise<void>
    {
        JsonApi.Drain(ctx.Request)
        const reset: OwnerPasswordReset = await this.options.Provisioning.ResetOwnerPassword(ctx.Param(ControlPlaneHost.IdParam))
        CacheControl.NoStore(ctx.Response)
        ctx.WriteJson(ControlPlaneHost.StatusOk, reset)
    }

    /** GET /api/tenants/ID/email-domains: the report (404 for an unknown tenant). */
    private async HandleEmailDomainsReport(ctx: RequestContext, domains: PlatformEmailDomains): Promise<void>
    {
        await this.WriteDomainsReport(ctx, domains, ctx.Param(ControlPlaneHost.IdParam))
    }

    /**
     * PUT /api/tenants/ID/email-domains `{ domains }`: a control-plane tenant's record domains; each domain the save adds is
     * approved and named in the audit note (409 for an in-hive tenant). Answers the fresh report.
     */
    private async HandleSetEmailDomains(ctx: RequestContext, domains: PlatformEmailDomains): Promise<void>
    {
        const C = ControlPlaneHost
        const id = ctx.Param(C.IdParam)
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        if (!(C.DomainsKey in body))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: TenantEmailDomainsLimits.DomainsRequiredMessage })
            return
        }
        // The save approves only the domains it adds (policy-checked by the parse); the audit names them.
        const approved = await domains.SetAsOperator(id, body[C.DomainsKey])
        if (approved.length > 0)
        {
            ctx.NoteAudit(C.ApprovedOnSaveNotePrefix + approved.join(C.NoteSeparator))
        }
        await this.WriteDomainsReport(ctx, domains, id)
    }

    /**
     * POST /api/tenants/ID/email-domains/(approve|revoke|verify) `{ domain }`: one domain of any tenant (approving or verifying one
     * the tenant does not claim is 409, revoking or verifying a malformed name 400, verifying past the tenant's lookup limit 429, a
     * lookup that does not complete 503). The audit note names the domain. Answers the fresh report.
     */
    private async HandleEmailDomainAction(ctx: RequestContext, domains: PlatformEmailDomains, action: EmailDomainAction): Promise<void>
    {
        const C = ControlPlaneHost
        const id = ctx.Param(C.IdParam)
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        const domain = body[C.DomainKey]
        if (!C.NonEmpty(domain))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: TenantEmailDomainsLimits.DomainRequiredMessage })
            return
        }
        // Both answer the domain normalised and only once it passed the policy (approve) or the shape check (revoke), so the
        // audit note carries a well-formed name of at most 253 characters. Verify ignores any other key of the body (a token
        // included): the lookup uses the stored token. Its note comes from the answer's normalised domain.
        const noted = action === EmailDomainAction.Approve ? await domains.Approve(id, domain as string)
            : action === EmailDomainAction.Verify ? (await domains.VerifyDomainAsOperator(id, domain as string)).domain
            : await domains.Revoke(id, domain as string)
        ctx.NoteAudit(C.DomainNotePrefix + noted)
        await this.WriteDomainsReport(ctx, domains, id)
    }

    private async WriteDomainsReport(ctx: RequestContext, domains: PlatformEmailDomains, id: string): Promise<void>
    {
        const report = await domains.Report(id)
        if (report === undefined)
        {
            ctx.WriteJson(ControlPlaneHost.StatusNotFound, { error: ControlPlaneHost.NotFoundMessage })
            return
        }
        ctx.WriteJson(ControlPlaneHost.StatusOk, report)
    }

    /** POST /api/tenants/ID/gating `{ version }`: gates the tenant to the version (204). */
    private async HandleGate(ctx: RequestContext): Promise<void>
    {
        const requested = await this.ReadVersion(ctx)
        if (requested === undefined)
        {
            return
        }
        await this.options.Deployments.Gate(ctx.Param(ControlPlaneHost.IdParam), requested)
        ctx.Response.writeHead(ControlPlaneHost.StatusNoContent)
        ctx.Response.end()
    }

    /** DELETE /api/tenants/ID/gating/VERSION: withdraws the tenant's gate to the version (204). */
    private async HandleUngate(ctx: RequestContext): Promise<void>
    {
        JsonApi.Drain(ctx.Request)
        await this.options.Deployments.Ungate(ctx.Param(ControlPlaneHost.IdParam), ctx.Param(ControlPlaneHost.VersionParam))
        ctx.Response.writeHead(ControlPlaneHost.StatusNoContent)
        ctx.Response.end()
    }

    /**
     * /api/(tenants|hives)/ID/policy/(channels PUT | min-version PUT,DELETE | hold POST,DELETE): one release-policy change of a
     * tenant, or of a hive's own policy within its tenant (the owning tenant resolved from the directory; 404 for an unknown hive).
     */
    private async HandlePolicy(ctx: RequestContext, forHive: boolean, setting: PolicySetting, set: boolean): Promise<void>
    {
        const C = ControlPlaneHost
        const deployments = this.options.Deployments
        const id = ctx.Param(C.IdParam)
        let tenantId = id
        if (forHive)
        {
            const hive = this.options.Directory.GetHive(id)
            if (hive === undefined)
            {
                JsonApi.Drain(ctx.Request)
                ctx.WriteJson(C.StatusNotFound, { error: C.NotFoundMessage })
                return
            }
            tenantId = hive.tenantId
        }
        if (!set)
        {
            JsonApi.Drain(ctx.Request)
            const cleared = setting === PolicySetting.MinVersion
                ? (forHive ? await deployments.ClearMinVersionForHive(tenantId, id) : await deployments.ClearMinVersion(id))
                : (forHive ? await deployments.ClearHoldForHive(tenantId, id) : await deployments.ClearHold(id))
            ctx.WriteJson(C.StatusOk, cleared)
            return
        }
        if (setting === PolicySetting.MinVersion)
        {
            const v = await this.ReadVersion(ctx)
            if (v === undefined)
            {
                return
            }
            ctx.WriteJson(C.StatusOk, forHive ? await deployments.SetMinVersionForHive(tenantId, id, v) : await deployments.SetMinVersion(id, v))
            return
        }
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        if (setting === PolicySetting.Channels)
        {
            if (!Array.isArray(body.channels) || !body.channels.every(c => C.ChannelValues.includes(c as string)))
            {
                ctx.WriteJson(C.StatusBadRequest, { error: C.ChannelsInvalidMessage })
                return
            }
            const channels = body.channels as Channel[]
            ctx.WriteJson(C.StatusOk, forHive ? await deployments.SetChannelsForHive(tenantId, id, channels) : await deployments.SetChannels(id, channels))
            return
        }
        if (typeof body.reason !== 'string' || body.reason.trim().length === 0)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.ReasonRequiredMessage })
            return
        }
        const who = C.Who(ctx)
        const actor = who.email
        const reason = body.reason.trim()
        ctx.WriteJson(C.StatusOk, forHive ? await deployments.SetHoldForHive(tenantId, id, reason, actor) : await deployments.SetHold(id, reason, actor))
    }

    /** Reads the { version } body; writes the 400 and returns undefined when it is missing or invalid. */
    private async ReadVersion(ctx: RequestContext): Promise<string | undefined>
    {
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return undefined
        }
        if (!ControlPlaneHost.NonEmpty(body.version))
        {
            ctx.WriteJson(ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.VersionRequiredMessage })
            return undefined
        }
        return body.version as string
    }

    // ---- Releases -------------------------------------------------------------------------------------------------------

    /**
     * POST /api/releases/refresh: imports every new registry release and answers the refresh counts. 409 when no registry is
     * configured; a registry that is down or refuses the credential answers 502 with its fixed sentence. Any other failure is
     * logged like the poll logs it (the error's name only, never the error object) and answered as a plain 500. Concurrent
     * calls and the poll share one refresh.
     */
    private async HandleReleasesRefresh(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        JsonApi.Drain(ctx.Request)
        const releases = this.options.Releases
        if (releases === undefined)
        {
            ctx.WriteJson(C.StatusConflict, { error: C.ReleasesNotConfiguredMessage })
            return
        }
        let result: ReleaseRefreshResult
        try
        {
            result = await releases.Refresh()
        }
        catch (err)
        {
            if (err instanceof ReleaseRegistryUnavailableError)
            {
                throw err
            }
            console.error(C.ReleaseLogPrefix, C.ReleaseRefreshFailedLog + ReleaseRefresher.FailureText(err))
            ctx.WriteJson(C.StatusInternal, { error: C.ReleaseRefreshFailedMessage })
            return
        }
        ctx.WriteJson(C.StatusOk, result)
    }

    /** POST /api/manifests/VERSION/withdrawn `{ reason }`: withdraws the version (404 for an unknown one). */
    private async HandleWithdraw(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        if (typeof body.reason !== 'string' || body.reason.trim().length === 0)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.ReasonRequiredMessage })
            return
        }
        const who = C.Who(ctx)
        const manifest: ManifestDto = await this.options.Deployments.SetWithdrawn(ctx.Param(C.VersionParam), true, body.reason.trim(), who.email)
        ctx.WriteJson(C.StatusOk, manifest)
    }

    /** DELETE /api/manifests/VERSION/withdrawn: restores a withdrawn version (404 for an unknown one). */
    private async HandleRestore(ctx: RequestContext): Promise<void>
    {
        JsonApi.Drain(ctx.Request)
        ctx.WriteJson(ControlPlaneHost.StatusOk, await this.options.Deployments.SetWithdrawn(ctx.Param(ControlPlaneHost.VersionParam), false))
    }

    // ---- Platform records -----------------------------------------------------------------------------------------------

    private ListPlatform(resource: PlatformResource): readonly (ClientDto | TenantDto | HiveDto)[]
    {
        const directory = this.options.Directory
        switch (resource)
        {
            case PlatformResource.Clients:
                return directory.ListClients()
            case PlatformResource.Tenants:
                return directory.ListTenants().map(t => ControlPlaneHost.ToTenantDto(t))
            default:
                return directory.ListHives()
        }
    }

    /** Projects a stored tenant to its HTTP shape, dropping the internal IdP refs (base URL, CA path, admin-token ref). */
    private static ToTenantDto(record: TenantRecord): TenantDto
    {
        return { id: record.id, clientId: record.clientId, displayName: record.displayName, createdAt: record.createdAt, ownerEmail: record.ownerEmail, ownerPrincipalId: record.ownerPrincipalId }
    }

    private HandleGetPlatform(resource: PlatformResource, ctx: RequestContext): void
    {
        const record = this.GetPlatform(resource, ctx.Param(ControlPlaneHost.IdParam))
        if (record === undefined)
        {
            ctx.WriteJson(ControlPlaneHost.StatusNotFound, { error: ControlPlaneHost.NotFoundMessage })
            return
        }
        ctx.WriteJson(ControlPlaneHost.StatusOk, record)
    }

    private GetPlatform(resource: PlatformResource, id: string): ClientDto | TenantDto | HiveDto | undefined
    {
        const directory = this.options.Directory
        switch (resource)
        {
            case PlatformResource.Clients:
                return directory.GetClient(id)
            case PlatformResource.Tenants:
            {
                const tenant = directory.GetTenant(id)
                return tenant === undefined ? undefined : ControlPlaneHost.ToTenantDto(tenant)
            }
            default:
                return directory.GetHive(id)
        }
    }

    /**
     * DELETE /api/(clients|tenants|hives)/ID. A hive is deleted everywhere under the per-hive operation lock
     * (`?force=true` deletes anyway; the audit note says so, as the query itself is never audited) and answers what it kept.
     */
    private async HandleDeletePlatform(resource: PlatformResource, ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        JsonApi.Drain(ctx.Request)
        const id = ctx.Param(C.IdParam)
        if (resource !== PlatformResource.Hives)
        {
            await this.DeletePlatform(resource, id)
            ctx.WriteJson(C.StatusOk, { ok: true })
            return
        }
        if (this.RefuseIfHiveBusy(ctx, id, C.DeleteDuringInstallMessage))
        {
            return
        }
        const force = ctx.Query.get(C.ForceParam) === C.ForceValue
        this.hiveWrites.add(id)
        let outcome: HiveDeleteOutcome
        try
        {
            outcome = await this.DeleteHiveEverywhere(id, force)
        }
        finally
        {
            this.hiveWrites.delete(id)
        }
        const note = C.HiveDeleteNote(outcome, force)
        if (note !== undefined)
        {
            ctx.NoteAudit(note)
        }
        ctx.WriteJson(C.StatusOk, { ok: true, ...outcome })
    }

    /** Deletes a client or a tenant. Hives are deleted by DeleteHiveEverywhere, under the per-hive operation lock. */
    private async DeletePlatform(resource: PlatformResource, id: string): Promise<void>
    {
        const directory = this.options.Directory
        switch (resource)
        {
            case PlatformResource.Clients:
                await directory.DeleteClient(id)
                break
            case PlatformResource.Tenants:
                // Fail-closed: the hives guard runs first, then the per-tenant IdP is torn down BEFORE the record is removed,
                // so a teardown failure leaves the tenant record for retry rather than stranding a live IdP.
                directory.AssertTenantDeletable(id)
                await this.options.Idp?.TeardownForTenant(id)
                await directory.DeleteTenant(id)
                await this.options.Provisioning.ForgetTenant(id)
                await this.ForgetTenantConsoleCredentials(id)
                await this.ForgetTenantConsoleRecords(id)
                break
        }
    }

    /**
     * Drops a deleted tenant's in-hive IdP credentials. Best effort: the tenant is already gone, so a sealed-store failure only
     * leaves an unreachable sealed copy behind and must not turn the delete into an error.
     */
    private async ForgetTenantConsoleCredentials(tenantId: string): Promise<void>
    {
        const installer = this.options.ConsoleInstaller
        if (installer === undefined)
        {
            return
        }
        try
        {
            await installer.ForgetTenant(tenantId)
        }
        catch (err)
        {
            ControlPlaneHost.LogForgetFailure(ControlPlaneHost.TenantDeleteLogPrefix, tenantId, err)
        }
    }

    /** Logs a failed forget of console keys by the error's name only (a raw message may carry store details). */
    private static LogForgetFailure(prefix: string, hiveId: string, err: unknown, infix: string = ControlPlaneHost.ForgetFailedLogInfix): void
    {
        console.error(prefix + hiveId + infix + (err instanceof Error ? err.name : ControlPlaneHost.UnknownErrorName))
    }

    /**
     * Drops the console advert a hive's console reported. Best effort: the record or setting is already gone, so a store failure
     * only leaves a stale advert (never usable: it names a hive without a console) and must not turn the completed change into an
     * error. Callers run it only after the console setting is cleared (or the hive deleted): the receiver re-checks the setting at
     * write time, so an advert in flight during the removal is refused rather than stored after this forget.
     */
    private async ForgetHiveAdvert(prefix: string, hiveId: string): Promise<void>
    {
        const adverts = this.options.Adverts
        if (adverts === undefined)
        {
            return
        }
        try
        {
            await adverts.ForgetHive(hiveId)
        }
        catch (err)
        {
            ControlPlaneHost.LogForgetFailure(prefix, hiveId, err, ControlPlaneHost.ForgetAdvertLogInfix)
        }
    }

    /**
     * Drops a deleted tenant's console advert, email domain standing (approvals, revokes, verification tokens) and recorded
     * Owner reset; each best effort like ForgetHiveAdvert. The Owner reset is forgotten only here: a console removal or hive
     * delete keeps it (the console's data volume and its sessions survive both).
     */
    private async ForgetTenantConsoleRecords(tenantId: string): Promise<void>
    {
        const C = ControlPlaneHost
        try
        {
            await this.options.Adverts?.ForgetTenant(tenantId)
        }
        catch (err)
        {
            C.LogForgetFailure(C.TenantDeleteLogPrefix, tenantId, err, C.ForgetAdvertLogInfix)
        }
        try
        {
            await this.options.Approvals?.ForgetTenant(tenantId)
        }
        catch (err)
        {
            C.LogForgetFailure(C.TenantDeleteLogPrefix, tenantId, err, C.ForgetApprovalsLogInfix)
        }
        try
        {
            await this.options.ConsoleInstaller?.ForgetOwnerReset(tenantId)
        }
        catch (err)
        {
            C.LogForgetFailure(C.TenantDeleteLogPrefix, tenantId, err, C.ForgetOwnerResetLogInfix)
        }
    }

    /** The audit note of a console removal: what it kept (`retained: ...`), or that the kept objects could not be listed. */
    private static ConsoleRemovalNote(outcome: ConsoleRemovalOutcome): string | undefined
    {
        const C = ControlPlaneHost
        if (outcome.notice !== undefined)
        {
            return C.KeptNotListedNote
        }
        return outcome.retained.length === 0 ? undefined : C.RetainedNotePrefix + outcome.retained.join(C.NoteSeparator)
    }

    /** The audit note of a hive delete: that it was a delete anyway, what it kept (`retained: ...`) and which environment
     *  namespaces it could not delete (`failed: ...`). */
    private static HiveDeleteNote(outcome: HiveDeleteOutcome, forced: boolean): string | undefined
    {
        const C = ControlPlaneHost
        const parts: string[] = []
        if (forced)
        {
            parts.push(C.ForcedNote)
        }
        if (outcome.retained.length > 0)
        {
            parts.push(C.RetainedNotePrefix + outcome.retained.join(C.NoteSeparator))
        }
        if (outcome.failed.length > 0)
        {
            parts.push(C.FailedNotePrefix + outcome.failed.join(C.NoteSeparator))
        }
        return parts.length === 0 ? undefined : parts.join(C.AuditNoteSeparator)
    }

    /**
     * Deletes a hive, fail-closed, in this order: remove its in-hive console (when configured), its agent (and any console a
     * bootstrap installed) and the environment namespaces left labelled for it from the cluster (attached Local hives; all skipped
     * when forced, for a cluster that is unreachable or gone), destroy a provisioned cluster, revoke the agent token, the record, and
     * finally the console's sealed keys. A failure before the record's removal leaves the record (and, before the revoke, the token)
     * for a retry; a namespace that cannot be deleted is reported in `failed`, not retried. The environments guard runs first so a
     * non-empty hive never loses its cluster.
     */
    private async DeleteHiveEverywhere(id: string, force: boolean): Promise<HiveDeleteOutcome>
    {
        const C = ControlPlaneHost
        const directory = this.options.Directory
        const consoleInstaller = this.options.ConsoleInstaller
        const agentUninstaller = this.options.AgentUninstaller
        directory.AssertHiveDeletable(id)
        const hive = directory.GetHive(id)
        const uninstalls = hive !== undefined && agentUninstaller?.Covers(hive) === true
        const removesConsole = hive?.console !== undefined && consoleInstaller?.CanUninstall(hive) === true
        const outcome: HiveDeleteOutcome = { retained: [], failed: [] }
        const notices: string[] = []
        if (removesConsole && !force)
        {
            try
            {
                await consoleInstaller!.Uninstall(hive!)
            }
            catch (err)
            {
                if (err instanceof KubectlError)
                {
                    throw new ConsoleUninstallError(err.message)
                }
                throw err
            }
        }
        else if (removesConsole)
        {
            notices.push(C.ConsoleLeftNotice)
        }
        if (uninstalls && !force)
        {
            outcome.retained = await agentUninstaller!.Uninstall(hive!)
            outcome.failed = await agentUninstaller!.DeleteEnvironmentNamespaces(hive!)
            if (outcome.failed.length > 0)
            {
                notices.push(C.NamespacesLeftNoticePrefix + outcome.failed.join(C.NoteSeparator) + C.SentenceEnd)
            }
        }
        else if (uninstalls)
        {
            notices.push(C.AgentLeftNotice)
        }
        if (!force)
        {
            try
            {
                await this.options.Deployments.DestroyHiveCluster(id)
            }
            catch (err)
            {
                HiveClusterDestroyError.From(err)
            }
        }
        else if (hive?.cluster.mode === InfraMode.Provision && hive.cluster.backend === HiveBackend.Local)
        {
            notices.push(C.KindClusterLeftNotice)
        }
        await this.options.Deployments.DeregisterHive(id)
        await directory.DeleteHive(id)
        await this.ForgetHiveAdvert(C.ForgetFailedLogPrefix, id)
        // The console's fingerprint key and in-hive IdP credentials go with the hive, forced or not. Best effort: the hive is
        // already gone, so a sealed-store failure only leaves unreachable sealed keys behind and must not turn the delete into an
        // error.
        if (hive !== undefined && consoleInstaller !== undefined)
        {
            try
            {
                await consoleInstaller.Forget(hive)
            }
            catch (err)
            {
                C.LogForgetFailure(C.ForgetFailedLogPrefix, id, err)
            }
        }
        if (notices.length > 0)
        {
            outcome.notice = notices.join(C.NoticeSeparator)
        }
        return outcome
    }

    /** POST /api/(clients|tenants|hives): creates a client, provisions a tenant (its Owner password revealed once) or registers a hive. */
    private async HandleCreatePlatform(resource: PlatformResource, ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        if (!C.NonEmpty(body.id))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.IdRequiredMessage })
            return
        }
        if (typeof body.displayName !== 'string')
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.DisplayNameRequiredMessage })
            return
        }
        const id = body.id as string
        const displayName = body.displayName
        const directory = this.options.Directory
        let created: ClientDto | TenantDto | HiveDto
        if (resource === PlatformResource.Clients)
        {
            if (!C.OptionalString(body.subscriptionRef))
            {
                ctx.WriteJson(C.StatusBadRequest, { error: C.OptionalStringMessage })
                return
            }
            created = await directory.CreateClient({ id, displayName, subscriptionRef: body.subscriptionRef as string | undefined })
        }
        else if (resource === PlatformResource.Tenants)
        {
            if (!C.NonEmpty(body.clientId))
            {
                ctx.WriteJson(C.StatusBadRequest, { error: C.ClientIdRequiredMessage })
                return
            }
            if (!C.NonEmpty(body.ownerEmail))
            {
                ctx.WriteJson(C.StatusBadRequest, { error: C.OwnerEmailRequiredMessage })
                return
            }
            if (id.startsWith(C.ReservedIdPrefix))
            {
                ctx.WriteJson(C.StatusBadRequest, { error: C.ReservedIdMessage })
                return
            }
            const { record, ownerPassword } = await this.options.Provisioning.Provision({ id, clientId: body.clientId as string, displayName, ownerEmail: body.ownerEmail as string })
            // The one-time Owner password is revealed exactly once here; never logged or stored.
            CacheControl.NoStore(ctx.Response)
            // In-hive sign-in seeds no password: the Owner signs in through the tenant's hive, so none is shown.
            const owner = ownerPassword === undefined
                ? { email: record.ownerEmail, principalId: record.ownerPrincipalId }
                : { email: record.ownerEmail, principalId: record.ownerPrincipalId, password: ownerPassword }
            ctx.WriteJson(C.StatusCreated, { ...C.ToTenantDto(record), owner })
            return
        }
        else
        {
            if (!C.NonEmpty(body.tenantId))
            {
                ctx.WriteJson(C.StatusBadRequest, { error: C.TenantIdRequiredMessage })
                return
            }
            const cluster = C.ParseCluster(body.cluster)
            if (cluster === undefined)
            {
                ctx.WriteJson(C.StatusBadRequest, { error: C.ClusterInvalidMessage + Object.values(HiveBackend).join(C.ValueListSeparator) })
                return
            }
            const registry = C.ParseRegistry(body.registry)
            if (registry === undefined)
            {
                ctx.WriteJson(C.StatusBadRequest, { error: C.RegistryInvalidMessage + Object.values(InfraMode).join(C.ValueListSeparator) })
                return
            }
            if (!C.OptionalString(body.trustRootRef))
            {
                ctx.WriteJson(C.StatusBadRequest, { error: C.OptionalStringMessage })
                return
            }
            created = await directory.CreateHive({
                id,
                tenantId: body.tenantId as string,
                displayName,
                cluster,
                registry,
                trustRootRef: body.trustRootRef as string | undefined
            })
        }
        ctx.WriteJson(C.StatusCreated, created)
    }

    /** POST /api/provision: a client, tenant and hive in one go (each new or `existing`), its one-time secrets revealed once. */
    private async HandleProvision(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        const client = body.client as Record<string, unknown> | undefined
        const tenant = body.tenant as Record<string, unknown> | undefined
        const hive = body.hive as Record<string, unknown> | undefined
        if (!C.IsObject(client) || !C.IsObject(tenant) || !C.IsObject(hive))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.SubObjectRequiredMessage })
            return
        }
        const idsOk = C.NonEmpty(client.id) && C.NonEmpty(tenant.id) && C.NonEmpty(hive.id)
        if (!idsOk)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.IdRequiredMessage })
            return
        }
        // `existing: true` references a record that already exists; only its id is read.
        if (!C.OptionalBoolean(client.existing) || !C.OptionalBoolean(tenant.existing))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.ExistingFlagMessage })
            return
        }
        const existingClient = client.existing === true
        const existingTenant = tenant.existing === true
        if ((!existingClient && typeof client.displayName !== 'string') || (!existingTenant && typeof tenant.displayName !== 'string') || typeof hive.displayName !== 'string')
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.DisplayNameRequiredMessage })
            return
        }
        if (!existingTenant && !C.NonEmpty(tenant.ownerEmail))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.OwnerEmailRequiredMessage })
            return
        }
        if (!existingTenant && (tenant.id as string).startsWith(C.ReservedIdPrefix))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.ReservedIdMessage })
            return
        }
        const cluster = C.ParseCluster(hive.cluster)
        if (cluster === undefined)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.ClusterInvalidMessage + Object.values(HiveBackend).join(C.ValueListSeparator) })
            return
        }
        const registry = C.ParseRegistry(hive.registry)
        if (registry === undefined)
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.RegistryInvalidMessage + Object.values(InfraMode).join(C.ValueListSeparator) })
            return
        }
        if (!C.OptionalString(client.subscriptionRef) || !C.OptionalString(hive.trustRootRef))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.OptionalStringMessage })
            return
        }
        try
        {
            const result = await this.orchestrator.Provision({
                client: existingClient
                    ? { existing: true, id: client.id as string }
                    : { id: client.id as string, displayName: client.displayName as string, subscriptionRef: client.subscriptionRef as string | undefined },
                tenant: existingTenant
                    ? { existing: true, id: tenant.id as string }
                    : { id: tenant.id as string, displayName: tenant.displayName as string, ownerEmail: tenant.ownerEmail as string },
                hive: { id: hive.id as string, displayName: hive.displayName, cluster, registry, trustRootRef: hive.trustRootRef as string | undefined }
            })
            // The one-time secrets (the Owner password only for a new tenant) are revealed exactly once here; never logged or stored.
            CacheControl.NoStore(ctx.Response)
            ctx.WriteJson(C.StatusCreated, { client: result.client, tenant: C.ToTenantDto(result.tenant), hive: result.hive, secrets: result.secrets })
        }
        catch (e)
        {
            if (e instanceof ProvisionFailedError)
            {
                ctx.WriteJson(C.StatusInternal, { error: e.message, rollback: e.rollback })
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

    private static OptionalBoolean(v: unknown): boolean
    {
        return v === undefined || typeof v === 'boolean'
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

    // ---- Graphs ---------------------------------------------------------------------------------------------------------

    /** POST /api/environments/SOURCE/graphs/GRAPH/promote `{ targetEnv }`: relays the promotion into the runtime target. */
    private async HandlePromote(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        if (!C.NonEmpty(body.targetEnv))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.TargetEnvRequiredMessage })
            return
        }
        ctx.WriteJson(C.StatusOk, await this.options.Graphs.Promote(ctx.Param(C.EnvParam), ctx.Param(C.GraphParam), body.targetEnv as string))
    }

    private async HandleCreateGraph(ctx: RequestContext): Promise<void>
    {
        const C = ControlPlaneHost
        const body = await this.ReadJsonObject(ctx)
        if (body === undefined)
        {
            return
        }
        if (!C.NonEmpty(body.name))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.NameRequiredMessage })
            return
        }
        if (!C.NonEmpty(body.description))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.DescriptionRequiredMessage })
            return
        }
        const rec = await this.options.Graphs.Create(ctx.Param(C.EnvParam), body.name as string, body.description as string)
        ctx.WriteJson(C.StatusCreated, rec)
    }

    private async HandleDeleteGraph(ctx: RequestContext): Promise<void>
    {
        JsonApi.Drain(ctx.Request)
        await this.options.Graphs.Delete(ctx.Param(ControlPlaneHost.EnvParam), ctx.Param(ControlPlaneHost.GraphParam))
        ctx.WriteJson(ControlPlaneHost.StatusOk, { ok: true })
    }

    // ---- Shared ---------------------------------------------------------------------------------------------------------

    /** Reads and parses a JSON object body (capped at the route's limit, else 413); writes the 400 and returns undefined when it is not one. */
    private async ReadJsonObject(ctx: RequestContext): Promise<Record<string, unknown> | undefined>
    {
        const C = ControlPlaneHost
        const raw = await JsonApi.ReadText(ctx.Request, ctx.BodyLimit)
        let body: unknown
        try
        {
            body = JSON.parse(raw)
        }
        catch
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.BadJsonMessage })
            return undefined
        }
        if (!C.IsObject(body))
        {
            ctx.WriteJson(C.StatusBadRequest, { error: C.BodyObjectMessage })
            return undefined
        }
        return body
    }

    private static NonEmpty(v: unknown): boolean
    {
        return typeof v === 'string' && v.length > 0
    }

    // ---- The events socket ----------------------------------------------------------------------------------------------

    /**
     * An operator events socket that passed the host's upgrade checks (allowed Host and Origin, a single-use ticket naming a
     * live session). Re-checked once the handshake completed: a logout that ran after the ticket's redeem would otherwise find
     * no socket to close. Tracked per session, so a logout, a revoke or the periodic sweep closes it.
     */
    private AdmitClient(ws: WebSocket, ctx: SocketContext): void
    {
        // Attached synchronously, before any await: an error mid-validation must not surface as an unhandled event.
        ws.on(ControlPlaneHost.ErrorEvent, () => ws.terminate())
        const session = ctx.Session
        if (session === null)
        {
            ws.terminate()
            return
        }
        void this.StillLive(session.Id).then(live =>
        {
            if (!live || ws.readyState !== WebSocket.OPEN)
            {
                ws.terminate()
                return
            }
            this.AddClient(session.Id, ws)
            ws.on(ControlPlaneHost.CloseEvent, () => this.OnClientGone())
        })
    }

    /** Whether the session is still live and its operator still signed in (never throws: a failed check answers false). */
    private async StillLive(sessionId: string): Promise<boolean>
    {
        try
        {
            const session = await this.sessions.Store.ValidateId(sessionId)
            return session !== null && (await this.gate.Refreshed(session)) !== null
        }
        catch
        {
            return false
        }
    }

    /** Tracks an operator ws client; the first one subscribes to environment lifecycle changes (made on any plane) to push them. */
    private AddClient(sessionId: string, ws: WebSocket): void
    {
        this.registry.Add(sessionId, ws)
        if (this.changeSubscription === undefined)
        {
            this.changeSubscription = this.options.Service.OnChanged(() => this.Broadcast({ type: ControlPlaneHost.ChangedType }))
        }
    }

    private OnClientGone(): void
    {
        if (this.registry.Size() === 0)
        {
            this.ReleaseChangeSubscription()
        }
    }

    /** Periodically closes sockets whose session no longer validates (expired or revoked elsewhere). */
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
            await this.CloseRevokedSockets()
        }
        finally
        {
            this.revalidating = false
        }
    }

    /**
     * Closes every event socket whose session no longer validates. Run by the periodic sweep and, at once, after a change that
     * ends sessions (a password reset or change, a disable, a revoke), so the cut is not left to the next tick. A check that
     * fails (the store is unreachable) leaves the socket for the next tick.
     */
    private async CloseRevokedSockets(): Promise<void>
    {
        for (const sessionId of this.registry.Tokens())
        {
            let live: boolean
            try
            {
                const session = await this.sessions.Store.ValidateId(sessionId)
                live = session !== null && (await this.gate.Refreshed(session)) !== null
            }
            catch
            {
                continue
            }
            // Re-checked after the await: a session shielded by a running own-password change is never closed here.
            if (!live && !this.protectedSessions.has(sessionId))
            {
                this.registry.CloseToken(sessionId)
            }
        }
    }

    private ReleaseChangeSubscription(): void
    {
        this.changeSubscription?.()
        this.changeSubscription = undefined
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
}
