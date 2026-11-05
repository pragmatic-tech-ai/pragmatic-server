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
import type { IIdpService } from './idp-service.js'
import { PortUnavailableError } from './port-allocator.js'
import { IdpUnreachableError, OwnerAccountMissingError, OwnerIdpRefusedError, OwnerNotRecordedError, OwnerResetInProgressError, TenantIdpMissingError, type OwnerPasswordReset, type TenantProvisioningService } from './tenant-provisioning-service.js'
import { InvalidEnvironmentNameError } from './template-catalog.js'
import { LastOperatorError, OperatorExistsError, OperatorNotFoundError, OperatorProtectedError, OperatorRole, OperatorSelfLockoutError, type IOperatorIdentity, type OperatorPrincipal, type OwnPasswordChange } from './operator-identity.js'
import { OperatorAuthorization } from './operator-authorization.js'
import { AuditRegistry } from './audit-record.js'
import type { AuditThrottle } from './audit-throttle.js'
import type { DesktopDiscoveryEndpoint } from './desktop-discovery-endpoint.js'
import { Channel } from './channel.js'
import { SessionCookie } from './session-cookie.js'
import { EventsTicketStore } from './events-ticket-store.js'
import { OperatorSocketRegistry } from './operator-socket-registry.js'
import { AdminProxyError, AdminProxyErrorKind, type AdminSnapshot } from './admin-proxy.js'
import {
    ClientHasTenantsError,
    HiveHasEnvironmentsError,
    InHiveConsoleTakenError,
    RecordExistsError,
    TenantClientMismatchError,
    TenantHasHivesError,
    UnknownClientError,
    UnknownTenantError,
    type PlatformDirectory
} from './platform-directory.js'
import { HivePlacementError } from './hive-placement-error.js'
import { HiveBootstrapBundle } from './hive-bootstrap-bundle.js'
import { HiveConsoleSpecs, InvalidHiveConsoleError } from './hive-console-spec.js'
import { InvalidIngressTlsError } from './ingress-tls.js'
import { AgentInstallInProgressError, AgentInstallUnavailableError, type HiveAgentInstaller, type InstallStatus } from './hive-agent-installer.js'
import { AgentUninstallError, ConsoleUninstallError, HiveClusterDestroyError, type HiveAgentUninstaller } from './hive-agent-uninstaller.js'
import { ConsoleInstallInProgressError, ConsoleInstallUnavailableError, ConsoleNotConfiguredError, type ConsoleInstallStatus, type ConsoleRemovalOutcome, type TenantConsoleInstaller } from './tenant-console-installer.js'
import { InHiveIdpUnavailableError, type InHiveOwnerPassword } from './in-hive-idp-admin.js'
import { HiveBackend, InfraMode, InvalidRecordIdError } from './platform-records.js'
import { PlaneHttp } from './plane-http.js'
import { ProvisioningOrchestrator, ProvisionFailedError } from './provisioning-orchestrator.js'
import { UnsupportedBackendError } from './hive-orchestrator.js'
import { KubectlError, PortForwardError } from './kubectl.js'
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
    AdminIssueDeployToken(name: string): Promise<TokenIssuedDto>
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
/**
 * A hive delete's outcome for the operator: what was deliberately kept, what could not be removed (environment namespaces whose
 * delete failed), and what a delete anyway may have left behind.
 */
type HiveDeleteOutcome = { retained: string[]; failed: string[]; notice?: string }
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
    /** The signed-in operator's own password change; any role (a ReadOnly operator may change their own password). */
    private static readonly SessionPasswordPath = OperatorAuthorization.SessionPasswordPath
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
    private static readonly UnsupportedMediaMessage = 'Content-Type must be application/json'
    private static readonly BadNameMessage = 'Invalid environment name in path'
    private static readonly NotListeningMessage = 'ControlPlaneHost is not listening'
    private static readonly OperationFailedMessage = 'Environment operation failed'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly LogPrefix = '[control-plane] request failed:'
    private static readonly ApiPrefix = '/api/'
    private static readonly ActivityAllPath = '/api/activity'
    private static readonly ActivityLimitMax = 200
    private static readonly MaxAuditPathLength = 256
    private static readonly ActivityLimitParam = 'limit'
    private static readonly AuditUnsetValue = ''
    private static readonly AuditFailureFallback = 'AuditError'
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
    private static readonly ObservationsSegment = 'observations'
    private static readonly LedgerSegment = 'ledger'
    private static readonly HiveLedgerPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.LedgerSegment + '$')
    private static readonly BootstrapSegment = 'bootstrap'
    private static readonly HiveBootstrapPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.BootstrapSegment + '$')
    private static readonly AgentChannelOffMessage = 'The agent channel is not configured: start the control plane with PRAGMATIC_AGENT_CHANNEL_PORT so hives can dial home.'
    private static readonly AgentInstallSegment = 'agent-install'
    private static readonly HiveAgentInstallPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.AgentInstallSegment + '$')
    /** `DELETE /api/hives/ID?force=true`: delete anyway, skipping the agent's removal from an unreachable cluster. */
    private static readonly ForceParam = 'force'
    private static readonly ForceValue = 'true'
    private static readonly ForceAuditSuffix = '?' + ControlPlaneHost.ForceParam + '=' + ControlPlaneHost.ForceValue
    private static readonly ConsoleSegment = 'console'
    private static readonly HiveConsolePathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.ConsoleSegment + '$')
    private static readonly ConsoleInstallSegment = 'console-install'
    private static readonly HiveConsoleInstallPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.ConsoleInstallSegment + '$')
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
    private static readonly UnknownErrorName = 'Error'
    private static readonly NamespacesLeftNoticePrefix = 'These environment namespaces could not be deleted and may remain in the cluster: '
    private static readonly NoticeSeparator = ' '
    private static readonly SentenceEnd = '.'
    private static readonly FailedNotePrefix = 'failed: '
    private static readonly AuditNoteSeparator = '; '
    private static readonly HiveItemPathPattern = new RegExp('^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/[^/]+$')
    private static readonly AgentLeftNotice = 'The agent was not removed: the agent may remain in the cluster, locked out (its token is revoked), until someone removes it.'
    private static readonly KindClusterLeftNotice = "The hive's kind cluster was not destroyed: the kind cluster may be left behind on this machine."
    private static readonly RetainedNotePrefix = 'retained: '
    private static readonly KeptNotListedNote = 'kept objects not listed'
    private static readonly NoteSeparator = ', '
    private static readonly AutoInstallOffMessage = 'Automatic install is not available on this control plane. Install the agent manually.'
    private static readonly ReissueDuringInstallMessage = 'An agent install is running for this hive and issues its own token. Wait for it to finish (or fail) before reissuing the token.'
    private static readonly DeleteDuringInstallMessage = 'An agent install is running for this hive. Wait for it to finish (or fail) before deleting the hive.'
    private static readonly HiveBusyMessage = "Another operation on this hive's agent token or lifecycle (a token reissue or a delete) is in progress. Wait for it to finish, then try again."
    private static readonly HiveObservationsPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.ObservationsSegment + '$')
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
    private static readonly OwnerPasswordSegment = 'owner-password'
    private static readonly TenantOwnerPasswordPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.TenantsSegment + '/([^/]+)/' + ControlPlaneHost.OwnerPasswordSegment + '$')
    /** POST /api/hives/ID/console/owner-password: a fresh Owner password in the hive's in-hive IdP. */
    private static readonly HiveConsoleOwnerPasswordPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.ConsoleSegment + '/' + ControlPlaneHost.OwnerPasswordSegment + '$')
    private static readonly TenantPolicyPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.TenantsSegment + '/([^/]+)/' + ControlPlaneHost.PolicySegment + '/(' +
        [ControlPlaneHost.ChannelsSegment, ControlPlaneHost.MinVersionSegment, ControlPlaneHost.HoldSegment].join('|') + ')$')
    private static readonly HivePolicyPathPattern = new RegExp(
        '^' + ControlPlaneHost.ApiPrefix + ControlPlaneHost.HivesSegment + '/([^/]+)/' + ControlPlaneHost.PolicySegment + '/(' +
        [ControlPlaneHost.ChannelsSegment, ControlPlaneHost.MinVersionSegment, ControlPlaneHost.HoldSegment].join('|') + ')$')
    private static readonly VersionRequiredMessage = 'version (non-empty string) is required'
    private static readonly ImageRequiredMessage = 'image (non-empty string) is required'
    private static readonly NotesInvalidMessage = 'notes must be a string'
    private static readonly ChannelInvalidMessage = 'channel must be one of: stable, early'
    private static readonly ChannelsInvalidMessage = 'channels must be an array of: stable, early'
    private static readonly ChannelValues: readonly string[] = Object.values(Channel)
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
    private static readonly ExistingFlagMessage = 'existing must be a boolean when given'
    private static readonly ClusterInvalidMessage = 'cluster must be { backend, mode } with valid values; backend one of: '
    private static readonly RegistryInvalidMessage = 'registry must be { mode, endpoint?, credentialRef? } with a valid mode; mode one of: '
    private static readonly LoginPath = '/api/login'
    private static readonly DiscoverPath = '/api/desktop/discover'
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
    private static readonly TooManyRequestsMessage = 'Too many requests'
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
    private static readonly StatusAccepted = 202
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
        [TenantClientMismatchError, ControlPlaneHost.StatusBadRequest],
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
        [AgentInstallUnavailableError, ControlPlaneHost.StatusConflict],
        [AgentInstallInProgressError, ControlPlaneHost.StatusConflict],
        [InvalidHiveConsoleError, ControlPlaneHost.StatusBadRequest],
        [InvalidIngressTlsError, ControlPlaneHost.StatusBadRequest],
        [InHiveConsoleTakenError, ControlPlaneHost.StatusConflict],
        [ConsoleNotConfiguredError, ControlPlaneHost.StatusConflict],
        [ConsoleInstallUnavailableError, ControlPlaneHost.StatusConflict],
        [ConsoleInstallInProgressError, ControlPlaneHost.StatusConflict],
        [InHiveIdpUnavailableError, ControlPlaneHost.StatusConflict],
        // The hive's cluster refused or could not be reached while its agent was being removed: the operator fixes cluster
        // access and retries, or deletes anyway. A conflict, not a server error (5xx answers are masked as generic 500s).
        [AgentUninstallError, ControlPlaneHost.StatusConflict],
        // The console (or its environment namespaces) could not be removed: same remedy and code as the agent's removal.
        [ConsoleUninstallError, ControlPlaneHost.StatusConflict],
        // The tunnel to an in-hive IdP did not open (its pod is down or not ready): unavailable, not a masked server error.
        [PortForwardError, ControlPlaneHost.StatusUnavailable],
        // A provisioned hive's kind cluster could not be destroyed (kind / Docker down): fix it and retry, or delete anyway.
        [HiveClusterDestroyError, ControlPlaneHost.StatusConflict],
        // Owner password reset: state the operator must fix -> 409; an unreachable tenant IdP -> 503 (not masked).
        [OwnerNotRecordedError, ControlPlaneHost.StatusConflict],
        [TenantIdpMissingError, ControlPlaneHost.StatusConflict],
        [OwnerAccountMissingError, ControlPlaneHost.StatusConflict],
        [OwnerIdpRefusedError, ControlPlaneHost.StatusConflict],
        [IdpUnreachableError, ControlPlaneHost.StatusUnavailable],
        [OwnerResetInProgressError, ControlPlaneHost.StatusConflict],
    ])

    private httpServer: HttpServer | undefined
    private wsServer: WebSocketServer | undefined
    private changeSubscription: (() => void) | undefined
    private revalidating = false
    /** Operators (principal ids) with an own-password change in flight: a second one is refused (409). */
    private readonly passwordChanges = new Set<string>()
    /** Session tokens the socket sweep must not close: their own-password change is moving their sockets to a fresh token. */
    private readonly protectedTokens = new Set<string>()
    private revalidateTimer: ReturnType<typeof setInterval> | undefined
    private readonly staticRootAbs: string
    private readonly allowedHosts: ReadonlySet<string>
    private readonly orchestrator: ProvisioningOrchestrator
    /**
     * Hives with a token reissue or a delete in flight. One token- or lifecycle-writing operation per hive at a time: an
     * install, a reissue and a delete each refuse (409) while another runs (a running install counts too), so e.g. an
     * install cannot recreate the cluster a delete is tearing down.
     */
    private readonly hiveWrites = new Set<string>()
    /** A handler's note for its request's audit entry (written once, after the response, by Handle). */
    private readonly auditNotes = new WeakMap<ServerResponse, string>()
    /** Audit appends still running (each starts after its response was sent); Close waits for them. */
    private readonly pendingAudits = new Set<Promise<void>>()

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
        private readonly authorization: OperatorAuthorization = new OperatorAuthorization(),
        private readonly audit?: AuditRegistry,
        private readonly auditThrottle?: AuditThrottle,
        private readonly idp?: IIdpService,
        /** The pod-visible agent channel URL a hive's bootstrap points its agent at; undefined while the channel is off. */
        private readonly agentChannelUrl?: string,
        /** Installs a Local hive's agent from the control plane itself; undefined disables the automatic path. */
        private readonly agentInstaller?: HiveAgentInstaller,
        /** Removes a hive's agent from its cluster when the hive is deleted; undefined removes only platform state. */
        private readonly agentUninstaller?: HiveAgentUninstaller,
        /** Public desktop email discovery (POST /api/desktop/discover); undefined leaves the route unmounted. */
        private readonly discovery?: DesktopDiscoveryEndpoint,
        /** Installs (and removes) a Local hive's in-hive tenant console; undefined disables the console routes' actions. */
        private readonly consoleInstaller?: TenantConsoleInstaller)
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
            await this.CloseRevokedSockets()
        }
        finally
        {
            this.revalidating = false
        }
    }

    /**
     * Closes every event socket whose session token no longer validates. Run by the periodic sweep and, at once, after a
     * change that ends sessions (a password reset or change, a disable, a revoke), so the cut is not left to the next tick.
     */
    private async CloseRevokedSockets(): Promise<void>
    {
        for (const token of this.registry.Tokens())
        {
            try
            {
                // Re-checked after the await: a token shielded by a running own-password change is never closed here.
                if ((await this.operator.ValidateToken(token)) === null && !this.protectedTokens.has(token))
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
        // An audit write runs after its response, so a caller can see the response before the write ends:
        // Close resolves only once none is still writing (AppendAudit never rejects).
        await Promise.all([...this.pendingAudits])
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
        // Set only once an authorized, non-public mutation reaches dispatch; the single emit site is the
        // finally below, so a handler that returns OR throws is audited exactly once on the final status.
        let auditActor: string | null = null
        let auditMethod = ControlPlaneHost.AuditUnsetValue
        let auditPath = ControlPlaneHost.AuditUnsetValue
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
            const method = req.method ?? PlaneHttp.MethodGet
            let who: OperatorPrincipal | null = null
            if (path.startsWith(ControlPlaneHost.ApiPrefix))
            {
                if (PlaneHttp.IsMutating(req) && !this.OriginAllowed(req))
                {
                    req.resume()
                    // Audited as (anonymous) (no actor yet), but under per-ip throttle + the anonymous quota
                    // so an unauthenticated cross-origin caller cannot flood or evict the capped log.
                    const ip = this.ClientIp(req)
                    if (this.WriteIfThrottled(res, ip))
                    {
                        return
                    }
                    // Hit counted synchronously BEFORE the awaited audit write, so a back-to-back or parallel burst
                    // cannot slip past the gate while earlier audit appends are still in flight.
                    this.auditThrottle?.RecordHit(ip)
                    PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.BadOriginMessage })
                    await this.RecordAudit(AuditRegistry.AnonymousActor, method, path, ControlPlaneHost.StatusForbidden)
                    return
                }
                if (!ControlPlaneHost.IsPublicApi(path))
                {
                    who = await this.Principal(req)
                    if (who === null)
                    {
                        req.resume()
                        const mutating = PlaneHttp.IsMutating(req)
                        const ip = this.ClientIp(req)
                        if (mutating && this.WriteIfThrottled(res, ip))
                        {
                            return
                        }
                        if (mutating)
                        {
                            this.auditThrottle?.RecordHit(ip)
                        }
                        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
                        if (mutating)
                        {
                            await this.RecordAudit(AuditRegistry.AnonymousActor, method, path, ControlPlaneHost.StatusUnauthorized)
                        }
                        return
                    }
                    if (!this.authorization.Authorize(who.role, method, path))
                    {
                        req.resume()
                        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.ForbiddenRoleMessage })
                        if (PlaneHttp.IsMutating(req))
                        {
                            await this.RecordAudit(ControlPlaneHost.ActorOf(who), method, path, ControlPlaneHost.StatusForbidden)
                        }
                        return
                    }
                }
            }
            if (who !== null && PlaneHttp.IsMutating(req) && path.startsWith(ControlPlaneHost.ApiPrefix) && !ControlPlaneHost.IsPublicApi(path))
            {
                auditActor = ControlPlaneHost.ActorOf(who)
                auditMethod = method
                // The query is never stored (it could carry anything); only the fixed delete-anyway marker is, and only on a
                // hive delete, so a forced hive delete reads as such in the activity log.
                auditPath = ControlPlaneHost.IsForcedHiveDelete(req, method, path) ? path + ControlPlaneHost.ForceAuditSuffix : path
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
        finally
        {
            // Runs after the response (or the WriteError 500) is written, so res.statusCode is the FINAL
            // outcome (an unrouted /api mutation is a 404 here; a thrown handler is a 500).
            if (auditActor !== null)
            {
                await this.RecordAudit(auditActor, auditMethod, auditPath, res.statusCode, this.auditNotes.get(res))
            }
        }
    }

    /** Writes a 429 + Retry-After and returns true when the pre-auth throttle has locked this ip. */
    private WriteIfThrottled(res: ServerResponse, ip: string): boolean
    {
        const decision = this.auditThrottle?.CheckAllowed(ip)
        if (decision === undefined || decision.allowed)
        {
            return false
        }
        res.setHeader(ControlPlaneHost.RetryAfterHeader, String(Math.ceil(decision.retryAfterMs / ControlPlaneHost.MsPerSecond)))
        PlaneHttp.WriteJson(res, ControlPlaneHost.StatusTooManyRequests, { error: ControlPlaneHost.TooManyRequestsMessage })
        return true
    }

    /** Best-effort audit append: never throws, never alters the response; tracked until done so Close can wait for it. */
    private async RecordAudit(actor: string, method: string, path: string, status: number, note?: string): Promise<void>
    {
        if (this.audit === undefined)
        {
            return
        }
        const append = this.AppendAudit(this.audit, actor, method, path, status, note)
        this.pendingAudits.add(append)
        try
        {
            await append
        }
        finally
        {
            this.pendingAudits.delete(append)
        }
    }

    private async AppendAudit(audit: AuditRegistry, actor: string, method: string, path: string, status: number, note: string | undefined): Promise<void>
    {
        try
        {
            const safePath = path.length > ControlPlaneHost.MaxAuditPathLength ? path.slice(0, ControlPlaneHost.MaxAuditPathLength) : path
            await audit.Append({ actor, method, path: safePath, status, at: new Date().toISOString(), ...(note === undefined ? {} : { note }) })
        }
        catch (err)
        {
            console.error(ControlPlaneHost.LogPrefix, err instanceof Error ? err.name : ControlPlaneHost.AuditFailureFallback)
        }
    }

    private static ActorOf(who: OperatorPrincipal): string
    {
        return who.email ?? who.principalId ?? ''
    }

    private ActivityLimit(req: IncomingMessage): number
    {
        const raw = new URL(req.url ?? PlaneHttp.RootPath, ControlPlaneHost.BaseUrl).searchParams.get(ControlPlaneHost.ActivityLimitParam)
        const n = raw === null ? NaN : Number.parseInt(raw, 10)
        return Number.isFinite(n) ? Math.min(Math.max(n, 1), ControlPlaneHost.ActivityLimitMax) : ControlPlaneHost.ActivityLimitMax
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
        if (path === ControlPlaneHost.ActivityAllPath && method === PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, [...(this.audit?.Recent(this.ActivityLimit(req)) ?? [])])
            return true
        }
        if (path === ControlPlaneHost.DiscoverPath && method === PlaneHttp.MethodPost && this.discovery !== undefined)
        {
            await this.discovery.Handle(req, res, this.ClientIp(req))
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
        if (path === ControlPlaneHost.SessionPasswordPath && method === PlaneHttp.MethodPost)
        {
            await this.HandleChangeOwnPassword(req, res)
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
        const opm = ControlPlaneHost.TenantOwnerPasswordPathPattern.exec(path)
        if (opm !== null)
        {
            return await this.RouteOwnerPasswordReset(res, method, opm)
        }
        const tpm = ControlPlaneHost.TenantPolicyPathPattern.exec(path)
        if (tpm !== null)
        {
            return await this.RouteTenantPolicy(req, res, method, tpm)
        }
        const hpm = ControlPlaneHost.HivePolicyPathPattern.exec(path)
        if (hpm !== null)
        {
            return await this.RouteHivePolicy(req, res, method, hpm)
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
        const hom = ControlPlaneHost.HiveObservationsPathPattern.exec(path)
        if (hom !== null)
        {
            return await this.RouteHiveObservations(req, res, method, hom)
        }
        const hlm = ControlPlaneHost.HiveLedgerPathPattern.exec(path)
        if (hlm !== null)
        {
            return await this.RouteHiveLedger(req, res, method, hlm)
        }
        const hbm = ControlPlaneHost.HiveBootstrapPathPattern.exec(path)
        if (hbm !== null)
        {
            return this.RouteHiveBootstrap(res, method, hbm)
        }
        const him = ControlPlaneHost.HiveAgentInstallPathPattern.exec(path)
        if (him !== null)
        {
            return this.RouteHiveAgentInstall(res, method, him)
        }
        const hcm = ControlPlaneHost.HiveConsolePathPattern.exec(path)
        if (hcm !== null)
        {
            return await this.RouteHiveConsole(req, res, method, hcm)
        }
        const hcim = ControlPlaneHost.HiveConsoleInstallPathPattern.exec(path)
        if (hcim !== null)
        {
            return this.RouteHiveConsoleInstall(res, method, hcim)
        }
        const hcpm = ControlPlaneHost.HiveConsoleOwnerPasswordPathPattern.exec(path)
        if (hcpm !== null)
        {
            return await this.RouteHiveConsoleOwnerPassword(res, method, hcpm)
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
            if (resource === ControlPlaneHost.HivesSegment)
            {
                if (this.RefuseIfHiveBusy(res, id, ControlPlaneHost.DeleteDuringInstallMessage))
                {
                    return true
                }
                this.hiveWrites.add(id)
                let outcome: HiveDeleteOutcome
                try
                {
                    outcome = await this.DeleteHiveEverywhere(id, ControlPlaneHost.ForceRequested(req))
                }
                finally
                {
                    this.hiveWrites.delete(id)
                }
                const note = ControlPlaneHost.HiveDeleteNote(outcome)
                if (note !== undefined)
                {
                    this.auditNotes.set(res, note)
                }
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true, ...outcome })
                return true
            }
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
            const obs = this.observations.LatestRecord(hive.id)
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

    /** Serves GET /api/hives/ID/observations: the hive's bounded health time-series, newest first; false for any other method. */
    private async RouteHiveObservations(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
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
        if (this.directory.GetHive(id) === undefined)
        {
            PlaneHttp.WriteNotFound(res)
            return true
        }
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, [...this.observations.HistoryFor(id, this.ActivityLimit(req))])
        return true
    }

    /** Serves GET /api/hives/ID/ledger: the hive's version-change timeline, newest first; false for any other method. */
    private async RouteHiveLedger(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
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
        if (this.directory.GetHive(id) === undefined)
        {
            PlaneHttp.WriteNotFound(res)
            return true
        }
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, [...this.deployments.LedgerFor(id, this.ActivityLimit(req))])
        return true
    }

    /** The hive id from a matched hive sub-route; writes 400 / 404 and returns undefined when it is bad or unknown. */
    private KnownHiveId(res: ServerResponse, m: RegExpExecArray): string | undefined
    {
        const id = ControlPlaneHost.Decode(m[1] as string)
        if (id === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return undefined
        }
        if (this.directory.GetHive(id) === undefined)
        {
            PlaneHttp.WriteNotFound(res)
            return undefined
        }
        return id
    }

    /** Serves GET /api/hives/ID/bootstrap: the agent's objects for the client's cluster. Secret-free; 409 while the agent channel is off. */
    private RouteHiveBootstrap(res: ServerResponse, method: string, m: RegExpExecArray): boolean
    {
        if (method !== PlaneHttp.MethodGet)
        {
            return false
        }
        const id = this.KnownHiveId(res, m)
        if (id === undefined)
        {
            return true
        }
        if (this.agentChannelUrl === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.AgentChannelOffMessage })
            return true
        }
        const hive = this.directory.GetHive(id)
        const autoInstall = hive !== undefined && this.agentInstaller !== undefined && this.agentInstaller.Supports(hive)
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, HiveBootstrapBundle.For(id, this.agentChannelUrl, autoInstall))
        return true
    }

    /**
     * Serves /api/hives/ID/agent-install: POST starts the automatic agent install (202 + its first status; 409 when it
     * cannot run or one is already running), GET reads the latest install's status (404 when none has run). Neither
     * response ever carries the agent token. False for any other method.
     */
    private RouteHiveAgentInstall(res: ServerResponse, method: string, m: RegExpExecArray): boolean
    {
        if (method !== PlaneHttp.MethodGet && method !== PlaneHttp.MethodPost)
        {
            return false
        }
        const id = this.KnownHiveId(res, m)
        if (id === undefined)
        {
            return true
        }
        const installer = this.agentInstaller
        if (method === PlaneHttp.MethodGet)
        {
            const status = installer?.StatusFor(id)
            if (status === undefined)
            {
                PlaneHttp.WriteNotFound(res)
                return true
            }
            this.WriteInstallStatus(res, PlaneHttp.StatusOk, status)
            return true
        }
        if (installer === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.AutoInstallOffMessage })
            return true
        }
        if (this.hiveWrites.has(id))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.HiveBusyMessage })
            return true
        }
        if (this.consoleInstaller?.IsInstalling(id) === true)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.ConsoleInstallRunningMessage })
            return true
        }
        this.WriteInstallStatus(res, ControlPlaneHost.StatusAccepted, installer.Start(id))
        return true
    }

    /**
     * Serves /api/hives/ID/console-install: POST starts the in-hive console install (202 + its first status, no-store; 409 when it
     * cannot run, one is running, the agent is being installed, or another hive operation is in flight), GET reads the latest install's
     * status (404 when none has run). Neither carries a secret. False for any other method.
     */
    private RouteHiveConsoleInstall(res: ServerResponse, method: string, m: RegExpExecArray): boolean
    {
        if (method !== PlaneHttp.MethodGet && method !== PlaneHttp.MethodPost)
        {
            return false
        }
        const id = this.KnownHiveId(res, m)
        if (id === undefined)
        {
            return true
        }
        const installer = this.consoleInstaller
        if (method === PlaneHttp.MethodGet)
        {
            const status = installer?.StatusFor(id)
            if (status === undefined)
            {
                PlaneHttp.WriteNotFound(res)
                return true
            }
            this.WriteConsoleInstallStatus(res, PlaneHttp.StatusOk, status)
            return true
        }
        if (installer === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.ConsoleInstallOffMessage })
            return true
        }
        if (this.RefuseIfHiveBusy(res, id, ControlPlaneHost.AgentInstallRunningMessage))
        {
            return true
        }
        this.WriteConsoleInstallStatus(res, ControlPlaneHost.StatusAccepted, installer.Start(id))
        return true
    }

    /**
     * Serves POST /api/hives/ID/console/owner-password: sets a fresh Owner password in the hive's in-hive IdP and returns
     * { ownerEmail, ownerPassword } once (no-store). The password is never logged or audited; false for any other method.
     */
    private async RouteHiveConsoleOwnerPassword(res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        if (method !== PlaneHttp.MethodPost)
        {
            return false
        }
        const id = this.KnownHiveId(res, m)
        if (id === undefined)
        {
            return true
        }
        if (this.consoleInstaller === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.ConsoleInstallOffMessage })
            return true
        }
        const reset: InHiveOwnerPassword = await this.consoleInstaller.ResetOwnerPassword(id)
        res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, reset)
        return true
    }

    /**
     * Serves /api/hives/ID/console. PUT stores where the hive serves its tenant's console and returns the updated hive. DELETE removes
     * the console from a cluster the control plane drives (a refusing cluster answers 409 with kubectl's redacted text and keeps the
     * setting), then clears the setting and returns { hive, retained }: retained names what stays in the cluster (the console's and its
     * IdP's data and Secrets, and the environment namespaces it created, which keep running), also in the audit note. Both refuse
     * (409) while any hive operation runs (agent or console install,
     * reissue, delete, console removal). False for any other method.
     */
    private async RouteHiveConsole(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        if (method !== PlaneHttp.MethodPut && method !== PlaneHttp.MethodDelete)
        {
            return false
        }
        const id = this.KnownHiveId(res, m)
        if (id === undefined)
        {
            return true
        }
        if (method === PlaneHttp.MethodDelete)
        {
            await this.RemoveHiveConsole(res, id)
            return true
        }
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return true
        }
        // Checked after the body is read, right before the write: a removal, delete or install that began meanwhile still wins.
        if (this.RefuseIfHiveBusy(res, id, ControlPlaneHost.AgentInstallBeforeSettingsMessage))
        {
            return true
        }
        const hive: HiveDto = await this.directory.SetHiveConsole(id, HiveConsoleSpecs.Parse(body))
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, hive)
        return true
    }

    /**
     * Drops a deleted tenant's in-hive IdP credentials. Best effort: the tenant is already gone, so a sealed-store failure only leaves
     * an unreachable sealed copy behind and must not turn the delete into an error.
     */
    private async ForgetTenantConsoleCredentials(tenantId: string): Promise<void>
    {
        if (this.consoleInstaller === undefined)
        {
            return
        }
        try
        {
            await this.consoleInstaller.ForgetTenant(tenantId)
        }
        catch (err)
        {
            ControlPlaneHost.LogForgetFailure(ControlPlaneHost.TenantDeleteLogPrefix, tenantId, err)
        }
    }

    /** Logs a failed forget of console keys by the error's name only (a raw message may carry store details). */
    private static LogForgetFailure(prefix: string, hiveId: string, err: unknown): void
    {
        console.error(prefix + hiveId + ControlPlaneHost.ForgetFailedLogInfix + (err instanceof Error ? err.name : ControlPlaneHost.UnknownErrorName))
    }

    /** DELETE /api/hives/ID/console under the per-hive operation lock (a delete, reissue or install in flight answers 409). */
    private async RemoveHiveConsole(res: ServerResponse, id: string): Promise<void>
    {
        if (this.RefuseIfHiveBusy(res, id, ControlPlaneHost.AgentInstallBeforeRemovalMessage))
        {
            return
        }
        this.hiveWrites.add(id)
        try
        {
            const hive = this.directory.GetHive(id)
            let outcome: ConsoleRemovalOutcome = { retained: [] }
            if (hive?.console !== undefined && this.consoleInstaller?.CanUninstall(hive) === true)
            {
                try
                {
                    outcome = await this.consoleInstaller.Uninstall(hive)
                }
                catch (err)
                {
                    if (!(err instanceof KubectlError))
                    {
                        throw err
                    }
                    PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.ConsoleRemoveFailedPrefix + err.message })
                    return
                }
            }
            // The sealed IdP credentials stay: the kept IdP and environments still use that CA (forgotten on hive or tenant delete).
            const updated: HiveDto = await this.directory.SetHiveConsole(id, undefined)
            const note = ControlPlaneHost.ConsoleRemovalNote(outcome)
            if (note !== undefined)
            {
                this.auditNotes.set(res, note)
            }
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { hive: updated, ...outcome })
        }
        finally
        {
            this.hiveWrites.delete(id)
        }
    }

    /**
     * Serves POST /api/tenants/ID/owner-password: sets a fresh Owner password in the tenant's IdP and returns
     * { ownerEmail, ownerPassword } once (no-store). The password is never logged or audited; false for any other method.
     */
    private async RouteOwnerPasswordReset(res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
        if (method !== PlaneHttp.MethodPost)
        {
            return false
        }
        const id = ControlPlaneHost.Decode(m[1] as string)
        if (id === undefined)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        const reset: OwnerPasswordReset = await this.provisioning.ResetOwnerPassword(id)
        res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, reset)
        return true
    }

    /**
     * Writes 409 and returns true when a token- or lifecycle-writing operation is already in flight for the hive: a
     * running agent install (with its own message), a running console install, or a reissue / delete / console removal.
     */
    private RefuseIfHiveBusy(res: ServerResponse, id: string, installingMessage: string): boolean
    {
        if (this.agentInstaller?.IsInstalling(id) === true)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: installingMessage })
            return true
        }
        if (this.consoleInstaller?.IsInstalling(id) === true)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.ConsoleInstallRunningMessage })
            return true
        }
        if (this.hiveWrites.has(id))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.HiveBusyMessage })
            return true
        }
        return false
    }

    private WriteInstallStatus(res: ServerResponse, status: number, body: InstallStatus): void
    {
        res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
        PlaneHttp.WriteJson(res, status, body)
    }

    private WriteConsoleInstallStatus(res: ServerResponse, status: number, body: ConsoleInstallStatus): void
    {
        res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
        PlaneHttp.WriteJson(res, status, body)
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
        if (channel !== undefined && !ControlPlaneHost.ChannelValues.includes(channel as string))
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
            if (!Array.isArray(body.channels) || !body.channels.every(c => ControlPlaneHost.ChannelValues.includes(c as string)))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ChannelsInvalidMessage })
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

    /** Serves /api/hives/ID/policy/(channels PUT | min-version PUT,DELETE | hold POST,DELETE); the owning tenant is resolved from the directory. */
    private async RouteHivePolicy(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray): Promise<boolean>
    {
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
        const action = m[2]
        if (action === ControlPlaneHost.ChannelsSegment && method === PlaneHttp.MethodPut)
        {
            const body = await this.ReadJsonObject(req, res)
            if (body === undefined)
            {
                return true
            }
            if (!Array.isArray(body.channels) || !body.channels.every(c => ControlPlaneHost.ChannelValues.includes(c as string)))
            {
                PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ChannelsInvalidMessage })
                return true
            }
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.SetChannelsForHive(hive.tenantId, id, body.channels as Channel[]))
            return true
        }
        if (action === ControlPlaneHost.MinVersionSegment && method === PlaneHttp.MethodPut)
        {
            const v = await this.ReadVersion(req, res)
            if (v === undefined)
            {
                return true
            }
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.SetMinVersionForHive(hive.tenantId, id, v))
            return true
        }
        if (action === ControlPlaneHost.MinVersionSegment && method === PlaneHttp.MethodDelete)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.ClearMinVersionForHive(hive.tenantId, id))
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
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.SetHoldForHive(hive.tenantId, id, body.reason.trim(), actor))
            return true
        }
        if (action === ControlPlaneHost.HoldSegment && method === PlaneHttp.MethodDelete)
        {
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.deployments.ClearHoldForHive(hive.tenantId, id))
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
            // A reissue now would revoke the token a running install just stored, or race a delete.
            if (this.RefuseIfHiveBusy(res, id, ControlPlaneHost.ReissueDuringInstallMessage))
            {
                return true
            }
            this.hiveWrites.add(id)
            let token: string
            try
            {
                token = await this.deployments.RegisterHive(id)
            }
            finally
            {
                this.hiveWrites.delete(id)
            }
            // The one-time reveal: the raw agent token appears in this response body only; the registry stores just its hash.
            const dto: RolloutRegistrationDto = { token }
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

    /** Deletes a client or a tenant. Hives are deleted by DeleteHiveEverywhere, under the per-hive operation lock. */
    private async DeletePlatform(resource: string, id: string): Promise<void>
    {
        switch (resource)
        {
            case ControlPlaneHost.ClientsSegment:
                await this.directory.DeleteClient(id)
                break
            case ControlPlaneHost.TenantsSegment:
                // Fail-closed: the hives guard runs first, then the per-tenant IdP is torn down BEFORE the record is removed,
                // so a teardown failure leaves the tenant record for retry rather than stranding a live IdP.
                this.directory.AssertTenantDeletable(id)
                await this.idp?.TeardownForTenant(id)
                await this.directory.DeleteTenant(id)
                await this.provisioning.ForgetTenant(id)
                await this.ForgetTenantConsoleCredentials(id)
                break
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

    /** The audit note of a hive delete: what it kept (`retained: ...`) and which environment namespaces it could not delete (`failed: ...`). */
    private static HiveDeleteNote(outcome: HiveDeleteOutcome): string | undefined
    {
        const C = ControlPlaneHost
        const parts: string[] = []
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
        this.directory.AssertHiveDeletable(id)
        const hive = this.directory.GetHive(id)
        const uninstalls = hive !== undefined && this.agentUninstaller?.Covers(hive) === true
        const removesConsole = hive?.console !== undefined && this.consoleInstaller?.CanUninstall(hive) === true
        const outcome: HiveDeleteOutcome = { retained: [], failed: [] }
        const notices: string[] = []
        if (removesConsole && !force)
        {
            try
            {
                await this.consoleInstaller!.Uninstall(hive!)
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
            notices.push(ControlPlaneHost.ConsoleLeftNotice)
        }
        if (uninstalls && !force)
        {
            outcome.retained = await this.agentUninstaller!.Uninstall(hive!)
            outcome.failed = await this.agentUninstaller!.DeleteEnvironmentNamespaces(hive!)
            if (outcome.failed.length > 0)
            {
                notices.push(ControlPlaneHost.NamespacesLeftNoticePrefix + outcome.failed.join(ControlPlaneHost.NoteSeparator) + ControlPlaneHost.SentenceEnd)
            }
        }
        else if (uninstalls)
        {
            notices.push(ControlPlaneHost.AgentLeftNotice)
        }
        if (!force)
        {
            try
            {
                await this.deployments.DestroyHiveCluster(id)
            }
            catch (err)
            {
                HiveClusterDestroyError.From(err)
            }
        }
        else if (hive?.cluster.mode === InfraMode.Provision && hive.cluster.backend === HiveBackend.Local)
        {
            notices.push(ControlPlaneHost.KindClusterLeftNotice)
        }
        await this.deployments.DeregisterHive(id)
        await this.directory.DeleteHive(id)
        // The console's fingerprint key and in-hive IdP credentials go with the hive, forced or not. Best effort: the hive is already
        // gone, so a sealed-store failure only leaves unreachable sealed keys behind and must not turn the delete into an error.
        if (hive !== undefined && this.consoleInstaller !== undefined)
        {
            try
            {
                await this.consoleInstaller.Forget(hive)
            }
            catch (err)
            {
                ControlPlaneHost.LogForgetFailure(ControlPlaneHost.ForgetFailedLogPrefix, id, err)
            }
        }
        if (notices.length > 0)
        {
            outcome.notice = notices.join(ControlPlaneHost.NoticeSeparator)
        }
        return outcome
    }

    /** Whether the request is a delete-anyway of a hive (DELETE /api/hives/ID?force=true). */
    private static IsForcedHiveDelete(req: IncomingMessage, method: string, path: string): boolean
    {
        return method === PlaneHttp.MethodDelete && ControlPlaneHost.HiveItemPathPattern.test(path) && ControlPlaneHost.ForceRequested(req)
    }

    /** Whether the request asks to delete anyway (`?force=true`). */
    private static ForceRequested(req: IncomingMessage): boolean
    {
        const value = new URL(req.url ?? PlaneHttp.RootPath, ControlPlaneHost.BaseUrl).searchParams.get(ControlPlaneHost.ForceParam)
        return value === ControlPlaneHost.ForceValue
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
        // `existing: true` references a record that already exists; only its id is read.
        if (!ControlPlaneHost.OptionalBoolean(client.existing) || !ControlPlaneHost.OptionalBoolean(tenant.existing))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.ExistingFlagMessage })
            return
        }
        const existingClient = client.existing === true
        const existingTenant = tenant.existing === true
        if ((!existingClient && typeof client.displayName !== 'string') || (!existingTenant && typeof tenant.displayName !== 'string') || typeof hive.displayName !== 'string')
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.DisplayNameRequiredMessage })
            return
        }
        if (!existingTenant && !ControlPlaneHost.NonEmpty(tenant.ownerEmail))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.OwnerEmailRequiredMessage })
            return
        }
        if (!existingTenant && (tenant.id as string).startsWith(ControlPlaneHost.ReservedIdPrefix))
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
                client: existingClient
                    ? { existing: true, id: client.id as string }
                    : { id: client.id as string, displayName: client.displayName as string, subscriptionRef: client.subscriptionRef as string | undefined },
                tenant: existingTenant
                    ? { existing: true, id: tenant.id as string }
                    : { id: tenant.id as string, displayName: tenant.displayName as string, ownerEmail: tenant.ownerEmail as string },
                hive: { id: hive.id as string, displayName: hive.displayName, cluster, registry, trustRootRef: hive.trustRootRef as string | undefined }
            })
            // The one-time secrets (the Owner password only for a new tenant) are revealed exactly once here; never logged or stored.
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
            // The reset ends every session of the target (the caller's own too when they reset themselves); their live
            // event sockets close with them.
            const password = await this.operator.ResetOperatorPassword(email)
            await this.CloseRevokedSockets()
            res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { password })
            return
        }
        if (path === ControlPlaneHost.OperatorRevokeSessionsPath)
        {
            await this.operator.RevokeOperatorSessions(email)
            await this.CloseRevokedSockets()
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
            await this.CloseRevokedSockets()
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, {})
            return
        }
        PlaneHttp.WriteNotFound(res)
    }

    /**
     * POST /api/session/password: the signed-in operator changes their own password. The identity is the session's,
     * never the body's. Throttled per (email, client ip) through the login throttle (a wrong current password is a
     * password guess); the attempt is counted at the gate, before the await, as login does. On success every session
     * of the operator ends, the caller's own included, and the caller is handed a fresh session cookie, so the request
     * making the change stays signed in while every other session (and its live sockets) is cut. A wrong current
     * password is 403, not 401: 401 means "your session is gone" to the portal. Every reply is no-store; no password
     * is ever echoed, logged or audited (the audit records the path and status only).
     */
    private async HandleChangeOwnPassword(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        res.setHeader(ControlPlaneHost.CacheControlHeader, ControlPlaneHost.NoStore)
        const token = SessionCookie.Read(req.headers[ControlPlaneHost.CookieHeader])
        const who = await this.Principal(req)
        if (who === null || token === undefined)
        {
            req.resume()
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
            return
        }
        const body = await this.ReadJsonObject(req, res)
        if (body === undefined)
        {
            return
        }
        const current = body[ControlPlaneHost.CurrentPasswordField]
        const next = body[ControlPlaneHost.NewPasswordField]
        const confirm = body[ControlPlaneHost.ConfirmPasswordField]
        if (typeof current !== 'string' || current.length === 0 || typeof next !== 'string')
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.PasswordFieldsMessage })
            return
        }
        if (next.length < ControlPlaneHost.MinOperatorPasswordLength)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.WeakPasswordMessage })
            return
        }
        if (confirm !== undefined && confirm !== next)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.PasswordMismatchMessage })
            return
        }
        if (next === current)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.SamePasswordMessage })
            return
        }
        // One change per operator at a time: a second one's revoke would end the first's fresh session.
        if (this.passwordChanges.has(who.principalId))
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusConflict, { error: ControlPlaneHost.PasswordChangeBusyMessage })
            return
        }
        this.passwordChanges.add(who.principalId)
        try
        {
            await this.ChangeOwnPasswordFor(req, res, who, token, current, next)
        }
        finally
        {
            this.passwordChanges.delete(who.principalId)
        }
    }

    /** The throttled verify + rotate of HandleChangeOwnPassword, run while the operator's in-flight guard is held. */
    private async ChangeOwnPasswordFor(req: IncomingMessage, res: ServerResponse, who: OperatorPrincipal, token: string, current: string, next: string): Promise<void>
    {
        const clientIp = this.ClientIp(req)
        const gate = this.loginThrottle.CheckAllowed(who.email, clientIp)
        if (!gate.allowed)
        {
            res.setHeader(ControlPlaneHost.RetryAfterHeader, String(Math.ceil(gate.retryAfterMs / ControlPlaneHost.MsPerSecond)))
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusTooManyRequests, { error: ControlPlaneHost.TooManyPasswordAttemptsMessage })
            return
        }
        this.loginThrottle.RecordFailure(who.email, clientIp)
        // The caller's token is shielded from the socket sweep from here until its sockets have moved to the fresh token:
        // a sweep running between the revoke and the Rekey would otherwise find it ended and close the caller's socket.
        this.protectedTokens.add(token)
        let change: OwnPasswordChange | null
        try
        {
            change = await this.operator.ChangeOwnPassword(who.principalId, current, next)
            if (change?.session !== null && change?.session !== undefined)
            {
                this.registry.Rekey(token, change.session.token)
            }
        }
        finally
        {
            this.protectedTokens.delete(token)
        }
        if (change === null)
        {
            PlaneHttp.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.WrongCurrentPasswordMessage })
            return
        }
        this.loginThrottle.Clear(who.email, clientIp)
        // Every other socket of the operator held an ended token and closes now.
        await this.CloseRevokedSockets()
        if (change.session !== null)
        {
            res.setHeader(ControlPlaneHost.SetCookieHeader, SessionCookie.Build(change.session.token, change.session.expiresAt, this.secureCookie))
        }
        const warning = change.session === null
            ? ControlPlaneHost.SignInAgainWarning
            : (change.otherSessionsEnded ? undefined : ControlPlaneHost.OthersNotEndedWarning)
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { ok: true, otherSessionsEnded: change.otherSessionsEnded, ...(warning === undefined ? {} : { warning }) })
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
        if (err instanceof AgentUninstallError)
        {
            // The code lets the portal offer delete anyway for exactly this failure.
            PlaneHttp.WriteJson(res, status, { error: err.message, code: AgentUninstallError.Code })
            return
        }
        if (err instanceof HiveClusterDestroyError)
        {
            PlaneHttp.WriteJson(res, status, { error: err.message, code: HiveClusterDestroyError.Code })
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
        return path === ControlPlaneHost.PingPath || path === ControlPlaneHost.LoginPath || path === ControlPlaneHost.SessionPath || path === ControlPlaneHost.DiscoverPath
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
