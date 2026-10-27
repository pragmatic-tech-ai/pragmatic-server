// Wire shapes of the 7a tenant surface (/tenant-auth/* + /tenant-api/*), kept verbatim.

export type SessionDto = { tenantId: string; principalId: string; email?: string }

export type HiveDto = {
    id: string
    tenantId: string
    displayName: string
    cluster: { backend: string; mode: string }
    registry: { mode: string; endpoint?: string }
    createdAt: string
}

export type EnvironmentDto = {
    name: string
    template: string
    type: string
    environmentId: string
    hiveId?: string
    tenantId?: string
    hostPort: number
    status: string
    createdAt: string
    httpUrl: string
    wsUrl: string
}

export type ManifestDto = { id: string; image: string; notes?: string; publishedAt: string; withdrawn?: boolean }

export type RolloutEnvDto = { environmentName: string; runningImage: string | undefined; obsolete: boolean; ready: boolean }

export type HiveRolloutDto = { targetVersion: string | undefined; environments: RolloutEnvDto[] }

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
    ShowTree(): void
    ShowHiveDetail(hive: HiveDto): void
    ShowEnvironmentDetail(env: EnvironmentDto): void
    ShowUsersAccess(): void
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
