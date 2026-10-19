import type { AdminSnapshotDto, EnvironmentDto, GrantMutationDto, IdentityConfigDto, OperatorDto, SecurityModelDto, TemplateDto } from './portal-types.js'

// Thrown for non-2xx control-plane responses; Message carries the server's error text.
export class ApiError extends Error
{
    public static readonly UnauthorizedStatus = 401

    public readonly Status: number

    public constructor(status: number, message: string)
    {
        super(message)
        this.Status = status
    }
}

// fetch wrapper over the control-plane REST API plus one shared events socket.
export class ControlPlaneClient
{
    private static readonly EnvironmentsRoute = '/api/environments'
    private static readonly TemplatesRoute = '/api/templates'
    private static readonly LoginRoute = '/api/login'
    private static readonly LogoutRoute = '/api/logout'
    private static readonly SessionRoute = '/api/session'
    private static readonly CredentialsMode = 'same-origin'
    private static readonly EventsRoute = '/api/events'
    private static readonly PathSeparator = '/'
    private static readonly StartAction = 'start'
    private static readonly StopAction = 'stop'
    private static readonly LogsAction = 'logs'
    private static readonly MethodPost = 'POST'
    private static readonly MethodDelete = 'DELETE'
    private static readonly MethodPut = 'PUT'
    private static readonly AdminSegment = '/admin/'
    private static readonly SnapshotLeaf = 'snapshot'
    private static readonly AccountsLeaf = 'accounts'
    private static readonly GrantsLeaf = 'grants'
    private static readonly ConfigLeaf = 'config'
    private static readonly SecurityModelLeaf = 'security-model'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly JsonType = 'application/json'
    private static readonly EmptyBody = '{}'
    private static readonly ChangedType = 'environments-changed'
    private static readonly WsScheme = 'ws:'
    private static readonly WssScheme = 'wss:'
    private static readonly HttpsScheme = 'https:'
    private static readonly SchemeSuffix = '//'
    private static readonly MessageEvent = 'message'
    private static readonly CloseEvent = 'close'
    private static readonly ReconnectDelayMs = 2000
    private static readonly RequestFailed = 'Request failed: '

    private readonly handlers: Array<() => void> = []
    private socket: WebSocket | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return await this.Send<EnvironmentDto[]>(ControlPlaneClient.EnvironmentsRoute, undefined)
    }

    public async Login(email: string, password: string): Promise<void>
    {
        await this.Send<unknown>(ControlPlaneClient.LoginRoute, { method: ControlPlaneClient.MethodPost, body: JSON.stringify({ email, password }) })
    }

    public async Logout(): Promise<void>
    {
        await this.Send<unknown>(ControlPlaneClient.LogoutRoute, { method: ControlPlaneClient.MethodPost, body: ControlPlaneClient.EmptyBody })
    }

    // The signed-in operator, or null when there is no valid session (401).
    public async Session(): Promise<OperatorDto | null>
    {
        try
        {
            return await this.Send<OperatorDto>(ControlPlaneClient.SessionRoute, undefined)
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
            {
                return null
            }
            throw e
        }
    }

    public async ListTemplates(): Promise<TemplateDto[]>
    {
        return await this.Send<TemplateDto[]>(ControlPlaneClient.TemplatesRoute, undefined)
    }

    public async CreateEnvironment(name: string, template: string, hostPort?: number): Promise<EnvironmentDto>
    {
        const body: Record<string, unknown> = { name, template }
        if (hostPort !== undefined)
        {
            body.hostPort = hostPort
        }
        return await this.Send<EnvironmentDto>(ControlPlaneClient.EnvironmentsRoute, { method: ControlPlaneClient.MethodPost, body: JSON.stringify(body) })
    }

    public async StartEnvironment(name: string): Promise<EnvironmentDto>
    {
        return await this.Action(name, ControlPlaneClient.StartAction)
    }

    public async StopEnvironment(name: string): Promise<EnvironmentDto>
    {
        return await this.Action(name, ControlPlaneClient.StopAction)
    }

    public async DeleteEnvironment(name: string): Promise<void>
    {
        await this.Send<unknown>(this.EnvRoute(name), { method: ControlPlaneClient.MethodDelete })
    }

    public async Logs(name: string): Promise<string>
    {
        const result = await this.Send<{ logs: string }>(this.EnvRoute(name) + ControlPlaneClient.PathSeparator + ControlPlaneClient.LogsAction, undefined)
        return result.logs
    }

    public async Snapshot(name: string): Promise<AdminSnapshotDto>
    {
        return await this.Send<AdminSnapshotDto>(this.AdminRoute(name, ControlPlaneClient.SnapshotLeaf), undefined)
    }

    public async CreateAccount(name: string, email: string, principalId: string, password: string): Promise<void>
    {
        await this.Send<unknown>(this.AdminRoute(name, ControlPlaneClient.AccountsLeaf),
            { method: ControlPlaneClient.MethodPost, body: JSON.stringify({ email, principalId, password }) })
    }

    public async DisableAccount(name: string, principalId: string): Promise<void>
    {
        await this.Send<unknown>(this.AdminRoute(name, ControlPlaneClient.AccountsLeaf) + ControlPlaneClient.PathSeparator + encodeURIComponent(principalId),
            { method: ControlPlaneClient.MethodDelete })
    }

    public async GrantRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        await this.Send<unknown>(this.AdminRoute(name, ControlPlaneClient.GrantsLeaf), { method: ControlPlaneClient.MethodPost, body: JSON.stringify(mutation) })
    }

    public async RevokeRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        await this.Send<unknown>(this.AdminRoute(name, ControlPlaneClient.GrantsLeaf), { method: ControlPlaneClient.MethodDelete, body: JSON.stringify(mutation) })
    }

    public async GetConfig(name: string): Promise<IdentityConfigDto>
    {
        return await this.Send<IdentityConfigDto>(this.AdminRoute(name, ControlPlaneClient.ConfigLeaf), undefined)
    }

    public async SetConfig(name: string, config: IdentityConfigDto): Promise<void>
    {
        await this.Send<unknown>(this.AdminRoute(name, ControlPlaneClient.ConfigLeaf), { method: ControlPlaneClient.MethodPut, body: JSON.stringify(config) })
    }

    // The tenant's access SecurityModel; null when none is stored yet.
    public async GetSecurityModel(name: string): Promise<SecurityModelDto | null>
    {
        return await this.Send<SecurityModelDto | null>(this.AdminRoute(name, ControlPlaneClient.SecurityModelLeaf), undefined)
    }

    public async SetSecurityModel(name: string, securityModel: SecurityModelDto): Promise<void>
    {
        await this.Send<unknown>(this.AdminRoute(name, ControlPlaneClient.SecurityModelLeaf),
            { method: ControlPlaneClient.MethodPut, body: JSON.stringify({ securityModel }) })
    }

    // Registers a handler; the single /api/events socket is opened on first use.
    public OnChanged(handler: () => void): void
    {
        this.handlers.push(handler)
        if (this.socket !== undefined)
        {
            return
        }
        this.Connect()
    }

    private Connect(): void
    {
        const scheme = location.protocol === ControlPlaneClient.HttpsScheme ? ControlPlaneClient.WssScheme : ControlPlaneClient.WsScheme
        const socket = new WebSocket(scheme + ControlPlaneClient.SchemeSuffix + location.host + ControlPlaneClient.EventsRoute)
        socket.addEventListener(ControlPlaneClient.MessageEvent, (ev: MessageEvent) => { this.OnMessage(String(ev.data)) })
        socket.addEventListener(ControlPlaneClient.CloseEvent, () => { this.OnClosed(socket) })
        this.socket = socket
    }

    // Reopens the socket after a delay; skipped if Dispose() ran or the socket was already replaced.
    private OnClosed(closed: WebSocket): void
    {
        if (this.socket !== closed)
        {
            return
        }
        this.socket = undefined
        setTimeout(() =>
        {
            if (this.socket === undefined && this.handlers.length > 0)
            {
                this.Connect()
            }
        }, ControlPlaneClient.ReconnectDelayMs)
    }

    public Dispose(): void
    {
        this.socket?.close()
        this.socket = undefined
        this.handlers.length = 0
    }

    private OnMessage(text: string): void
    {
        let parsed: { type?: string }
        try
        {
            parsed = JSON.parse(text) as { type?: string }
        }
        catch
        {
            return
        }
        if (parsed.type === ControlPlaneClient.ChangedType)
        {
            for (const h of this.handlers)
            {
                h()
            }
        }
    }

    private EnvRoute(name: string): string
    {
        return ControlPlaneClient.EnvironmentsRoute + ControlPlaneClient.PathSeparator + encodeURIComponent(name)
    }

    private AdminRoute(name: string, leaf: string): string
    {
        return this.EnvRoute(name) + ControlPlaneClient.AdminSegment + leaf
    }

    private async Action(name: string, action: string): Promise<EnvironmentDto>
    {
        return await this.Send<EnvironmentDto>(this.EnvRoute(name) + ControlPlaneClient.PathSeparator + action,
            { method: ControlPlaneClient.MethodPost, body: ControlPlaneClient.EmptyBody })
    }

    private async Send<T>(route: string, init: { method: string; body?: string } | undefined): Promise<T>
    {
        const response = await fetch(route, init === undefined ? { credentials: ControlPlaneClient.CredentialsMode } :
            { method: init.method, body: init.body, credentials: ControlPlaneClient.CredentialsMode, headers: { [ControlPlaneClient.ContentTypeHeader]: ControlPlaneClient.JsonType } })
        let payload: unknown
        try
        {
            payload = await response.json()
        }
        catch
        {
            payload = undefined
        }
        if (!response.ok)
        {
            const message = (payload as { error?: string } | undefined)?.error
            throw new ApiError(response.status, message ?? ControlPlaneClient.RequestFailed + String(response.status))
        }
        return payload as T
    }
}
