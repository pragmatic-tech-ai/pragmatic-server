export type EnvironmentDto =
{
    name: string
    template: string
    type: string
    tenantId: string
    hostPort: number
    status: string
    createdAt: string
    httpUrl: string
    wsUrl: string
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
}

// A screen that can re-fetch and re-render itself (on environments-changed).
export interface IPortalView
{
    AttachNavigator(nav: IPortalNavigator): void
    Refresh(): Promise<void>
}
