// Environment kinds; values match the server wire strings in EnvironmentDto.type.
export enum EnvironmentType
{
    Development = 'development',
    Runtime = 'runtime'
}

export type EnvironmentDto =
{
    name: string
    template: string
    type: string
    environmentId: string
    hostPort: number
    status: string
    createdAt: string
    httpUrl: string
    wsUrl: string
}

export type ClientDto =
{
    id: string
    displayName: string
    subscriptionRef?: string
    createdAt: string
}

export type TenantDto =
{
    id: string
    clientId: string
    displayName: string
    createdAt?: string
}

export type HiveClusterBackend = 'aks' | 'eks' | 'gke' | 'private' | 'local'
export type HiveProvisionMode = 'provision' | 'attach'

export type HiveDto =
{
    id: string
    tenantId: string
    displayName: string
    cluster: { backend: HiveClusterBackend; mode: HiveProvisionMode; configRef?: string }
    registry: { mode: HiveProvisionMode; endpoint?: string; credentialRef?: string }
    trustRootRef?: string
}

export type GraphDto =
{
    name: string
    description: string
    packageCount: number
    createdAt: string
}

export type PromotionResultDto =
{
    graphName: string
    packageCount: number
    targetEnv: string
}

export type GraphLoadedDto =
{
    name: string
    packages: { id: string; version: string }[]
    promotedAt: string
}

export type OperatorDto =
{
    email: string
    principalId: string
    role: string
}

// Navigation contract the App implements and the views call into.
export interface IPortalNavigator
{
    ShowLogin(): void
    ShowList(): void
    ShowDetail(name: string): void
    ShowGraphs(name: string): void
    ShowCreateGraph(name: string): void
    ShowPromoteGraph(devEnvName: string): void
    ShowClients(): void
    ShowCreateClient(): void
    ShowTenants(clientId: string): void
    ShowCreateTenant(clientId: string): void
    ShowHives(clientId: string, tenantId: string): void
    ShowCreateHive(clientId: string, tenantId: string): void
}

// A screen that can re-fetch and re-render itself (on environments-changed).
export interface IPortalView
{
    AttachNavigator(nav: IPortalNavigator): void
    Refresh(): Promise<void>
}

export type GatingDto = { tenantId: string; version: string; gatedAt: string }
export type SelectionDto = { hiveId: string; targetVersion: string; selectedAt: string }
export type OperatorSummaryDto = { email: string; role: string; disabled?: boolean }
export type ManifestDto = { id: string; image: string; notes?: string; publishedAt: string; withdrawn?: boolean; channel?: 'stable' | 'early'; digest?: string; signed?: boolean; withdrawal?: { reason: string; actor: string; at: string } }
export type EnvRolloutDto = { environmentName: string; runningImage?: string; obsolete: boolean; ready: boolean }
export type HiveRolloutDto = { hiveId: string; targetVersion?: string; environments: EnvRolloutDto[] }

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

export type ProvisionInputDto =
{
    client: { id: string; displayName: string; subscriptionRef?: string }
    tenant: { id: string; displayName: string; ownerEmail: string }
    hive: { id: string; displayName: string; cluster: HiveDto['cluster']; registry: HiveDto['registry']; trustRootRef?: string }
}

export type ProvisionSecretsDto = { ownerEmail: string; ownerPassword: string; agentToken: string }

export type ProvisionResultDto = { client: ClientDto; tenant: TenantDto; hive: HiveDto; secrets: ProvisionSecretsDto }

export type PolicyDto = { tenantId: string; channels?: ('stable' | 'early')[]; minVersion?: string; hold?: { reason: string; actor: string; at: string } }

export type ActivityDto = { id: string; actor: string; method: string; path: string; status: number; at: string }
export type ObservationDto = { id: string; hiveId: string; environments: { environmentName: string; ready: boolean; runningImage?: string; detail: string }[]; reportedAt: string }
export type LedgerDto = { id: string; tenantId?: string; hiveId?: string; version: string; action: string; at: string }
