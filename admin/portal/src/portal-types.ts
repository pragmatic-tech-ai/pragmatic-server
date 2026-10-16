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

// Navigation contract the App implements and the views call into.
export interface IPortalNavigator
{
    ShowLogin(): void
    ShowList(): void
    ShowCreate(): void
    ShowDetail(name: string): void
}

// A screen that can re-fetch and re-render itself (on environments-changed).
export interface IPortalView
{
    AttachNavigator(nav: IPortalNavigator): void
    Refresh(): Promise<void>
}
