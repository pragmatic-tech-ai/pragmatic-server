import type { ClientDto, EnvironmentDto, HiveDto, FleetHiveDto, ManifestDto, OperatorSummaryDto, GatingDto, SelectionDto, TenantDto, GraphDto, GraphLoadedDto, OperatorDto, PromotionResultDto } from './portal-types.js'

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
    private static readonly ClientsRoute = '/api/clients'
    private static readonly TenantsRoute = '/api/tenants'
    private static readonly HivesRoute = '/api/hives'
    private static readonly FleetRoute = '/api/fleet'
    private static readonly ManifestsRoute = '/api/manifests'
    private static readonly OperatorsRoute = '/api/operators'
    private static readonly GatingRoute = '/api/gating'
    private static readonly SelectionsRoute = '/api/selections'
    private static readonly LoginRoute = '/api/login'
    private static readonly LogoutRoute = '/api/logout'
    private static readonly SessionRoute = '/api/session'
    private static readonly CredentialsMode = 'same-origin'
    private static readonly EventsRoute = '/api/events'
    private static readonly EventsTicketRoute = '/api/events-ticket'
    private static readonly PathSeparator = '/'
    private static readonly GraphsLeaf = 'graphs'
    private static readonly PromoteLeaf = 'promote'
    private static readonly LoadedGraphLeaf = 'loaded-graph'
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
    private static readonly CloseEvent = 'close'
    private static readonly ReconnectDelayMs = 2000
    private static readonly RequestFailed = 'Request failed: '

    private readonly handlers: Array<() => void> = []
    private socket: WebSocket | undefined
    private connecting = false

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return await this.Send<EnvironmentDto[]>(ControlPlaneClient.EnvironmentsRoute, undefined)
    }

    public async ListClients(): Promise<ClientDto[]>
    {
        return await this.Send<ClientDto[]>(ControlPlaneClient.ClientsRoute, undefined)
    }

    public async CreateClient(id: string, displayName: string, subscriptionRef?: string): Promise<ClientDto>
    {
        const body: Record<string, unknown> = { id, displayName }
        if (subscriptionRef !== undefined)
        {
            body.subscriptionRef = subscriptionRef
        }
        return await this.Send<ClientDto>(ControlPlaneClient.ClientsRoute, { method: ControlPlaneClient.MethodPost, body: JSON.stringify(body) })
    }

    public async DeleteClient(id: string): Promise<void>
    {
        await this.Send<unknown>(this.ItemRoute(ControlPlaneClient.ClientsRoute, id), { method: ControlPlaneClient.MethodDelete })
    }

    // No server-side parent filter exists; filters the full list by clientId when given.
    public async ListTenants(clientId?: string): Promise<TenantDto[]>
    {
        const all = await this.Send<TenantDto[]>(ControlPlaneClient.TenantsRoute, undefined)
        return clientId === undefined ? all : all.filter(t => t.clientId === clientId)
    }

    public async CreateTenant(id: string, clientId: string, displayName: string): Promise<TenantDto>
    {
        return await this.Send<TenantDto>(ControlPlaneClient.TenantsRoute, { method: ControlPlaneClient.MethodPost, body: JSON.stringify({ id, clientId, displayName }) })
    }

    public async DeleteTenant(id: string): Promise<void>
    {
        await this.Send<unknown>(this.ItemRoute(ControlPlaneClient.TenantsRoute, id), { method: ControlPlaneClient.MethodDelete })
    }

    // No server-side parent filter exists; filters the full list by tenantId when given.
    public async ListHives(tenantId?: string): Promise<HiveDto[]>
    {
        const all = await this.Send<HiveDto[]>(ControlPlaneClient.HivesRoute, undefined)
        return tenantId === undefined ? all : all.filter(h => h.tenantId === tenantId)
    }

    public async ListFleet(): Promise<FleetHiveDto[]>
    {
        return await this.Send<FleetHiveDto[]>(ControlPlaneClient.FleetRoute, undefined)
    }

    public async ListManifests(): Promise<ManifestDto[]>
    {
        return await this.Send<ManifestDto[]>(ControlPlaneClient.ManifestsRoute, undefined)
    }

    public async ListOperators(): Promise<OperatorSummaryDto[]>
    {
        return await this.Send<OperatorSummaryDto[]>(ControlPlaneClient.OperatorsRoute, undefined)
    }

    public async ListGating(): Promise<GatingDto[]>
    {
        return await this.Send<GatingDto[]>(ControlPlaneClient.GatingRoute, undefined)
    }

    public async ListSelections(): Promise<SelectionDto[]>
    {
        return await this.Send<SelectionDto[]>(ControlPlaneClient.SelectionsRoute, undefined)
    }

    public async CreateHive(input: HiveDto): Promise<HiveDto>
    {
        return await this.Send<HiveDto>(ControlPlaneClient.HivesRoute, { method: ControlPlaneClient.MethodPost, body: JSON.stringify(input) })
    }

    public async DeleteHive(id: string): Promise<void>
    {
        await this.Send<unknown>(this.ItemRoute(ControlPlaneClient.HivesRoute, id), { method: ControlPlaneClient.MethodDelete })
    }

    private ItemRoute(collection: string, id: string): string
    {
        return collection + ControlPlaneClient.PathSeparator + encodeURIComponent(id)
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

    // Registers a handler; the single /api/events socket is opened on first use.
    public OnChanged(handler: () => void): void
    {
        this.handlers.push(handler)
        if (this.socket !== undefined || this.connecting)
        {
            return
        }
        this.Connect()
    }

    // Fetches a single-use ticket, then opens the socket with it as the subprotocol; no ticket, no socket (retried via the reconnect delay).
    private Connect(): void
    {
        this.connecting = true
        void this.OpenWithTicket().finally(() => { this.connecting = false })
    }

    private async OpenWithTicket(): Promise<void>
    {
        let ticket: string
        try
        {
            ticket = (await this.Send<{ ticket: string }>(ControlPlaneClient.EventsTicketRoute, undefined)).ticket
        }
        catch (e)
        {
            if (!(e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus))
            {
                this.ScheduleReconnect()
            }
            return
        }
        if (this.handlers.length === 0 || this.socket !== undefined)
        {
            return
        }
        const scheme = location.protocol === ControlPlaneClient.HttpsScheme ? ControlPlaneClient.WssScheme : ControlPlaneClient.WsScheme
        const socket = new WebSocket(scheme + ControlPlaneClient.SchemeSuffix + location.host + ControlPlaneClient.EventsRoute, [ticket])
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
        this.ScheduleReconnect()
    }

    private ScheduleReconnect(): void
    {
        setTimeout(() =>
        {
            if (this.socket === undefined && !this.connecting && this.handlers.length > 0)
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

    private GraphsRoute(envName: string): string
    {
        return this.EnvRoute(envName) + ControlPlaneClient.PathSeparator + ControlPlaneClient.GraphsLeaf
    }

    private PromoteRoute(envName: string, graphName: string): string
    {
        return this.GraphsRoute(envName) + ControlPlaneClient.PathSeparator + encodeURIComponent(graphName) + ControlPlaneClient.PathSeparator + ControlPlaneClient.PromoteLeaf
    }

    private LoadedGraphRoute(envName: string): string
    {
        return this.EnvRoute(envName) + ControlPlaneClient.PathSeparator + ControlPlaneClient.LoadedGraphLeaf
    }

    public async ListGraphs(envName: string): Promise<GraphDto[]>
    {
        return await this.Send<GraphDto[]>(this.GraphsRoute(envName), undefined)
    }

    public async CreateGraph(envName: string, name: string, description: string): Promise<GraphDto>
    {
        return await this.Send<GraphDto>(this.GraphsRoute(envName), { method: ControlPlaneClient.MethodPost, body: JSON.stringify({ name, description }) })
    }

    public async DeleteGraph(envName: string, graphName: string): Promise<void>
    {
        await this.Send<unknown>(this.GraphsRoute(envName) + ControlPlaneClient.PathSeparator + encodeURIComponent(graphName), { method: ControlPlaneClient.MethodDelete })
    }

    // Promotes a development graph into a runtime environment.
    public async PromoteGraph(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
    {
        return await this.Send<PromotionResultDto>(this.PromoteRoute(sourceEnv, graphName), { method: ControlPlaneClient.MethodPost, body: JSON.stringify({ targetEnv }) })
    }

    // The runtime's loaded graph; null when none has been promoted.
    public async GetLoadedGraph(runtimeEnv: string): Promise<GraphLoadedDto | null>
    {
        return await this.Send<GraphLoadedDto | null>(this.LoadedGraphRoute(runtimeEnv), undefined)
    }

    private EnvRoute(name: string): string
    {
        return ControlPlaneClient.EnvironmentsRoute + ControlPlaneClient.PathSeparator + encodeURIComponent(name)
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
