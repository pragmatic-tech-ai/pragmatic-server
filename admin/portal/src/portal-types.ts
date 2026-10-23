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
}

export type TenantDto =
{
    id: string
    clientId: string
    displayName: string
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

export type MakerTokenDto =
{
    token: string
    principalId: string
    expiresAt: string | null
}

export type TemplateDto =
{
    id: string
    title: string
}

export type OperatorDto =
{
    email: string
}

export type AccountDto =
{
    principalId: string
    email: string
    disabled: boolean
}

export type GrantDto =
{
    subject: string
    role: string
    resourceKind: string
    resourcePath: string[]
}

export type GrantMutationDto =
{
    subject: string
    role: string
    resourceKind?: string
    resourcePath?: string[]
}

// securityModel is opaque JSON to the portal.
export type IdentityConfigDto =
{
    packId: string
    delegationDepth: string
    providerSettings: Record<string, string>
    groupRoleMap: Record<string, string>
    claimsMapping: Record<string, string>
    securityModel?: unknown
}

export type AdminSnapshotDto =
{
    accounts: AccountDto[]
    grants: GrantDto[]
    config: IdentityConfigDto
}

// Structural mirror of the wire SecurityModelDto (the portal does not import the protocol package).
export type PrivilegeDto =
{
    action: string
    concept: string
    level: string
}

export type RoleConfigDto =
{
    id: string
    name: string
    privileges: PrivilegeDto[]
}

export type RoleOverrideDto =
{
    principalId: string
    roles: string[]
}

export type RoleAssignmentDto =
{
    claimsMapping: unknown[]
    overrides: RoleOverrideDto[]
    teamRoles: unknown[]
}

// Fields the role-config surface does not edit are carried through untouched.
export type SecurityModelDto =
{
    businessUnits: unknown[]
    teams: unknown[]
    membership: unknown
    ownershipRules: unknown[]
    roles?: RoleConfigDto[]
    roleAssignment?: RoleAssignmentDto
    fieldSecurity?: unknown
}

// Navigation contract the App implements and the views call into.
export interface IPortalNavigator
{
    ShowLogin(): void
    ShowList(): void
    ShowCreate(): void
    ShowDetail(name: string): void
    ShowManage(name: string): void
    ShowRoles(name: string): void
    ShowGraphs(name: string): void
    ShowCreateGraph(name: string): void
    ShowMakerToken(envName: string): void
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
