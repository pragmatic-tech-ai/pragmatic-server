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

export type ManifestDto = { id: string; image: string; notes?: string; publishedAt: string }

export type RolloutEnvDto = { environmentName: string; runningImage: string | undefined; obsolete: boolean; ready: boolean }

export type HiveRolloutDto = { targetVersion: string | undefined; environments: RolloutEnvDto[] }

export type HiveHealthDto = { environmentName: string; ready: boolean; runningImage: string | undefined; detail: string }

export enum TenantEventType
{
    EnvironmentChanged = 'environment-changed',
    HealthChanged = 'health-changed',
}

export type TenantEvent = { type: TenantEventType; environmentName: string }

export enum VersionBadge
{
    Current,
    Previous,
    Available,
}

// Navigation seam the views call; TenantApp implements it.
export interface ITenantNavigator
{
    ShowLogin(): void
    ShowTree(): void
    ShowHiveDetail(hive: HiveDto): void
    ShowEnvironmentDetail(env: EnvironmentDto): void
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
