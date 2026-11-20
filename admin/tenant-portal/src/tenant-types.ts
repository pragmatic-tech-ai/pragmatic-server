import type { IPageLocation } from '@pragmatic-tech-ai/pragmatic-app-shell'

// Wire shapes of the 7a tenant surface (/tenant-auth/* + /tenant-api/*), kept verbatim. The session itself is the
// app-host shape (`{ subject, claims }`), read by the shell's AppSession.

// Mirrored by hand from the server's tenant-profile-dto.ts; the portal never imports pragmatic-protocol.
export type AdminCapabilitiesDto = { envs: boolean; adopt: boolean; access: boolean; settings: boolean }

export type TenantProfileDto = {
    principalId: string
    email?: string
    roleLabel: string
    tenant: { id: string; displayName: string; organisation?: string }
    hive?: { id: string; displayName: string }
    capabilities: AdminCapabilitiesDto
    ownerContact?: string
    // The tenant's IdP by reference only: base URL + presence flags, never ref strings or secrets.
    idp?: { baseUrl?: string; signingCaConfigured: boolean; adminTokenConfigured: boolean }
}

// Where a claimed email domain stands with the platform; mirrors the server's DomainApprovalState by value.
export enum DomainApprovalState
{
    Approved = 'approved',
    Verified = 'verified',
    VerifiedContested = 'verified-contested',
    Revoked = 'revoked',
    Pending = 'pending',
}

// One domain's verification as the server answers it: the TXT record to publish, whether it was last seen, and the domain's state.
export type DomainVerificationDto = { domain: string; token: string; verified: boolean; state: DomainApprovalState; lastCheckedAt?: string; recordName: string; recordValue: string }

// The tenant's email domains as its store reports them; `editable` is whether the store may change them (the Owner check is the server's); `inHive` is whether the tenant's console runs in its own hive. A domain takes effect once the platform operator approves it, or once its DNS TXT record is verified and no other tenant claims it: `pending` lists those not in effect yet where the server knows (the control plane, and an in-hive console after the platform's last answer); `verifications` carries each claimed domain's TXT record and state (a missing field reads as none).
export type EmailDomainsDto = { domains: string[]; editable: boolean; inHive: boolean; pending: string[]; verifications?: DomainVerificationDto[] }

export type HiveDto = {
    id: string
    tenantId: string
    displayName: string
    cluster: { backend: string; mode: string }
    registry: { mode: string; endpoint?: string }
    createdAt: string
}

// Mirrors of the server's environment-record enums (the portal never imports the server).
export enum Template
{
    DevBlank = 'dev-blank',
    DemoContoso = 'demo-contoso',
    RuntimePostgres = 'runtime-postgres',
}

export enum EnvType
{
    Development = 'development',
    Runtime = 'runtime',
}

export enum EnvStatus
{
    Running = 'running',
    Stopped = 'stopped',
    Failed = 'failed',
    Unknown = 'unknown',
}

export type EnvironmentDto = {
    name: string
    template: Template
    type: EnvType
    environmentId: string
    hiveId?: string
    tenantId?: string
    hostPort: number
    status: EnvStatus
    createdAt: string
    httpUrl: string
    wsUrl: string
    uiBundle?: { appName: string; appVersion: string }
    idpBaseDomain?: string
}

export type CreateEnvironmentParams = { name: string; template: Template; type: EnvType }

// A Development environment's graph, as GET .../graphs lists it.
export type GraphDto = { name: string; description: string; createdAt: string; packageCount: number }
export type CreateGraphParams = { name: string; description: string }

export interface IEnvironmentsSource
{
    ListEnvironments(): Promise<EnvironmentDto[]>
    GetHealth(hiveId: string): Promise<HiveHealthDto[]>
    StartEnvironment(name: string): Promise<EnvironmentDto>
    StopEnvironment(name: string): Promise<EnvironmentDto>
    RestartEnvironment(name: string): Promise<EnvironmentDto>
    CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto>
}

export type ManifestDto = { id: string; image: string; notes?: string; publishedAt: string; withdrawn?: boolean }

export type RolloutEnvDto = { environmentName: string; runningImage: string | undefined; obsolete: boolean; ready: boolean }

export type HiveRolloutDto = { targetVersion: string | undefined; environments: RolloutEnvDto[] }

// One adoption-ledger entry as the tenant surface returns it (newest first); action is a plain string on the wire.
export type AdoptionLedgerDto = { version: string; action: string; at: string; hiveId?: string }

// The slice of TenantApiClient the Releases page and Adopt wizard need.
export interface IReleasesSource
{
    ListManifests(): Promise<ManifestDto[]>
    GetRollout(hiveId: string): Promise<HiveRolloutDto>
    ListEnvironments(): Promise<EnvironmentDto[]>
    SelectTarget(hiveId: string, version: string): Promise<void>
    ListLedger(hiveId: string): Promise<readonly AdoptionLedgerDto[]>
}

// The slice of TenantApiClient the Overview home needs.
export interface IOverviewSource
{
    ListEnvironments(): Promise<EnvironmentDto[]>
    GetHealth(hiveId: string): Promise<HiveHealthDto[]>
    ListManifests(): Promise<ManifestDto[]>
    GetRollout(hiveId: string): Promise<HiveRolloutDto>
    CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto>
}

export type HiveHealthDto = { environmentName: string; ready: boolean; runningImage: string | undefined; detail: string }

export enum TenantEventType
{
    EnvironmentCreated = 'environment-created',
    EnvironmentChanged = 'environment-changed',
    EnvironmentDeleted = 'environment-deleted',
    HealthChanged = 'health-changed',
}

export type TenantEvent = { type: TenantEventType; environmentName: string }

export enum VersionBadge
{
    Current,
    Previous,
    Available,
    Withdrawn,
}

// Injectable socket seam: the default implementation wraps the browser WebSocket.
export interface IWebSocketLike
{
    OnMessage(cb: (data: string) => void): void
    OnClose(cb: () => void): void
    Close(): void
}

// Opens the console's sockets: each carries its single-use ticket (POST /tenant-api/ws-ticket) as its lone
// subprotocol; there is no cookie auth on the upgrade. Location is the page's own, so a socket stays on its origin.
export interface IWebSocketFactory
{
    readonly Location: IPageLocation
    Open(url: string, ticket: string): IWebSocketLike
}

// Admin wire shapes mirrored from the server; the portal never imports pragmatic-protocol.
export type AccountDto = { principalId: string; email: string; disabled: boolean }
export type GrantDto = { subject: string; role: string; resourceKind: string; resourcePath: string[] }
export type GrantMutationDto = { subject: string; role: string; resourceKind?: string; resourcePath?: string[] }
export type CreateAccountParams = { email: string; principalId: string; password: string }
export type AdminSnapshotDto = { accounts: AccountDto[]; grants: GrantDto[] }

// Role identifiers accepted by the server's grant API (AdminEnums.Roles).
export enum TenantRole
{
    Owner = 'Owner',
    Admin = 'Admin',
    Editor = 'Editor',
    Viewer = 'Viewer',
    Maker = 'Maker',
}

export interface IUsersAccessSource
{
    ListEnvironments(): Promise<EnvironmentDto[]>
    GetAdminSnapshot(env: string): Promise<AdminSnapshotDto>
    CreateAccount(env: string, params: CreateAccountParams): Promise<void>
    DisableAccount(env: string, principalId: string): Promise<void>
    GrantRole(env: string, grant: GrantMutationDto): Promise<void>
    RevokeRole(env: string, grant: GrantMutationDto): Promise<void>
}

export type ServiceTokenSummaryDto = { tokenRef: string; principalId: string; scopes: string[]; expiresAt: string | null; revoked: boolean }
export type IssueTokenParams = { principalId: string; scopes: string[]; expiresInSeconds: number | null }
export type TokenIssuedDto = { tokenRef: string; token: string; principalId: string; scopes: string[]; expiresAt: string | null }
export type RevokeTokenParams = { tokenRef: string }

export interface ITokensSource
{
    ListEnvironments(): Promise<EnvironmentDto[]>
    ListTokens(env: string): Promise<ServiceTokenSummaryDto[]>
    IssueToken(env: string, params: IssueTokenParams): Promise<TokenIssuedDto>
    RevokeToken(env: string, tokenRef: string): Promise<void>
}

// The C5 environment security setting and its catalog, mirrored by hand from the protocol's wire-dtos.ts.
export interface BusinessUnitDto
{
    id: string
    name: string
    parent?: string
}

export interface UserPlacementDto
{
    principalId: string
    businessUnitId: string
}

export interface TeamDto
{
    id: string
    name: string
    businessUnitId: string
    idpGroups: string[]
    manualMembers: string[]
}

export interface RoleAssignmentDto
{
    role: string
    principalIds: string[]
    teamIds: string[]
}

export interface ProfileAssignmentDto
{
    profile: string
    principalIds: string[]
    teamIds: string[]
}

export interface RoleOverrideDto
{
    role: string
    concept: string
    action: string
    level: string
}

export interface ProfileOverrideDto
{
    profile: string
    concept: string
    field: string
    read: boolean
    update: boolean
    create: boolean
}

export interface SecurityModelDto
{
    businessUnits: BusinessUnitDto[]
    users: UserPlacementDto[]
    teams: TeamDto[]
    roleAssignments: RoleAssignmentDto[]
    profileAssignments: ProfileAssignmentDto[]
    roleOverrides: RoleOverrideDto[]
    profileOverrides: ProfileOverrideDto[]
}

export enum SecurityRoleKind
{
    Base = 'base',
    Package = 'package',
}

export interface PrivilegeDto
{
    action: string
    concept: string
    level: string
}

export interface SecurityRoleDto
{
    name: string
    kind: SecurityRoleKind
    package?: string
    defaults: PrivilegeDto[]
}

export interface SecurityConceptDto
{
    name: string
    package: string
    owned: boolean
}

export interface SecuredFieldDto
{
    concept: string
    field: string
}

export interface FieldAccessDto
{
    concept: string
    field: string
    read: boolean
    update: boolean
    create: boolean
}

export interface SecurityProfileDto
{
    name: string
    package: string
    defaults: FieldAccessDto[]
}

export interface SecurityCatalogDto
{
    roles: SecurityRoleDto[]
    concepts: SecurityConceptDto[]
    securedFields: SecuredFieldDto[]
    profiles: SecurityProfileDto[]
}

export enum TeamMemberOrigin
{
    Synced = 'synced',
    Manual = 'manual',
}

export interface TeamMemberDto
{
    principalId: string
    origin: TeamMemberOrigin
}

export interface ListTeamMembersParams
{
    teamId: string
}

export interface RoleDefaultChangeDto
{
    role: string
    concept: string
    action: string
    before: string
    after: string
}

export interface ProfileDefaultChangeDto
{
    profile: string
    concept: string
    field: string
    before: FieldAccessDto | null
    after: FieldAccessDto | null
}

export interface SecurityChangesDto
{
    at: string // ISO
    delivery: string
    version: string
    roleDefaults: RoleDefaultChangeDto[]
    profileDefaults: ProfileDefaultChangeDto[]
    securedFieldsAdded: SecuredFieldDto[]
    securedFieldsRemoved: SecuredFieldDto[]
    roleOverridesDropped: RoleOverrideDto[]
    profileOverridesDropped: ProfileOverrideDto[]
    rolesRemoved: RoleAssignmentDto[]
    profilesRemoved: ProfileAssignmentDto[]
}

export interface ISecurityModelSource
{
    GetSecurityModel(env: string): Promise<SecurityModelDto | null>
    SetSecurityModel(env: string, model: SecurityModelDto): Promise<void>
    GetSecurityCatalog(env: string): Promise<SecurityCatalogDto>
    ListTeamMembers(env: string, teamId: string): Promise<TeamMemberDto[]>
    ListSecurityChanges(env: string): Promise<SecurityChangesDto[]>
}

// The slice of TenantApiClient the Connection status page needs.
export interface IConnectionSource
{
    ListHives(): Promise<HiveDto[]>
    GetRollout(hiveId: string): Promise<HiveRolloutDto>
}

export interface ConnectionEnvironment
{
    name: string
    runningImage: string | undefined
    ready: boolean
}

export interface ConnectionStatus
{
    reachable: boolean
    detail: string
    targetVersion: string | undefined
    environments: readonly ConnectionEnvironment[]
}

// The configuration repository (/tenant-api/configuration/), mirrored by hand from the server. A version number is
// 1-based; 0 names the empty document (a diff's "from" before the first version). Secret settings hold secret
// references (`secret:<store>/<name>`), never values.
export type ConfigurationTargetDto = { environment: string; hive: string; namespace: string; deployment: string; applied: number | null }

export type ConfigurationComponentDto = {
    component: string
    componentVersion: string
    descriptorDigest: string
    head: number | null
    targets: ConfigurationTargetDto[]
}

export type ConfigurationSettingDto = { name: string; type: string; description: string; required: boolean; secret: boolean; default?: unknown }

export type ConfigurationOptionDto = { name: string; description: string; settings: ConfigurationSettingDto[] }

export type ConfigurationVersionSummaryDto = {
    version: number
    componentVersion: string
    descriptorDigest: string
    author: string
    createdAt: string
    comment: string
}

// How an apply ended; values match the server wire strings.
export enum ConfigurationApplyOutcome
{
    Applied = 'applied',
    Failed = 'failed',
}

export type ConfigurationApplyDto = {
    id: string
    version: number
    environment: string
    outcome: ConfigurationApplyOutcome
    requestedBy: string
    requestedAt: string
    completedAt: string | null
    detail: string | null
}

export type ConfigurationComponentDetailDto = {
    component: string
    componentVersion: string
    descriptorDigest: string
    options: ConfigurationOptionDto[]
    versions: ConfigurationVersionSummaryDto[]
    applies: ConfigurationApplyDto[]
}

export type ConfigurationVersionDto = ConfigurationVersionSummaryDto & { document: unknown }

// What a diff found at one path; values match the server wire strings.
export enum ConfigurationChangeKind
{
    Added = 'added',
    Removed = 'removed',
    Changed = 'changed',
}

export type ConfigurationChangeDto = { path: string; kind: ConfigurationChangeKind; before?: unknown; after?: unknown }

export type ConfigurationDiffDto = { from: number; to: number; changes: ConfigurationChangeDto[] }

// One reason a saved document did not validate (a 422's `errors`).
export type ConfigurationValidationErrorDto = { path: string; message: string }
