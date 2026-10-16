export type EnvironmentDto =
{
    name: string
    template: string
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
    resourcePath: string
}

export type GrantMutationDto =
{
    subject: string
    role: string
    resourceKind?: string
    resourcePath?: string
}

// securityModel is opaque JSON to the portal.
export type IdentityConfigDto =
{
    packId: string
    delegationDepth: number
    providerSettings: Record<string, unknown>
    groupRoleMap: Record<string, unknown>
    claimsMapping: Record<string, unknown>
    securityModel?: unknown
}

export type AdminSnapshotDto =
{
    accounts: AccountDto[]
    grants: GrantDto[]
    config: IdentityConfigDto
}

// Navigation contract the App implements and the views call into.
export interface IPortalNavigator
{
    ShowLogin(): void
    ShowList(): void
    ShowCreate(): void
    ShowDetail(name: string): void
    ShowManage(name: string): void
}

// A screen that can re-fetch and re-render itself (on environments-changed).
export interface IPortalView
{
    AttachNavigator(nav: IPortalNavigator): void
    Refresh(): Promise<void>
}
