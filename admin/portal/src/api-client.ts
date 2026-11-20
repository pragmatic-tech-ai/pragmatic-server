import { ApiError, AppSessionClient, type FetchFunction } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { BrowserEventSockets, type IEventSocket, type IEventSocketFactory } from './shell/event-sockets.js'
import { PlatformShell } from './shell/platform-shell.js'
import type { ClientDto, CreatedTenantDto, EnvironmentDto, HiveDto, FleetHiveDto, ManifestDto, OperatorSummaryDto, GatingDto, SelectionDto, HiveRolloutDto, TenantDto, GraphDto, GraphLoadedDto, PromotionResultDto, ProvisionInputDto, ProvisionResultDto, PolicyDto, ActivityDto, ObservationDto, LedgerDto, HiveBootstrapDto, RolloutRegistrationDto, AgentInstallStatusDto, HiveDeleteOutcomeDto, OwnerPasswordResetDto, HiveConsoleSpecDto, ConsoleInstallStatusDto, ConsoleRemovalDto, InHiveOwnerPasswordDto, ReleaseRefreshDto, TenantEmailDomainsDto, ProvisionRollbackDto } from './portal-types.js'

// The shell's error type: thrown for every non-2xx control-plane answer, its message the server's error text, its
// Code the server's machine-readable code and its Body the whole error reply (a provision's rollback).
export { ApiError }

// What a refused control-plane request says beyond its sentence: the codes a hive delete answers when "delete anyway"
// may follow, and a failed provision's rollback report.
export class ControlPlaneErrors
{
    // A hive delete that could not remove the agent from its cluster.
    public static readonly AgentUninstallFailedCode = 'agent-uninstall-failed'
    // A hive delete whose local kind cluster could not be destroyed.
    public static readonly ClusterDestroyFailedCode = 'cluster-destroy-failed'

    private static readonly RollbackField = 'rollback'

    // The rollback report a failed provision carries (what was undone, what remains); undefined when none.
    public static Rollback(error: ApiError): ProvisionRollbackDto | undefined
    {
        const rollback = error.Body?.[ControlPlaneErrors.RollbackField]
        if (typeof rollback !== 'object' || rollback === null)
        {
            return undefined
        }
        const candidate = rollback as Partial<ProvisionRollbackDto>
        return Array.isArray(candidate.rolledBack) && Array.isArray(candidate.residue) ? candidate as ProvisionRollbackDto : undefined
    }
}

// The platform admin console's client: the control-plane REST API plus one shared events socket. It is the shell's
// AppSessionClient (session probe, password sign-in, logout, own-password change, WebSocket tickets), so every request
// raises the same 401 / 403 signals the session service listens to.
export class ControlPlaneClient extends AppSessionClient
{
    private static readonly EnvironmentsRoute = '/api/environments'
    private static readonly ClientsRoute = '/api/clients'
    private static readonly TenantsRoute = '/api/tenants'
    private static readonly HivesRoute = '/api/hives'
    private static readonly ProvisionRoute = '/api/provision'
    private static readonly FleetRoute = '/api/fleet'
    private static readonly ManifestsRoute = '/api/manifests'
    private static readonly ReleasesRefreshRoute = '/api/releases/refresh'
    private static readonly OperatorsRoute = '/api/operators'
    private static readonly OperatorRoleRoute = '/api/operators/role'
    private static readonly OperatorPasswordResetRoute = '/api/operators/password-reset'
    private static readonly OperatorDisabledRoute = '/api/operators/disabled'
    private static readonly OperatorRevokeSessionsRoute = '/api/operators/revoke-sessions'
    private static readonly GatingRoute = '/api/gating'
    private static readonly SelectionsRoute = '/api/selections'
    private static readonly RolloutsRoute = '/api/rollouts'
    private static readonly EventsRoute = '/api/events'
    private static readonly PathSeparator = '/'
    private static readonly GraphsLeaf = 'graphs'
    private static readonly PromoteLeaf = 'promote'
    private static readonly LoadedGraphLeaf = 'loaded-graph'
    private static readonly GatingSegment = 'gating'
    private static readonly WithdrawnSegment = 'withdrawn'
    private static readonly VersionKey = 'version'
    private static readonly ReasonKey = 'reason'
    private static readonly EmailKey = 'email'
    private static readonly PasswordKey = 'password'
    private static readonly RoleKey = 'role'
    private static readonly DisabledKey = 'disabled'
    private static readonly ActivityRoute = '/api/activity'
    private static readonly ObservationsSegment = 'observations'
    private static readonly LedgerSegment = 'ledger'
    private static readonly BootstrapSegment = 'bootstrap'
    private static readonly RolloutRegistrationSegment = 'rollout-registration'
    private static readonly AgentInstallSegment = 'agent-install'
    private static readonly ConsoleSegment = 'console'
    private static readonly ConsoleInstallSegment = 'console-install'
    private static readonly ForceQuery = '?force=true'
    private static readonly OwnerPasswordSegment = 'owner-password'
    private static readonly EmailDomainsSegment = 'email-domains'
    private static readonly ApproveSegment = 'approve'
    private static readonly RevokeSegment = 'revoke'
    private static readonly VerifySegment = 'verify'
    private static readonly DomainsKey = 'domains'
    private static readonly DomainKey = 'domain'
    private static readonly NoQuery = ''
    private static readonly LimitParam = 'limit'
    private static readonly PoliciesRoute = '/api/policies'
    private static readonly PolicySegment = 'policy'
    private static readonly ChannelsSegment = 'channels'
    private static readonly MinVersionSegment = 'min-version'
    private static readonly HoldSegment = 'hold'
    private static readonly ChannelsKey = 'channels'
    private static readonly ChangedType = 'environments-changed'
    private static readonly ReconnectDelayMs = 2000
    private static readonly QueryStart = '?'
    private static readonly QueryAssign = '='

    private readonly handlers: Array<() => void> = []
    private readonly sockets: IEventSocketFactory
    private socket: IEventSocket | undefined
    private connecting = false

    public constructor(sockets: IEventSocketFactory = new BrowserEventSockets(), fetcher?: FetchFunction)
    {
        super(PlatformShell.Config, fetcher)
        this.sockets = sockets
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return await this.Get<EnvironmentDto[]>(ControlPlaneClient.EnvironmentsRoute)
    }

    public async ListClients(): Promise<ClientDto[]>
    {
        return await this.Get<ClientDto[]>(ControlPlaneClient.ClientsRoute)
    }

    public async CreateClient(id: string, displayName: string, subscriptionRef?: string): Promise<ClientDto>
    {
        const body: Record<string, unknown> = { id, displayName }
        if (subscriptionRef !== undefined)
        {
            body.subscriptionRef = subscriptionRef
        }
        return await this.Post<ClientDto>(ControlPlaneClient.ClientsRoute, body)
    }

    public async DeleteClient(id: string): Promise<void>
    {
        await this.Delete<unknown>(this.ItemRoute(ControlPlaneClient.ClientsRoute, id))
    }

    // No server-side parent filter exists; filters the full list by clientId when given.
    public async ListTenants(clientId?: string): Promise<TenantDto[]>
    {
        const all = await this.Get<TenantDto[]>(ControlPlaneClient.TenantsRoute)
        return clientId === undefined ? all : all.filter(t => t.clientId === clientId)
    }

    public async CreateTenant(id: string, clientId: string, displayName: string, ownerEmail: string): Promise<CreatedTenantDto>
    {
        return await this.Post<CreatedTenantDto>(ControlPlaneClient.TenantsRoute, { id, clientId, displayName, ownerEmail })
    }

    public async DeleteTenant(id: string): Promise<void>
    {
        await this.Delete<unknown>(this.ItemRoute(ControlPlaneClient.TenantsRoute, id))
    }

    // Sets a fresh Owner password in the tenant's IdP (the old one stops working at once); the reply is the only copy.
    public async ResetOwnerPassword(tenantId: string): Promise<OwnerPasswordResetDto>
    {
        const route = this.ItemRoute(ControlPlaneClient.TenantsRoute, tenantId) + ControlPlaneClient.PathSeparator + ControlPlaneClient.OwnerPasswordSegment
        return await this.Post<OwnerPasswordResetDto>(route)
    }

    // The tenant's email domains: where they come from, whether they are editable here, who else claims them and, for an
    // in-hive tenant, each reported domain's approval. A 404 for an unknown tenant (or a control plane without the route).
    public async GetTenantEmailDomains(tenantId: string): Promise<TenantEmailDomainsDto>
    {
        return await this.Get<TenantEmailDomainsDto>(this.TenantEmailDomainsRoute(tenantId))
    }

    // Replaces a control-plane tenant's email domains; the reply is the fresh report. A refused domain is a 400 with a
    // plain sentence; an in-hive tenant (its Owner sets them in its console) is a 409.
    public async SetTenantEmailDomains(tenantId: string, domains: readonly string[]): Promise<TenantEmailDomainsDto>
    {
        return await this.Put<TenantEmailDomainsDto>(this.TenantEmailDomainsRoute(tenantId), { [ControlPlaneClient.DomainsKey]: domains })
    }

    // Approves one domain an in-hive tenant's console reports, so discovery matches it; the reply is the fresh report.
    public async ApproveTenantEmailDomain(tenantId: string, domain: string): Promise<TenantEmailDomainsDto>
    {
        return await this.Post<TenantEmailDomainsDto>(this.TenantEmailDomainActionRoute(tenantId, ControlPlaneClient.ApproveSegment), { [ControlPlaneClient.DomainKey]: domain })
    }

    // Withdraws one domain's approval; the reply is the fresh report.
    public async RevokeTenantEmailDomain(tenantId: string, domain: string): Promise<TenantEmailDomainsDto>
    {
        return await this.Post<TenantEmailDomainsDto>(this.TenantEmailDomainActionRoute(tenantId, ControlPlaneClient.RevokeSegment), { [ControlPlaneClient.DomainKey]: domain })
    }

    // Looks up the domain's DNS TXT record now; the reply is the fresh report. A 429 (too many lookups) or 503 (the lookup
    // failed) carries the server's sentence.
    public async VerifyTenantEmailDomain(tenantId: string, domain: string): Promise<TenantEmailDomainsDto>
    {
        return await this.Post<TenantEmailDomainsDto>(this.TenantEmailDomainActionRoute(tenantId, ControlPlaneClient.VerifySegment), { [ControlPlaneClient.DomainKey]: domain })
    }

    private TenantEmailDomainsRoute(tenantId: string): string
    {
        return this.ItemRoute(ControlPlaneClient.TenantsRoute, tenantId) + ControlPlaneClient.PathSeparator + ControlPlaneClient.EmailDomainsSegment
    }

    private TenantEmailDomainActionRoute(tenantId: string, action: string): string
    {
        return this.TenantEmailDomainsRoute(tenantId) + ControlPlaneClient.PathSeparator + action
    }

    // No server-side parent filter exists; filters the full list by tenantId when given.
    public async ListHives(tenantId?: string): Promise<HiveDto[]>
    {
        const all = await this.Get<HiveDto[]>(ControlPlaneClient.HivesRoute)
        return tenantId === undefined ? all : all.filter(h => h.tenantId === tenantId)
    }

    public async ListFleet(): Promise<FleetHiveDto[]>
    {
        return await this.Get<FleetHiveDto[]>(ControlPlaneClient.FleetRoute)
    }

    public async ListManifests(): Promise<ManifestDto[]>
    {
        return await this.Get<ManifestDto[]>(ControlPlaneClient.ManifestsRoute)
    }

    public async ListOperators(): Promise<OperatorSummaryDto[]>
    {
        return await this.Get<OperatorSummaryDto[]>(ControlPlaneClient.OperatorsRoute)
    }

    public async CreateOperator(email: string, password: string, role: string): Promise<void>
    {
        const body = { [ControlPlaneClient.EmailKey]: email, [ControlPlaneClient.PasswordKey]: password, [ControlPlaneClient.RoleKey]: role }
        await this.Post<unknown>(ControlPlaneClient.OperatorsRoute, body)
    }

    public async SetOperatorRole(email: string, role: string): Promise<void>
    {
        await this.Post<unknown>(ControlPlaneClient.OperatorRoleRoute, { [ControlPlaneClient.EmailKey]: email, [ControlPlaneClient.RoleKey]: role })
    }

    public async ResetOperatorPassword(email: string): Promise<{ password: string }>
    {
        return await this.Post<{ password: string }>(ControlPlaneClient.OperatorPasswordResetRoute, { [ControlPlaneClient.EmailKey]: email })
    }

    public async SetOperatorDisabled(email: string, disabled: boolean): Promise<void>
    {
        await this.Post<unknown>(ControlPlaneClient.OperatorDisabledRoute, { [ControlPlaneClient.EmailKey]: email, [ControlPlaneClient.DisabledKey]: disabled })
    }

    public async RevokeOperatorSessions(email: string): Promise<void>
    {
        await this.Post<unknown>(ControlPlaneClient.OperatorRevokeSessionsRoute, { [ControlPlaneClient.EmailKey]: email })
    }

    public async ListGating(): Promise<GatingDto[]>
    {
        return await this.Get<GatingDto[]>(ControlPlaneClient.GatingRoute)
    }

    public async ListSelections(): Promise<SelectionDto[]>
    {
        return await this.Get<SelectionDto[]>(ControlPlaneClient.SelectionsRoute)
    }

    public async ListRollouts(): Promise<HiveRolloutDto[]>
    {
        return await this.Get<HiveRolloutDto[]>(ControlPlaneClient.RolloutsRoute)
    }

    public async CreateHive(input: HiveDto): Promise<HiveDto>
    {
        return await this.Post<HiveDto>(ControlPlaneClient.HivesRoute, input)
    }

    public async Provision(input: ProvisionInputDto): Promise<ProvisionResultDto>
    {
        return await this.Post<ProvisionResultDto>(ControlPlaneClient.ProvisionRoute, input)
    }

    // Deletes a hive (its agent is removed from a cluster the control plane drives, its token revoked). With force
    // (delete anyway) the agent's removal is skipped: for a cluster that is unreachable or gone.
    public async DeleteHive(id: string, force: boolean = false): Promise<HiveDeleteOutcomeDto>
    {
        const route = this.ItemRoute(ControlPlaneClient.HivesRoute, id) + (force ? ControlPlaneClient.ForceQuery : ControlPlaneClient.NoQuery)
        return await this.Delete<HiveDeleteOutcomeDto>(route)
    }

    // Imports every new release from the registry (Full operators only). A 409 (no registry configured) or 502 (the
    // registry is unavailable) carries the server's sentence.
    public async RefreshReleases(): Promise<ReleaseRefreshDto>
    {
        return await this.Post<ReleaseRefreshDto>(ControlPlaneClient.ReleasesRefreshRoute)
    }

    public async Gate(tenantId: string, version: string): Promise<void>
    {
        await this.Post<unknown>(this.TenantGatingRoute(tenantId), { [ControlPlaneClient.VersionKey]: version })
    }

    public async Ungate(tenantId: string, version: string): Promise<void>
    {
        await this.Delete<unknown>(this.TenantGatingItemRoute(tenantId, version))
    }

    public async SetManifestWithdrawn(version: string, withdraw: boolean, reason?: string): Promise<ManifestDto>
    {
        if (!withdraw)
        {
            return await this.Delete<ManifestDto>(this.ManifestWithdrawnRoute(version))
        }
        return await this.Post<ManifestDto>(this.ManifestWithdrawnRoute(version), { [ControlPlaneClient.ReasonKey]: reason })
    }

    private ManifestWithdrawnRoute(version: string): string
    {
        return this.ItemRoute(ControlPlaneClient.ManifestsRoute, version) + ControlPlaneClient.PathSeparator + ControlPlaneClient.WithdrawnSegment
    }

    private TenantPolicyRoute(tenantId: string, action: string): string
    {
        return this.ItemRoute(ControlPlaneClient.TenantsRoute, tenantId) + ControlPlaneClient.PathSeparator + ControlPlaneClient.PolicySegment + ControlPlaneClient.PathSeparator + action
    }

    public async ListActivity(limit?: number): Promise<ActivityDto[]>
    {
        return await this.Get<ActivityDto[]>(this.WithLimit(ControlPlaneClient.ActivityRoute, limit))
    }

    public async ListHiveObservations(hiveId: string, limit?: number): Promise<ObservationDto[]>
    {
        return await this.Get<ObservationDto[]>(this.WithLimit(this.HiveSubRoute(hiveId, ControlPlaneClient.ObservationsSegment), limit))
    }

    public async ListHiveLedger(hiveId: string, limit?: number): Promise<LedgerDto[]>
    {
        return await this.Get<LedgerDto[]>(this.WithLimit(this.HiveSubRoute(hiveId, ControlPlaneClient.LedgerSegment), limit))
    }

    // The hive agent's secret-free install bundle; 409 while the control plane's agent channel is off.
    public async GetHiveBootstrap(hiveId: string): Promise<HiveBootstrapDto>
    {
        return await this.Get<HiveBootstrapDto>(this.HiveSubRoute(hiveId, ControlPlaneClient.BootstrapSegment))
    }

    // Mints a new one-time agent token, replacing the old one at once; the reply is the only copy.
    public async ReissueAgentToken(hiveId: string): Promise<string>
    {
        const reply = await this.Post<RolloutRegistrationDto>(this.HiveSubRoute(hiveId, ControlPlaneClient.RolloutRegistrationSegment))
        return reply.token
    }

    // Starts the control plane's automatic agent install for a Local hive; the reply is its first status (never a token).
    public async StartAgentInstall(hiveId: string): Promise<AgentInstallStatusDto>
    {
        return await this.Post<AgentInstallStatusDto>(this.HiveSubRoute(hiveId, ControlPlaneClient.AgentInstallSegment))
    }

    // The hive's latest automatic install status; null when none has run since the control plane started.
    public async GetAgentInstall(hiveId: string): Promise<AgentInstallStatusDto | null>
    {
        try
        {
            return await this.Get<AgentInstallStatusDto>(this.HiveSubRoute(hiveId, ControlPlaneClient.AgentInstallSegment))
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.NotFoundStatus)
            {
                return null
            }
            throw e
        }
    }

    // Stores where the hive serves its tenant's console (host and TLS); the reply is the updated hive. A setting the
    // control plane refuses is a 400 with a plain sentence; a running hive operation is a 409.
    public async SetHiveConsole(hiveId: string, spec: HiveConsoleSpecDto): Promise<HiveDto>
    {
        return await this.Put<HiveDto>(this.HiveSubRoute(hiveId, ControlPlaneClient.ConsoleSegment), spec)
    }

    // Removes the console from a cluster the control plane drives, then clears its settings; the reply is the updated
    // hive and what stayed in the cluster. A cluster that refuses the removal is a 409 and the settings stay.
    public async RemoveHiveConsole(hiveId: string): Promise<ConsoleRemovalDto>
    {
        return await this.Delete<ConsoleRemovalDto>(this.HiveSubRoute(hiveId, ControlPlaneClient.ConsoleSegment))
    }

    // Starts the control plane's console install for the hive; the reply is its first status (never a secret).
    public async StartConsoleInstall(hiveId: string): Promise<ConsoleInstallStatusDto>
    {
        return await this.Post<ConsoleInstallStatusDto>(this.HiveSubRoute(hiveId, ControlPlaneClient.ConsoleInstallSegment))
    }

    // The hive's latest console install status; null when none has run since the control plane started.
    public async GetConsoleInstall(hiveId: string): Promise<ConsoleInstallStatusDto | null>
    {
        try
        {
            return await this.Get<ConsoleInstallStatusDto>(this.HiveSubRoute(hiveId, ControlPlaneClient.ConsoleInstallSegment))
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.NotFoundStatus)
            {
                return null
            }
            throw e
        }
    }

    // Sets a fresh Owner password in the hive's in-hive identity provider; the reply is the only copy. A 503 when that
    // identity provider cannot be reached.
    public async ResetInHiveOwnerPassword(hiveId: string): Promise<InHiveOwnerPasswordDto>
    {
        const route = this.HiveSubRoute(hiveId, ControlPlaneClient.ConsoleSegment) + ControlPlaneClient.PathSeparator + ControlPlaneClient.OwnerPasswordSegment
        return await this.Post<InHiveOwnerPasswordDto>(route)
    }

    private HivePolicyRoute(hiveId: string, segment: string): string
    {
        return this.HiveSubRoute(hiveId, ControlPlaneClient.PolicySegment) + ControlPlaneClient.PathSeparator + segment
    }

    public async SetHiveChannels(hiveId: string, channels: string[]): Promise<PolicyDto>
    {
        return await this.Put<PolicyDto>(this.HivePolicyRoute(hiveId, ControlPlaneClient.ChannelsSegment), { [ControlPlaneClient.ChannelsKey]: channels })
    }

    public async SetHiveMinVersion(hiveId: string, version: string): Promise<PolicyDto>
    {
        return await this.Put<PolicyDto>(this.HivePolicyRoute(hiveId, ControlPlaneClient.MinVersionSegment), { [ControlPlaneClient.VersionKey]: version })
    }

    public async ClearHiveMinVersion(hiveId: string): Promise<PolicyDto>
    {
        return await this.Delete<PolicyDto>(this.HivePolicyRoute(hiveId, ControlPlaneClient.MinVersionSegment))
    }

    public async SetHiveHold(hiveId: string, reason: string): Promise<PolicyDto>
    {
        return await this.Post<PolicyDto>(this.HivePolicyRoute(hiveId, ControlPlaneClient.HoldSegment), { [ControlPlaneClient.ReasonKey]: reason })
    }

    public async ClearHiveHold(hiveId: string): Promise<PolicyDto>
    {
        return await this.Delete<PolicyDto>(this.HivePolicyRoute(hiveId, ControlPlaneClient.HoldSegment))
    }

    private HiveSubRoute(hiveId: string, segment: string): string
    {
        return this.ItemRoute(ControlPlaneClient.HivesRoute, hiveId) + ControlPlaneClient.PathSeparator + segment
    }

    private WithLimit(route: string, limit?: number): string
    {
        return limit === undefined ? route : route + ControlPlaneClient.QueryStart + ControlPlaneClient.LimitParam + ControlPlaneClient.QueryAssign + String(limit)
    }

    public async ListPolicies(): Promise<PolicyDto[]>
    {
        return await this.Get<PolicyDto[]>(ControlPlaneClient.PoliciesRoute)
    }

    public async SetTenantChannels(tenantId: string, channels: string[]): Promise<PolicyDto>
    {
        return await this.Put<PolicyDto>(this.TenantPolicyRoute(tenantId, ControlPlaneClient.ChannelsSegment), { [ControlPlaneClient.ChannelsKey]: channels })
    }

    public async SetTenantMinVersion(tenantId: string, version: string): Promise<PolicyDto>
    {
        return await this.Put<PolicyDto>(this.TenantPolicyRoute(tenantId, ControlPlaneClient.MinVersionSegment), { [ControlPlaneClient.VersionKey]: version })
    }

    public async ClearTenantMinVersion(tenantId: string): Promise<PolicyDto>
    {
        return await this.Delete<PolicyDto>(this.TenantPolicyRoute(tenantId, ControlPlaneClient.MinVersionSegment))
    }

    public async SetTenantHold(tenantId: string, reason: string): Promise<PolicyDto>
    {
        return await this.Post<PolicyDto>(this.TenantPolicyRoute(tenantId, ControlPlaneClient.HoldSegment), { [ControlPlaneClient.ReasonKey]: reason })
    }

    public async ClearTenantHold(tenantId: string): Promise<PolicyDto>
    {
        return await this.Delete<PolicyDto>(this.TenantPolicyRoute(tenantId, ControlPlaneClient.HoldSegment))
    }

    private TenantGatingRoute(tenantId: string): string
    {
        return this.ItemRoute(ControlPlaneClient.TenantsRoute, tenantId) + ControlPlaneClient.PathSeparator + ControlPlaneClient.GatingSegment
    }

    private TenantGatingItemRoute(tenantId: string, version: string): string
    {
        return this.TenantGatingRoute(tenantId) + ControlPlaneClient.PathSeparator + encodeURIComponent(version)
    }

    private ItemRoute(collection: string, id: string): string
    {
        return collection + ControlPlaneClient.PathSeparator + encodeURIComponent(id)
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

    // Mints a single-use ticket (POST /api/ws-ticket), then opens the socket with it as the lone subprotocol; no ticket,
    // no socket (retried via the reconnect delay, except after a 401: the session is gone and the page reloads).
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
            ticket = await this.MintWsTicket()
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
        const socket = this.sockets.Open(this.SocketUrl(ControlPlaneClient.EventsRoute, this.sockets.Location), ticket)
        socket.OnMessage(data => { this.OnMessage(data) })
        socket.OnClose(() => { this.OnClosed(socket) })
        this.socket = socket
    }

    // Reopens the socket after a delay; skipped if Dispose() ran or the socket was already replaced.
    private OnClosed(closed: IEventSocket): void
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
        this.socket?.Close()
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
        return await this.Get<GraphDto[]>(this.GraphsRoute(envName))
    }

    public async CreateGraph(envName: string, name: string, description: string): Promise<GraphDto>
    {
        return await this.Post<GraphDto>(this.GraphsRoute(envName), { name, description })
    }

    public async DeleteGraph(envName: string, graphName: string): Promise<void>
    {
        await this.Delete<unknown>(this.GraphsRoute(envName) + ControlPlaneClient.PathSeparator + encodeURIComponent(graphName))
    }

    // Promotes a development graph into a runtime environment.
    public async PromoteGraph(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
    {
        return await this.Post<PromotionResultDto>(this.PromoteRoute(sourceEnv, graphName), { targetEnv })
    }

    // The runtime's loaded graph; null when none has been promoted.
    public async GetLoadedGraph(runtimeEnv: string): Promise<GraphLoadedDto | null>
    {
        return await this.Get<GraphLoadedDto | null>(this.LoadedGraphRoute(runtimeEnv))
    }

    private EnvRoute(name: string): string
    {
        return ControlPlaneClient.EnvironmentsRoute + ControlPlaneClient.PathSeparator + encodeURIComponent(name)
    }
}
