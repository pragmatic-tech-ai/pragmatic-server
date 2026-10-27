import { TenantEventType } from './tenant-types.js'
import type { AdminSnapshotDto, CreateAccountParams, CreateEnvironmentParams, EnvironmentDto, GrantMutationDto, HiveDto, HiveHealthDto, HiveRolloutDto, IssueTokenParams, ISecurityModelSource, ITokensSource, IUsersAccessSource, IWebSocketFactory, IWebSocketLike, ManifestDto, SecurityModelDto, ServiceTokenSummaryDto, SessionDto, TenantEvent, TenantProfileDto, TokenIssuedDto } from './tenant-types.js'

// Thrown for non-2xx tenant-surface responses; Message carries the server's error text.
export class TenantApiError extends Error
{
    public static readonly UnauthorizedStatus = 401
    public static readonly ForbiddenStatus = 403

    public readonly Status: number

    public constructor(status: number, message: string)
    {
        super(message)
        this.Status = status
    }
}

// Real IWebSocketLike over the browser WebSocket.
export class BrowserWebSocket implements IWebSocketLike
{
    private static readonly MessageEvent = 'message'
    private static readonly CloseEvent = 'close'

    private readonly socket: WebSocket

    public constructor(url: string)
    {
        this.socket = new globalThis.WebSocket(url)
    }

    public OnMessage(cb: (data: string) => void): void
    {
        this.socket.addEventListener(BrowserWebSocket.MessageEvent, (ev: Event) => { cb(String((ev as MessageEvent).data)) })
    }

    public OnClose(cb: () => void): void
    {
        this.socket.addEventListener(BrowserWebSocket.CloseEvent, () => { cb() })
    }

    public Close(): void
    {
        this.socket.close()
    }
}

export class BrowserWebSocketFactory implements IWebSocketFactory
{
    public Open(url: string): IWebSocketLike
    {
        return new BrowserWebSocket(url)
    }
}

// fetch wrapper over the tenant REST surface plus the events and log-follow sockets.
export class TenantApiClient implements IUsersAccessSource, ITokensSource, ISecurityModelSource
{
    private static readonly SessionRoute = '/tenant-auth/session'
    private static readonly ProfileRoute = '/tenant-api/profile'
    private static readonly LogoutRoute = '/tenant-auth/logout'
    private static readonly BeginLoginRoute = '/tenant-auth/oidc/begin'
    private static readonly HivesRoute = '/tenant-api/hives'
    private static readonly EnvironmentsRoute = '/tenant-api/environments'
    private static readonly ManifestsRoute = '/tenant-api/manifests'
    private static readonly EventsRoute = '/tenant-api/events'
    private static readonly RolloutLeaf = 'rollout'
    private static readonly HealthLeaf = 'health'
    private static readonly TargetLeaf = 'target'
    private static readonly LogStreamLeaf = 'logs/stream'
    private static readonly StartAction = 'start'
    private static readonly StopAction = 'stop'
    private static readonly RestartAction = 'restart'
    private static readonly PathSeparator = '/'
    private static readonly MethodPost = 'POST'
    private static readonly MethodDelete = 'DELETE'
    private static readonly MethodPut = 'PUT'
    private static readonly AdminSnapshotLeaf = '/admin/snapshot'
    private static readonly AdminAccountsLeaf = '/admin/accounts'
    private static readonly AdminGrantsLeaf = '/admin/grants'
    private static readonly AdminTokensLeaf = '/admin/tokens'
    private static readonly AdminSecurityModelLeaf = '/admin/security-model'
    private static readonly CredentialsMode = 'same-origin'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly JsonType = 'application/json'
    private static readonly EmptyBody = '{}'
    private static readonly HttpsScheme = 'https:'
    private static readonly WsScheme = 'ws:'
    private static readonly WssScheme = 'wss:'
    private static readonly SchemeSuffix = '//'
    private static readonly ReconnectDelayMs = 2000
    private static readonly RequestFailed = 'Request failed: '

    private readonly sockets: IWebSocketFactory
    private readonly handlers: Array<(ev: TenantEvent) => void> = []
    private events: IWebSocketLike | undefined

    public constructor(sockets: IWebSocketFactory = new BrowserWebSocketFactory())
    {
        this.sockets = sockets
    }

    // The signed-in tenant principal, or null when there is no valid session (401).
    public async Session(): Promise<SessionDto | null>
    {
        try
        {
            return await this.Send<SessionDto>(TenantApiClient.SessionRoute, undefined)
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
            {
                return null
            }
            throw e
        }
    }

    // The signed-in principal's profile and admin capabilities; Send throws TenantApiError on non-2xx.
    public async Profile(): Promise<TenantProfileDto>
    {
        return await this.Send<TenantProfileDto>(TenantApiClient.ProfileRoute, undefined)
    }

    public BeginLogin(): void
    {
        this.Navigate(TenantApiClient.BeginLoginRoute)
    }

    public async Logout(): Promise<void>
    {
        await this.Send<unknown>(TenantApiClient.LogoutRoute, { method: TenantApiClient.MethodPost, body: TenantApiClient.EmptyBody })
    }

    public async ListHives(): Promise<HiveDto[]>
    {
        return await this.Send<HiveDto[]>(TenantApiClient.HivesRoute, undefined)
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return await this.Send<EnvironmentDto[]>(TenantApiClient.EnvironmentsRoute, undefined)
    }

    // POSTs a new environment; a duplicate name surfaces as TenantApiError with Status 409.
    public async CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto>
    {
        const body = { name: params.name, template: params.template, type: params.type }
        return await this.Send<EnvironmentDto>(TenantApiClient.EnvironmentsRoute, { method: TenantApiClient.MethodPost, body: JSON.stringify(body) })
    }

    public async ListManifests(): Promise<ManifestDto[]>
    {
        return await this.Send<ManifestDto[]>(TenantApiClient.ManifestsRoute, undefined)
    }

    public async GetRollout(hiveId: string): Promise<HiveRolloutDto>
    {
        return await this.Send<HiveRolloutDto>(this.HiveRoute(hiveId, TenantApiClient.RolloutLeaf), undefined)
    }

    public async GetHealth(hiveId: string): Promise<HiveHealthDto[]>
    {
        return await this.Send<HiveHealthDto[]>(this.HiveRoute(hiveId, TenantApiClient.HealthLeaf), undefined)
    }

    public async SelectTarget(hiveId: string, version: string): Promise<void>
    {
        await this.Send<unknown>(this.HiveRoute(hiveId, TenantApiClient.TargetLeaf), { method: TenantApiClient.MethodPost, body: JSON.stringify({ version }) })
    }

    public async StartEnvironment(name: string): Promise<EnvironmentDto>
    {
        return await this.Action(name, TenantApiClient.StartAction)
    }

    public async StopEnvironment(name: string): Promise<EnvironmentDto>
    {
        return await this.Action(name, TenantApiClient.StopAction)
    }

    public async RestartEnvironment(name: string): Promise<EnvironmentDto>
    {
        return await this.Action(name, TenantApiClient.RestartAction)
    }

    public async GetAdminSnapshot(env: string): Promise<AdminSnapshotDto>
    {
        return await this.Send<AdminSnapshotDto>(this.EnvRoute(env) + TenantApiClient.AdminSnapshotLeaf, undefined)
    }

    public async CreateAccount(env: string, params: CreateAccountParams): Promise<void>
    {
        await this.Send<unknown>(this.EnvRoute(env) + TenantApiClient.AdminAccountsLeaf, { method: TenantApiClient.MethodPost, body: JSON.stringify(params) })
    }

    public async DisableAccount(env: string, principalId: string): Promise<void>
    {
        await this.Send<unknown>(this.EnvRoute(env) + TenantApiClient.AdminAccountsLeaf + TenantApiClient.PathSeparator + encodeURIComponent(principalId),
            { method: TenantApiClient.MethodDelete })
    }

    public async GrantRole(env: string, grant: GrantMutationDto): Promise<void>
    {
        await this.Send<unknown>(this.EnvRoute(env) + TenantApiClient.AdminGrantsLeaf, { method: TenantApiClient.MethodPost, body: JSON.stringify(grant) })
    }

    public async RevokeRole(env: string, grant: GrantMutationDto): Promise<void>
    {
        await this.Send<unknown>(this.EnvRoute(env) + TenantApiClient.AdminGrantsLeaf, { method: TenantApiClient.MethodDelete, body: JSON.stringify(grant) })
    }

    public async ListTokens(env: string): Promise<ServiceTokenSummaryDto[]>
    {
        return await this.Send<ServiceTokenSummaryDto[]>(this.EnvRoute(env) + TenantApiClient.AdminTokensLeaf, undefined)
    }

    public async IssueToken(env: string, params: IssueTokenParams): Promise<TokenIssuedDto>
    {
        return await this.Send<TokenIssuedDto>(this.EnvRoute(env) + TenantApiClient.AdminTokensLeaf, { method: TenantApiClient.MethodPost, body: JSON.stringify(params) })
    }

    public async RevokeToken(env: string, tokenRef: string): Promise<void>
    {
        await this.Send<unknown>(this.EnvRoute(env) + TenantApiClient.AdminTokensLeaf, { method: TenantApiClient.MethodDelete, body: JSON.stringify({ tokenRef }) })
    }

    public async GetSecurityModel(env: string): Promise<SecurityModelDto | null>
    {
        return await this.Send<SecurityModelDto | null>(this.EnvRoute(env) + TenantApiClient.AdminSecurityModelLeaf, undefined)
    }

    public async SetSecurityModel(env: string, model: SecurityModelDto): Promise<void>
    {
        await this.Send<unknown>(this.EnvRoute(env) + TenantApiClient.AdminSecurityModelLeaf, { method: TenantApiClient.MethodPut, body: JSON.stringify({ securityModel: model }) })
    }

    // Registers a handler on the shared events socket (opened lazily); returns an unsubscribe.
    public OnEvent(handler: (ev: TenantEvent) => void): () => void
    {
        this.handlers.push(handler)
        if (this.events === undefined)
        {
            this.Connect()
        }
        return () =>
        {
            const i = this.handlers.indexOf(handler)
            if (i >= 0)
            {
                this.handlers.splice(i, 1)
            }
            if (this.handlers.length === 0)
            {
                const socket = this.events
                this.events = undefined
                socket?.Close()
            }
        }
    }

    // Follows an environment's logs; raw text frames go to onChunk. The returned function closes the stream.
    public OpenLogStream(name: string, onChunk: (text: string) => void): () => void
    {
        const socket = this.sockets.Open(this.WsBase() + this.EnvRoute(name) + TenantApiClient.PathSeparator + TenantApiClient.LogStreamLeaf)
        socket.OnMessage(data => { onChunk(data) })
        return () => { socket.Close() }
    }

    // Seams: tests override these (no browser location / navigation in node).
    protected Navigate(url: string): void
    {
        location.href = url
    }

    protected WsBase(): string
    {
        const scheme = location.protocol === TenantApiClient.HttpsScheme ? TenantApiClient.WssScheme : TenantApiClient.WsScheme
        return scheme + TenantApiClient.SchemeSuffix + location.host
    }

    private Connect(): void
    {
        const socket = this.sockets.Open(this.WsBase() + TenantApiClient.EventsRoute)
        socket.OnMessage(data => { this.Deliver(data) })
        socket.OnClose(() => { this.OnClosed(socket) })
        this.events = socket
    }

    // Reopens the socket after a delay; skipped if all handlers left or the socket was already replaced.
    private OnClosed(closed: IWebSocketLike): void
    {
        if (this.events !== closed)
        {
            return
        }
        this.events = undefined
        setTimeout(() =>
        {
            if (this.events === undefined && this.handlers.length > 0)
            {
                this.Connect()
            }
        }, TenantApiClient.ReconnectDelayMs)
    }

    private Deliver(text: string): void
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            return
        }
        if (!TenantApiClient.IsTenantEvent(parsed))
        {
            return
        }
        for (const h of [...this.handlers])
        {
            h(parsed)
        }
    }

    private static IsTenantEvent(value: unknown): value is TenantEvent
    {
        if (typeof value !== 'object' || value === null)
        {
            return false
        }
        const candidate = value as { type?: unknown; environmentName?: unknown }
        return Object.values(TenantEventType).includes(candidate.type as TenantEventType)
            && typeof candidate.environmentName === 'string' && candidate.environmentName.length > 0
    }

    private HiveRoute(hiveId: string, leaf: string): string
    {
        return TenantApiClient.HivesRoute + TenantApiClient.PathSeparator + encodeURIComponent(hiveId) + TenantApiClient.PathSeparator + leaf
    }

    private EnvRoute(name: string): string
    {
        return TenantApiClient.EnvironmentsRoute + TenantApiClient.PathSeparator + encodeURIComponent(name)
    }

    private async Action(name: string, action: string): Promise<EnvironmentDto>
    {
        return await this.Send<EnvironmentDto>(this.EnvRoute(name) + TenantApiClient.PathSeparator + action,
            { method: TenantApiClient.MethodPost, body: TenantApiClient.EmptyBody })
    }

    private async Send<T>(route: string, init: { method: string; body?: string } | undefined): Promise<T>
    {
        const response = await fetch(route, init === undefined ? { credentials: TenantApiClient.CredentialsMode } :
            { method: init.method, body: init.body, credentials: TenantApiClient.CredentialsMode, headers: { [TenantApiClient.ContentTypeHeader]: TenantApiClient.JsonType } })
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
            throw new TenantApiError(response.status, message ?? TenantApiClient.RequestFailed + String(response.status))
        }
        return payload as T
    }
}
