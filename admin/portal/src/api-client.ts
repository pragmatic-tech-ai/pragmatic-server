import type { EnvironmentDto, TemplateDto } from './portal-types.js'

// Thrown for non-2xx control-plane responses; Message carries the server's error text.
export class ApiError extends Error
{
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
    private static readonly EventsRoute = '/api/events'
    private static readonly PathSeparator = '/'
    private static readonly StartAction = 'start'
    private static readonly StopAction = 'stop'
    private static readonly LogsAction = 'logs'
    private static readonly MethodPost = 'POST'
    private static readonly MethodDelete = 'DELETE'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly JsonType = 'application/json'
    private static readonly EmptyBody = '{}'
    private static readonly ChangedType = 'environments-changed'
    private static readonly WsScheme = 'ws:'
    private static readonly WssScheme = 'wss:'
    private static readonly HttpsScheme = 'https:'
    private static readonly SchemeSuffix = '//'
    private static readonly MessageEvent = 'message'
    private static readonly RequestFailed = 'Request failed: '

    private readonly handlers: Array<() => void> = []
    private socket: WebSocket | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return await this.Send<EnvironmentDto[]>(ControlPlaneClient.EnvironmentsRoute, undefined)
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

    // Registers a handler; the single /api/events socket is opened on first use.
    public OnChanged(handler: () => void): void
    {
        this.handlers.push(handler)
        if (this.socket !== undefined)
        {
            return
        }
        const scheme = location.protocol === ControlPlaneClient.HttpsScheme ? ControlPlaneClient.WssScheme : ControlPlaneClient.WsScheme
        const socket = new WebSocket(scheme + ControlPlaneClient.SchemeSuffix + location.host + ControlPlaneClient.EventsRoute)
        socket.addEventListener(ControlPlaneClient.MessageEvent, (ev: MessageEvent) => { this.OnMessage(String(ev.data)) })
        this.socket = socket
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

    private async Action(name: string, action: string): Promise<EnvironmentDto>
    {
        return await this.Send<EnvironmentDto>(this.EnvRoute(name) + ControlPlaneClient.PathSeparator + action,
            { method: ControlPlaneClient.MethodPost, body: ControlPlaneClient.EmptyBody })
    }

    private async Send<T>(route: string, init: { method: string; body?: string } | undefined): Promise<T>
    {
        const response = await fetch(route, init === undefined ? undefined :
            { method: init.method, body: init.body, headers: { [ControlPlaneClient.ContentTypeHeader]: ControlPlaneClient.JsonType } })
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
