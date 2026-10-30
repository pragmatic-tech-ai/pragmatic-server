import type { ActivityLog } from './activity-log.js'
import type { NavSection } from './nav-model.js'

// Wire shapes of the 7a tenant surface (/tenant-auth/* + /tenant-api/*), kept verbatim.

export type SessionDto = { tenantId: string; principalId: string; email?: string }

// Mirrored by hand from the server's tenant-profile-dto.ts; the portal never imports pragmatic-protocol.
export type AdminCapabilitiesDto = { envs: boolean; adopt: boolean; access: boolean; settings: boolean }

export type TenantProfileDto = {
    principalId: string
    email?: string
    roleLabel: string
    environment: { id: string; displayName: string; organisation?: string }
    hive?: { id: string; displayName: string }
    capabilities: AdminCapabilitiesDto
    ownerContact?: string
    // The tenant's IdP by reference only: base URL + presence flags, never ref strings or secrets.
    idp?: { baseUrl?: string; signingCaConfigured: boolean; adminTokenConfigured: boolean }
}

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

// Navigation seam the views call; TenantApp implements it.
export interface ITenantNavigator
{
    ShowLogin(): void
    ShowHiveDetail(hive: HiveDto): void
    ShowEnvironmentDetail(env: EnvironmentDto): void
    ShowUsersAccess(): void
    ShowServiceTokens(): void
    ShowSection(section: NavSection): void
    get Profile(): TenantProfileDto | undefined
    get Capabilities(): AdminCapabilitiesDto | undefined
    get OwnerContact(): string | undefined
    get Activity(): ActivityLog
    OpenActivityDrawer(): void
}

export interface ITenantView
{
    AttachNavigator(nav: ITenantNavigator): void
    Refresh(): Promise<void> | void
    // Optional teardown hook invoked when the detail pane swaps the view out.
    Dispose?(): void
}

// Injectable socket seam: the default implementation wraps the browser WebSocket.
export interface IWebSocketLike
{
    OnMessage(cb: (data: string) => void): void
    OnClose(cb: () => void): void
    Close(): void
}

export interface IWebSocketFactory
{
    Open(url: string): IWebSocketLike
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

export interface BusinessUnitDto
{
    id: string
    name: string
    parent?: string
}

export interface TeamDto
{
    id: string
    name: string
    owningBusinessUnit?: string
}

export interface MembershipClaimRuleDto
{
    claim: string
    value: string
    homeBusinessUnit?: string
    teams?: string[]
}

export interface MembershipOverrideDto
{
    principalId: string
    homeBusinessUnit?: string
    teams?: string[]
}

export interface MembershipDto
{
    claimsMapping: MembershipClaimRuleDto[]
    overrides: MembershipOverrideDto[]
}

export interface OwnershipSourceDto
{
    kind: string
    value: string
}

export interface OwnershipRuleDto
{
    concept: string
    owningBusinessUnit: OwnershipSourceDto
    owner?: OwnershipSourceDto
}

export interface PrivilegeDto
{
    action: string
    concept: string
    level: string
}

export interface RoleConfigDto
{
    id: string
    name: string
    privileges: PrivilegeDto[]
}

export interface RoleClaimRuleDto
{
    claim: string
    value: string
    roles: string[]
}

export interface RoleOverrideDto
{
    principalId: string
    roles: string[]
}

export interface TeamRoleGrantDto
{
    teamId: string
    roles: string[]
}

export interface RoleAssignmentDto
{
    claimsMapping: RoleClaimRuleDto[]
    overrides: RoleOverrideDto[]
    teamRoles: TeamRoleGrantDto[]
}

export interface SecuredFieldDto
{
    concept: string
    field: string
}

export interface FieldGrantDto
{
    concept: string
    field: string
    read?: boolean
    update?: boolean
    create?: boolean
}

export interface FieldProfileDto
{
    id: string
    name: string
    grants: FieldGrantDto[]
}

export interface FieldProfileClaimRuleDto
{
    claim: string
    value: string
    profiles: string[]
}

export interface FieldProfileOverrideDto
{
    principalId: string
    profiles: string[]
}

export interface FieldProfileTeamGrantDto
{
    teamId: string
    profiles: string[]
}

export interface FieldProfileAssignmentDto
{
    claimsMapping: FieldProfileClaimRuleDto[]
    overrides: FieldProfileOverrideDto[]
    teamProfiles: FieldProfileTeamGrantDto[]
}

export interface FieldSecurityDto
{
    securedFields: SecuredFieldDto[]
    profiles: FieldProfileDto[]
    profileAssignment: FieldProfileAssignmentDto
}

export interface SecurityModelDto
{
    businessUnits: BusinessUnitDto[]
    teams: TeamDto[]
    membership: MembershipDto
    ownershipRules: OwnershipRuleDto[]
    roles?: RoleConfigDto[]
    roleAssignment?: RoleAssignmentDto
    fieldSecurity?: FieldSecurityDto
}

export interface ISecurityModelSource
{
    GetSecurityModel(env: string): Promise<SecurityModelDto | null>
    SetSecurityModel(env: string, model: SecurityModelDto): Promise<void>
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
