import { ApiError, AppSessionClient, BrowserPage, type FetchFunction, type IPageLocation } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { TenantShell } from './shell/tenant-shell.js'
import { TenantEventType } from './tenant-types.js'
import type { AdminSnapshotDto, AdoptionLedgerDto, ConfigurationApplyDto, ConfigurationComponentDetailDto, ConfigurationComponentDto, ConfigurationDiffDto, ConfigurationVersionDto, ConfigurationVersionSummaryDto, CreateAccountParams, CreateEnvironmentParams, CreateGraphParams, EmailDomainsDto, EnvironmentDto, GrantMutationDto, GraphDto, HiveDto, HiveHealthDto, HiveRolloutDto, IReleasesSource, IssueTokenParams, ISecurityModelSource, ITokensSource, IUsersAccessSource, IWebSocketFactory, IWebSocketLike, ManifestDto, SecurityCatalogDto, SecurityChangesDto, SecurityModelDto, ServiceTokenSummaryDto, TenantEvent, TeamMemberDto, TenantProfileDto, TokenIssuedDto } from './tenant-types.js'

// The shell's error type: thrown for every non-2xx tenant-surface answer, its message the server's error text.
export { ApiError }

// Real IWebSocketLike over the browser WebSocket; the ticket is its lone subprotocol.
export class BrowserWebSocket implements IWebSocketLike
{
    private static readonly MessageEvent = 'message'
    private static readonly CloseEvent = 'close'

    private readonly socket: WebSocket

    public constructor(url: string, ticket: string)
    {
        this.socket = new globalThis.WebSocket(url, [ticket])
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
    public get Location(): IPageLocation
    {
        return BrowserPage.Location
    }

    public Open(url: string, ticket: string): IWebSocketLike
    {
        return new BrowserWebSocket(url, ticket)
    }
}

// The tenant admin console's client: the tenant REST surface plus the events and log-follow sockets. It is the shell's
// AppSessionClient (session probe, OIDC sign-in, logout, WebSocket tickets), so every request raises the same 401 / 403
// signals the session service listens to. Each socket takes a fresh single-use ticket as its subprotocol.
export class TenantApiClient extends AppSessionClient implements IReleasesSource, IUsersAccessSource, ITokensSource, ISecurityModelSource
{
    private static readonly ProfileRoute = '/tenant-api/profile'
    private static readonly EmailDomainsRoute = '/tenant-api/settings/email-domains'
    private static readonly EmailDomainsVerifyRoute = TenantApiClient.EmailDomainsRoute + '/verify'
    private static readonly DomainsKey = 'domains'
    private static readonly DomainKey = 'domain'
    private static readonly HivesRoute = '/tenant-api/hives'
    private static readonly EnvironmentsRoute = '/tenant-api/environments'
    private static readonly ManifestsRoute = '/tenant-api/manifests'
    private static readonly EventsRoute = '/tenant-api/events'
    private static readonly ConfigurationComponentsRoute = '/tenant-api/configuration/components'
    private static readonly VersionsLeaf = 'versions'
    private static readonly ApplyLeaf = 'apply'
    private static readonly DiffQuery = 'diff?from='
    private static readonly ToParam = '&to='
    private static readonly RolloutLeaf = 'rollout'
    private static readonly HealthLeaf = 'health'
    private static readonly LedgerLeaf = 'ledger'
    private static readonly TargetLeaf = 'target'
    private static readonly LogStreamLeaf = 'logs/stream'
    private static readonly GraphsLeaf = '/graphs'
    private static readonly StartAction = 'start'
    private static readonly StopAction = 'stop'
    private static readonly RestartAction = 'restart'
    private static readonly PathSeparator = '/'
    private static readonly AdminSnapshotLeaf = '/admin/snapshot'
    private static readonly AdminAccountsLeaf = '/admin/accounts'
    private static readonly AdminGrantsLeaf = '/admin/grants'
    private static readonly AdminTokensLeaf = '/admin/tokens'
    private static readonly AdminSecurityModelLeaf = '/admin/security-model'
    private static readonly AdminSecurityCatalogLeaf = '/admin/security-catalog'
    private static readonly AdminTeamMembersLeaf = '/admin/team-members'
    private static readonly AdminSecurityChangesLeaf = '/admin/security-changes'
    private static readonly ReconnectDelayMs = 2000

    private readonly sockets: IWebSocketFactory
    private readonly handlers: Array<(ev: TenantEvent) => void> = []
    private events: IWebSocketLike | undefined
    private connecting = false

    public constructor(sockets: IWebSocketFactory = new BrowserWebSocketFactory(), fetcher?: FetchFunction)
    {
        super(TenantShell.Config, fetcher)
        this.sockets = sockets
    }

    // The signed-in principal's profile and admin capabilities (derived server-side from the roles / app_roles claims).
    public async Profile(): Promise<TenantProfileDto>
    {
        return await this.Get<TenantProfileDto>(TenantApiClient.ProfileRoute)
    }

    // The tenant's email domains (a 404 where the plane serves none); a non-2xx throws ApiError.
    public async GetEmailDomains(): Promise<EmailDomainsDto>
    {
        return await this.Get<EmailDomainsDto>(TenantApiClient.EmailDomainsRoute)
    }

    // Replaces the tenant's email domains (Owner only); the reply is the normalised list. A refusal is a 400 with its sentence.
    public async SetEmailDomains(domains: readonly string[]): Promise<EmailDomainsDto>
    {
        return await this.Put<EmailDomainsDto>(TenantApiClient.EmailDomainsRoute, { [TenantApiClient.DomainsKey]: domains })
    }

    // Checks the domain's DNS TXT record now (Owner only); the reply is the refreshed view. A refusal is a 400/409/429/503 with its sentence.
    public async VerifyEmailDomain(domain: string): Promise<EmailDomainsDto>
    {
        return await this.Post<EmailDomainsDto>(TenantApiClient.EmailDomainsVerifyRoute, { [TenantApiClient.DomainKey]: domain })
    }

    public async ListHives(): Promise<HiveDto[]>
    {
        return await this.Get<HiveDto[]>(TenantApiClient.HivesRoute)
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return await this.Get<EnvironmentDto[]>(TenantApiClient.EnvironmentsRoute)
    }

    // POSTs a new environment; a duplicate name surfaces as ApiError with Status 409.
    public async CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto>
    {
        return await this.Post<EnvironmentDto>(TenantApiClient.EnvironmentsRoute, { name: params.name, template: params.template, type: params.type })
    }

    public async ListManifests(): Promise<ManifestDto[]>
    {
        return await this.Get<ManifestDto[]>(TenantApiClient.ManifestsRoute)
    }

    public async GetRollout(hiveId: string): Promise<HiveRolloutDto>
    {
        return await this.Get<HiveRolloutDto>(this.HiveRoute(hiveId, TenantApiClient.RolloutLeaf))
    }

    public async GetHealth(hiveId: string): Promise<HiveHealthDto[]>
    {
        return await this.Get<HiveHealthDto[]>(this.HiveRoute(hiveId, TenantApiClient.HealthLeaf))
    }

    public async ListHiveLedger(hiveId: string): Promise<readonly AdoptionLedgerDto[]>
    {
        return await this.Get<AdoptionLedgerDto[]>(this.HiveRoute(hiveId, TenantApiClient.LedgerLeaf))
    }

    public async ListLedger(hiveId: string): Promise<readonly AdoptionLedgerDto[]>
    {
        return await this.ListHiveLedger(hiveId)
    }

    public async SelectTarget(hiveId: string, version: string): Promise<void>
    {
        await this.Post<unknown>(this.HiveRoute(hiveId, TenantApiClient.TargetLeaf), { version })
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

    public async DeleteEnvironment(name: string): Promise<void>
    {
        await this.Delete<void>(this.EnvRoute(name))
    }

    public async GetAdminSnapshot(env: string): Promise<AdminSnapshotDto>
    {
        return await this.Get<AdminSnapshotDto>(this.EnvRoute(env) + TenantApiClient.AdminSnapshotLeaf)
    }

    public async CreateAccount(env: string, params: CreateAccountParams): Promise<void>
    {
        await this.Post<unknown>(this.EnvRoute(env) + TenantApiClient.AdminAccountsLeaf, params)
    }

    public async DisableAccount(env: string, principalId: string): Promise<void>
    {
        await this.Delete<unknown>(this.EnvRoute(env) + TenantApiClient.AdminAccountsLeaf + TenantApiClient.PathSeparator + encodeURIComponent(principalId))
    }

    public async GrantRole(env: string, grant: GrantMutationDto): Promise<void>
    {
        await this.Post<unknown>(this.EnvRoute(env) + TenantApiClient.AdminGrantsLeaf, grant)
    }

    public async RevokeRole(env: string, grant: GrantMutationDto): Promise<void>
    {
        await this.Delete<unknown>(this.EnvRoute(env) + TenantApiClient.AdminGrantsLeaf, grant)
    }

    public async ListTokens(env: string): Promise<ServiceTokenSummaryDto[]>
    {
        return await this.Get<ServiceTokenSummaryDto[]>(this.EnvRoute(env) + TenantApiClient.AdminTokensLeaf)
    }

    public async IssueToken(env: string, params: IssueTokenParams): Promise<TokenIssuedDto>
    {
        return await this.Post<TokenIssuedDto>(this.EnvRoute(env) + TenantApiClient.AdminTokensLeaf, params)
    }

    public async RevokeToken(env: string, tokenRef: string): Promise<void>
    {
        await this.Delete<unknown>(this.EnvRoute(env) + TenantApiClient.AdminTokensLeaf, { tokenRef })
    }

    public async GetSecurityModel(env: string): Promise<SecurityModelDto | null>
    {
        return await this.Get<SecurityModelDto | null>(this.EnvRoute(env) + TenantApiClient.AdminSecurityModelLeaf)
    }

    public async SetSecurityModel(env: string, model: SecurityModelDto): Promise<void>
    {
        await this.Put<unknown>(this.EnvRoute(env) + TenantApiClient.AdminSecurityModelLeaf, { securityModel: model })
    }

    public async GetSecurityCatalog(env: string): Promise<SecurityCatalogDto>
    {
        return await this.Get<SecurityCatalogDto>(this.EnvRoute(env) + TenantApiClient.AdminSecurityCatalogLeaf)
    }

    public async ListTeamMembers(env: string, teamId: string): Promise<TeamMemberDto[]>
    {
        return await this.Get<TeamMemberDto[]>(this.EnvRoute(env) + TenantApiClient.AdminTeamMembersLeaf + TenantApiClient.PathSeparator + encodeURIComponent(teamId))
    }

    public async ListSecurityChanges(env: string): Promise<SecurityChangesDto[]>
    {
        return await this.Get<SecurityChangesDto[]>(this.EnvRoute(env) + TenantApiClient.AdminSecurityChangesLeaf)
    }

    // A Development environment's graphs. A refusal (Runtime environment, no reach, unknown environment) is a
    // ApiError carrying the route's sentence.
    public async ListGraphs(environment: string): Promise<GraphDto[]>
    {
        return await this.Get<GraphDto[]>(this.GraphsRoute(environment))
    }

    // POSTs a new graph; a name already used surfaces as ApiError with Status 409.
    public async CreateGraph(environment: string, params: CreateGraphParams): Promise<GraphDto>
    {
        const body = { name: params.name, description: params.description }
        return await this.Post<GraphDto>(this.GraphsRoute(environment), body)
    }

    public async DeleteGraph(environment: string, graph: string): Promise<void>
    {
        await this.Delete<void>(this.GraphsRoute(environment) + TenantApiClient.PathSeparator + encodeURIComponent(graph))
    }

    // The configuration repository's components: each one's version head and its targets (what is applied where).
    public async ListConfigurationComponents(): Promise<ConfigurationComponentDto[]>
    {
        return await this.Get<ConfigurationComponentDto[]>(TenantApiClient.ConfigurationComponentsRoute)
    }

    // One component: its descriptor's options and settings, its versions and its applies.
    public async GetConfigurationComponent(component: string): Promise<ConfigurationComponentDetailDto>
    {
        return await this.Get<ConfigurationComponentDetailDto>(this.ComponentRoute(component))
    }

    public async GetConfigurationVersion(component: string, version: number): Promise<ConfigurationVersionDto>
    {
        return await this.Get<ConfigurationVersionDto>(this.VersionRoute(component, version))
    }

    // What changed from version `from` to version `to` (from 0: the empty document).
    public async DiffConfigurationVersions(component: string, from: number, to: number): Promise<ConfigurationDiffDto>
    {
        return await this.Get<ConfigurationDiffDto>(this.ComponentRoute(component) + TenantApiClient.PathSeparator
            + TenantApiClient.DiffQuery + String(from) + TenantApiClient.ToParam + String(to))
    }

    // Saves a new version on top of `basedOn` (the head the edit started from). A document that does not validate is a
    // 422 whose body lists `errors` by path; a head that moved meanwhile is a 409 whose body names the `head`.
    public async SaveConfigurationVersion(component: string, basedOn: number, document: unknown, comment: string): Promise<ConfigurationVersionSummaryDto>
    {
        return await this.Post<ConfigurationVersionSummaryDto>(this.ComponentRoute(component) + TenantApiClient.PathSeparator + TenantApiClient.VersionsLeaf,
            { basedOn, document, comment })
    }

    // Applies a version to one of the component's target environments; the reply is the apply record (applied or
    // failed with its detail).
    public async ApplyConfigurationVersion(component: string, version: number, environment: string): Promise<ConfigurationApplyDto>
    {
        return await this.Post<ConfigurationApplyDto>(this.VersionRoute(component, version) + TenantApiClient.PathSeparator + TenantApiClient.ApplyLeaf,
            { environment })
    }

    // Registers a handler on the shared events socket (opened lazily); returns an unsubscribe.
    public OnEvent(handler: (ev: TenantEvent) => void): () => void
    {
        this.handlers.push(handler)
        if (this.events === undefined && !this.connecting)
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

    // Follows an environment's logs; raw text frames go to onChunk, and onClose runs when the server (or the
    // network) closes the stream, or when no ticket could be minted for it. The returned function closes the stream
    // (before the socket opened: it never opens).
    public OpenLogStream(name: string, onChunk: (text: string) => void, onClose?: () => void): () => void
    {
        const stream = new TicketedLogStream(onChunk, onClose)
        void this.OpenLog(stream, this.EnvRoute(name) + TenantApiClient.PathSeparator + TenantApiClient.LogStreamLeaf)
        return () => { stream.Close() }
    }

    private async OpenLog(stream: TicketedLogStream, route: string): Promise<void>
    {
        let ticket: string
        try
        {
            ticket = await this.MintWsTicket()
        }
        catch
        {
            stream.Failed()
            return
        }
        stream.Attach(() => this.sockets.Open(this.SocketUrl(route, this.sockets.Location), ticket))
    }

    // Mints a single-use ticket, then opens the events socket with it; no ticket, no socket (retried via the reconnect
    // delay, except after a 401: the session is gone and the page reloads).
    private Connect(): void
    {
        this.connecting = true
        void this.OpenEvents().finally(() => { this.connecting = false })
    }

    private async OpenEvents(): Promise<void>
    {
        let ticket: string
        try
        {
            ticket = await this.MintWsTicket()
        }
        catch (e)
        {
            if (!ApiError.Is(e, ApiError.UnauthorizedStatus))
            {
                this.ScheduleReconnect()
            }
            return
        }
        if (this.handlers.length === 0 || this.events !== undefined)
        {
            return
        }
        const socket = this.sockets.Open(this.SocketUrl(TenantApiClient.EventsRoute, this.sockets.Location), ticket)
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
        this.ScheduleReconnect()
    }

    private ScheduleReconnect(): void
    {
        setTimeout(() =>
        {
            if (this.events === undefined && !this.connecting && this.handlers.length > 0)
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

    private ComponentRoute(component: string): string
    {
        return TenantApiClient.ConfigurationComponentsRoute + TenantApiClient.PathSeparator + encodeURIComponent(component)
    }

    private VersionRoute(component: string, version: number): string
    {
        return this.ComponentRoute(component) + TenantApiClient.PathSeparator + TenantApiClient.VersionsLeaf + TenantApiClient.PathSeparator + String(version)
    }

    private EnvRoute(name: string): string
    {
        return TenantApiClient.EnvironmentsRoute + TenantApiClient.PathSeparator + encodeURIComponent(name)
    }

    private GraphsRoute(environment: string): string
    {
        return this.EnvRoute(environment) + TenantApiClient.GraphsLeaf
    }

    private async Action(name: string, action: string): Promise<EnvironmentDto>
    {
        return await this.Post<EnvironmentDto>(this.EnvRoute(name) + TenantApiClient.PathSeparator + action)
    }
}

// One log-follow stream: its socket opens once its ticket lands, unless the caller closed it first.
export class TicketedLogStream
{
    private socket: IWebSocketLike | undefined
    private closed = false

    public constructor(private readonly onChunk: (text: string) => void, private readonly onClose: (() => void) | undefined)
    {
    }

    // Opens the socket (unless already closed) and routes its frames and its close.
    public Attach(open: () => IWebSocketLike): void
    {
        if (this.closed)
        {
            return
        }
        const socket = open()
        socket.OnMessage(data => { this.onChunk(data) })
        if (this.onClose !== undefined)
        {
            const onClose = this.onClose
            socket.OnClose(() => { onClose() })
        }
        this.socket = socket
    }

    // No ticket could be minted: the stream ends before it began.
    public Failed(): void
    {
        if (!this.closed)
        {
            this.closed = true
            this.onClose?.()
        }
    }

    public Close(): void
    {
        this.closed = true
        this.socket?.Close()
    }
}
