import { existsSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import {
    AppHost,
    AppHostConfig,
    AuditTrail,
    HostAllowList,
    MuralBundle,
    OidcLoginEndpoint,
    RouteAuth,
    RouteTable,
    UpgradeRefusal,
    WsTicketEndpoint,
    type AppHostConfigOptions,
    type IAuditRepository,
    type SessionRecord,
    type SocketContext,
} from '@pragmatic-tech-ai/pragmatic-app-host'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ConsoleRegistration, ConsoleRegistrationState } from './console-registration.js'
import type { IEnvironmentService } from './control-plane-host.js'
import { EnvironmentChangeKind } from './environment-record.js'
import { DesktopEndpoint } from './tenant-auth/desktop-endpoint.js'
import { DesktopRelay } from './tenant-auth/desktop-relay.js'
import type { IPrincipalConnections } from './tenant-auth/tenant-principal-sessions.js'
import type { TenantHostResolver } from './tenant-auth/tenant-host-resolver.js'
import type { TenantPlane } from './tenant-auth/tenant-plane.js'
import { TenantSessionClaims, TenantSessions, type TenantSession } from './tenant-auth/tenant-sessions.js'
import { TenantEventType } from './tenant-api/tenant-events.js'
import { TenantLogSocket } from './tenant-api/tenant-log-socket.js'
import { TenantConsoleProblems } from './tenant-console-problems.js'
import type { TenantHealthMonitor } from './tenant-health-monitor.js'

/**
 * The tenant console's Host guard: a request is admitted on a known tenant's host (TenantHostResolver: a tenant subdomain
 * or the console's own alias), or on any host for the Host-independent Plexus desktop surface (`/desktop/*`, bearer
 * authenticated, never cookies: Plexus dials loopback or the console's address). Everything else is 403 before routing.
 */
export class TenantHostAllowList extends HostAllowList
{
    private static readonly TenantHostHeader = 'host'
    private static readonly PathBaseUrl = 'http://localhost'
    private static readonly PathRoot = '/'

    public constructor(private readonly resolver: TenantHostResolver)
    {
        super([])
    }

    public override Allows(req: IncomingMessage): boolean
    {
        if (TenantHostAllowList.PathOf(req).startsWith(DesktopEndpoint.Prefix))
        {
            return true
        }
        return this.resolver.Accepts(req.headers[TenantHostAllowList.TenantHostHeader] as string | undefined)
    }

    private static PathOf(req: IncomingMessage): string
    {
        try
        {
            return new URL(req.url ?? TenantHostAllowList.PathRoot, TenantHostAllowList.PathBaseUrl).pathname
        }
        catch
        {
            return TenantHostAllowList.PathRoot
        }
    }
}

/** The tenant console's host settings: AppHostConfig with the tenant Host guard in place of a fixed list. */
class TenantAppHostConfig extends AppHostConfig
{
    public override readonly AllowedHosts: HostAllowList

    public constructor(options: AppHostConfigOptions, allowed: HostAllowList)
    {
        super(options)
        this.AllowedHosts = allowed
    }
}

/** What the tenant console's host is composed of. */
export interface TenantConsoleHostOptions
{
    readonly Plane: TenantPlane
    readonly Resolver: TenantHostResolver
    readonly Service: IEnvironmentService
    /** The tenant portal bundle (MuralBundle); a folder without an index.html serves no UI (non-API paths are 404). */
    readonly PortalRoot?: string
    readonly Monitor?: TenantHealthMonitor
    /** The in-hive console's registration with the platform; absent (the platform's tenant plane), nothing is refused. */
    readonly Registration?: ConsoleRegistration
    /** The audit trail of the console's routes; without it nothing is audited. */
    readonly Audit?: IAuditRepository
    /** Behind a trusted reverse proxy: the last x-forwarded-for / x-forwarded-proto hop is honoured. */
    readonly TrustedProxy?: boolean
}

/** A tracked tenant socket: its teardown, the principal it serves, and the session it was opened under. */
type TrackedSocket = { teardown: () => void; tenantId: string; principalId: string; sessionId: string }

/**
 * The tenant admin console's HTTP server: a pragmatic-app-host AppHost (health, the tenant Host guard, body type, Origin,
 * authentication, authorization, route, the tenant portal bundle) with the console's declared routes: the OIDC sign-in of
 * the host's tenant (`/tenant-auth/oidc/begin|callback`, `/tenant-auth/session`, `/tenant-auth/logout`), the tenant API
 * (`/tenant-api/*`, authorized by role claims), the socket tickets (`POST /tenant-api/ws-ticket`), the event and log
 * sockets (ticketed), and the Host-independent Plexus desktop surface (`/desktop/*`) with its relay. There is no operator
 * route, so the operator plane is structurally unreachable here. Every authorized mutation is audited once through the
 * AuditTrail.
 *
 * On the in-hive console a `ConsoleRegistration` gates the desktop surface: while the platform refuses the console, every
 * `/desktop/*` route except the `/desktop/console` lookup answers 503 with `ConsoleRegistration.RefusedBody`, the relay
 * upgrade is refused 503 with that body before the relay is asked, and becoming Refused closes the open relays with 4003
 * (`DesktopRelay.ConsoleRetiredCloseCode`). No session is touched: Registered again, the same bearer works.
 */
export class TenantConsoleHost implements IPrincipalConnections
{
    /** The data API prefix: an unknown `/tenant-api/` path is a JSON 404, never the portal. */
    public static readonly ApiPrefix = '/tenant-api/'
    public static readonly AuthPrefix = '/tenant-auth/'
    public static readonly BeginPath = '/tenant-auth/oidc/begin'
    public static readonly CallbackPath = '/tenant-auth/oidc/callback'
    public static readonly SessionPath = '/tenant-auth/session'
    public static readonly LogoutPath = '/tenant-auth/logout'
    public static readonly TicketPath = '/tenant-api/ws-ticket'
    public static readonly EventsPath = '/tenant-api/events'
    public static readonly LogsStreamPath = '/tenant-api/environments/:name/logs/stream'
    private static readonly NameParam = 'name'
    private static readonly IndexFile = 'index.html'
    private static readonly HostHeader = 'host'
    private static readonly NotListeningMessage = 'TenantConsoleHost is not listening'
    private static readonly CloseEvent = 'close'
    private static readonly ErrorEvent = 'error'
    private static readonly StatusUnavailable = 503
    private static readonly NoRelayMessage = 'This console has no desktop relay.'
    private static readonly PolicyViolation = 1008
    /** Request bodies are small JSON objects: 4 KiB unless a route declares more. */
    private static readonly MaxBodyBytes = 4096
    private static readonly MaxAuditTargetLength = 256

    private appHost: AppHost | undefined
    private readonly changeSubscription: () => void
    /** The registration's Changed subscription (retires / reinstates the relay); undefined without a registration. */
    private readonly registrationSubscription: IDisposable | undefined
    /** Tenant ws sockets mapped to their teardown (events: unsubscribe; logs: kill the stream). Close() runs each. */
    private readonly clients = new Map<WebSocket, TrackedSocket>()

    public constructor(private readonly options: TenantConsoleHostOptions)
    {
        const plane = options.Plane
        // An Owner reset closes the principal's sockets on this listener and its relays.
        plane.principals.Attach(this)
        if (plane.relay !== undefined)
        {
            plane.principals.Attach(plane.relay)
        }
        // Route every environment lifecycle change to the tenant bus, scoped by the env's owning tenant. An unbound env
        // (no tenantId) has no tenant audience, so it is skipped.
        this.changeSubscription = options.Service.OnChanged(change =>
        {
            const rec = change.record
            if (rec.tenantId !== undefined)
            {
                plane.events.Emit(rec.tenantId, { type: TenantConsoleHost.TenantEventFor(change.kind), environmentName: rec.name })
            }
        })
        // A console that opens Refused retires its relay at once; each change retires or reinstates it.
        this.registrationSubscription = options.Registration?.Changed.subscribe(state => this.ApplyRegistration(state))
        if (options.Registration?.IsRefused === true)
        {
            this.ApplyRegistration(ConsoleRegistrationState.Refused)
        }
    }

    /** Maps an environment lifecycle-change kind to the tenant event type fanned out over the tenant bus. */
    private static TenantEventFor(kind: EnvironmentChangeKind): TenantEventType
    {
        switch (kind)
        {
            case EnvironmentChangeKind.Created:
                return TenantEventType.EnvironmentCreated
            case EnvironmentChangeKind.Deleted:
                return TenantEventType.EnvironmentDeleted
            default:
                return TenantEventType.EnvironmentChanged
        }
    }

    /** Refused closes the open relays with 4003 and keeps new ones from staying open; Registered lifts that. */
    private ApplyRegistration(state: ConsoleRegistrationState): void
    {
        if (state === ConsoleRegistrationState.Refused)
        {
            this.options.Plane.relay?.Retire(DesktopRelay.ConsoleRetiredCloseCode)
            return
        }
        this.options.Plane.relay?.Reinstate()
    }

    public async Listen(port: number, host: string): Promise<void>
    {
        const o = this.options
        const plane = o.Plane
        const appHost = new AppHost(new TenantAppHostConfig({
            TrustedProxy: o.TrustedProxy ?? false,
            ApiPrefix: TenantConsoleHost.ApiPrefix,
            DefaultBodyLimit: TenantConsoleHost.MaxBodyBytes,
            AuditActorClaim: TenantSessionClaims.EmailClaim,
        }, new TenantHostAllowList(o.Resolver)), {
            Routes: this.Routes(),
            Sessions: plane.gate,
            Audit: o.Audit === undefined ? undefined : new AuditTrail(o.Audit, { MaxTargetLength: TenantConsoleHost.MaxAuditTargetLength }),
            Bundle: this.Bundle(),
            Problems: new TenantConsoleProblems(),
            DenialLimiter: plane.sessions.Denials,
            Tickets: plane.sessions.Tickets,
        })
        await appHost.Listen(port, host)
        this.appHost = appHost
        o.Monitor?.Start()
    }

    public async Close(): Promise<void>
    {
        this.options.Monitor?.Stop()
        this.changeSubscription()
        this.registrationSubscription?.dispose()
        for (const [ws, tracked] of this.clients)
        {
            tracked.teardown()
            ws.terminate()
        }
        this.clients.clear()
        const appHost = this.appHost
        this.appHost = undefined
        try
        {
            // AppHost.Close resolves only once no audit write is still running.
            await appHost?.Close()
        }
        finally
        {
            // After the listener has closed, so a refusal audited while it closed is among the writes the relay waits for.
            await this.options.Plane.relay?.Close()
        }
    }

    public Address(): { address: string; port: number }
    {
        if (this.appHost === undefined)
        {
            throw new Error(TenantConsoleHost.NotListeningMessage)
        }
        return this.appHost.Address()
    }

    /** The portal bundle, when its folder holds a built index.html. */
    private Bundle(): MuralBundle | undefined
    {
        const root = this.options.PortalRoot
        return root !== undefined && existsSync(join(root, TenantConsoleHost.IndexFile)) ? MuralBundle.Load(root) : undefined
    }

    /**
     * The console's routes: the OIDC sign-in, session and logout (public), the socket tickets, the tenant API (by role),
     * the desktop surface (public; bearer-authenticated by its own gate) and the two ticketed tenant sockets.
     */
    public Routes(): RouteTable
    {
        const C = TenantConsoleHost
        const plane = this.options.Plane
        const table = new RouteTable()
        new OidcLoginEndpoint(plane.relyingParty, plane.clients, plane.gate, {
            BeginPath: C.BeginPath,
            CallbackPath: C.CallbackPath,
            Policy: TenantSessions.ConsolePolicy,
            SessionPaths: { Session: C.SessionPath, Logout: C.LogoutPath },
        }).Register(table)
        new WsTicketEndpoint(plane.sessions.Tickets).Register(table, C.TicketPath)
        plane.api.Register(table)
        plane.configuration?.Register(table)
        plane.desktop?.Register(table, this.options.Registration)
        table.AddSocket({ Pattern: C.EventsPath, Auth: RouteAuth.Session, Handler: (ws, ctx) => this.AdmitEvents(ws, ctx) })
        table.AddSocket({ Pattern: C.LogsStreamPath, Auth: RouteAuth.Session, Handler: (ws, ctx) => this.AdmitLogs(ws, ctx) })
        // Public on the host: the relay authenticates the desktop bearer itself and answers its own refusals before the handshake.
        table.AddSocket({ Pattern: DesktopRelay.Path, Auth: RouteAuth.Public, Admit: req => this.AdmitRelay(req), Handler: (ws, ctx) => this.AttachRelay(ws, ctx) })
        return table
    }

    /**
     * The relay upgrade's admission: refused 503 while the console is refused, else the relay's own. Without a relay the
     * upgrade is destroyed (the seam's contract for a throwing admission).
     */
    private async AdmitRelay(req: IncomingMessage): Promise<UpgradeRefusal | null>
    {
        // Refused before the relay is asked (and even when the console has none), so this answer is not audited: nothing is
        // leased, minted or dialed.
        if (this.options.Registration?.IsRefused === true)
        {
            return new UpgradeRefusal(TenantConsoleHost.StatusUnavailable, ConsoleRegistration.RefusedBody)
        }
        const relay = this.options.Plane.relay
        if (relay === undefined)
        {
            throw new Error(TenantConsoleHost.NoRelayMessage)
        }
        return await relay.Admit(req)
    }

    /** The admitted relay's client socket joins the pipe its admission opened. */
    private AttachRelay(ws: WebSocket, ctx: SocketContext): void
    {
        const relay = this.options.Plane.relay
        if (relay === undefined)
        {
            ws.close(TenantConsoleHost.PolicyViolation)
            return
        }
        relay.Attach(ws, ctx.Request)
    }

    /**
     * The session a ticketed tenant socket runs under: the ticket's session must be a live console session of the tenant
     * the upgrade's host answers for (roles refreshed); otherwise the socket closes with a policy violation.
     */
    private async SocketSession(ws: WebSocket, ctx: SocketContext): Promise<TenantSession | undefined>
    {
        const tenantId = this.options.Resolver.TenantFor(ctx.Request.headers[TenantConsoleHost.HostHeader] as string | undefined)
        const record: SessionRecord | null = ctx.Session === null || tenantId === undefined ? null : await this.options.Plane.gate.ById(ctx.Session.Id, tenantId)
        const view = record === null ? undefined : TenantSessionClaims.ViewOf(record)
        if (view === undefined)
        {
            ws.close(TenantConsoleHost.PolicyViolation)
            return undefined
        }
        return view
    }

    /** The tenant events socket: subscribes the bus for the session's tenant and forwards each event as JSON. */
    private AdmitEvents(ws: WebSocket, ctx: SocketContext): void
    {
        void this.SocketSession(ws, ctx).then(session =>
        {
            if (session === undefined)
            {
                return
            }
            const unsubscribe = this.options.Plane.events.On(session.tenantId, ev =>
            {
                if (ws.readyState === WebSocket.OPEN)
                {
                    ws.send(JSON.stringify(ev))
                }
            })
            this.Track(ws, unsubscribe, session)
        }, () => ws.terminate())
    }

    /** The tenant log-stream socket: TenantLogSocket enforces environment ownership and streams. */
    private AdmitLogs(ws: WebSocket, ctx: SocketContext): void
    {
        const name = ctx.Params.get(TenantConsoleHost.NameParam) as string
        void this.SocketSession(ws, ctx).then(session =>
        {
            if (session === undefined)
            {
                return
            }
            const logSocket = new TenantLogSocket(session, name, this.options.Service)
            if (!logSocket.Attach(ws))
            {
                // Not the session tenant's env (or unknown): the socket is already closed and no stream started.
                return
            }
            this.Track(ws, () => logSocket.Dispose(), session)
        }, () => ws.terminate())
    }

    /** Closes the principal's open tenant sockets in the tenant (an Owner reset ended its sessions); returns how many. */
    public ClosePrincipal(tenantId: string, principalId: string): number
    {
        let closed = 0
        for (const [ws, tracked] of [...this.clients])
        {
            if (tracked.tenantId === tenantId && tracked.principalId === principalId)
            {
                this.Remove(ws)
                ws.terminate()
                closed++
            }
        }
        return closed
    }

    /** Closes every open tenant socket of the tenant, any principal (the tenant was deleted); returns how many. */
    public CloseTenant(tenantId: string): number
    {
        let closed = 0
        for (const [ws, tracked] of [...this.clients])
        {
            if (tracked.tenantId === tenantId)
            {
                this.Remove(ws)
                ws.terminate()
                closed++
            }
        }
        return closed
    }

    /**
     * Records a tenant socket with its teardown and owner, and wires close/error to run that teardown and drop the entry.
     * The session is then re-checked once: a socket admitted just before its session was ended (a reset that ran between
     * the upgrade's check and this tracking, so ClosePrincipal could not see it) is closed.
     */
    private Track(ws: WebSocket, teardown: () => void, session: TenantSession): void
    {
        this.clients.set(ws, { teardown, tenantId: session.tenantId, principalId: session.principalId, sessionId: session.id })
        ws.on(TenantConsoleHost.CloseEvent, () => this.Remove(ws))
        ws.on(TenantConsoleHost.ErrorEvent, () => this.Remove(ws))
        void this.Revalidate(ws)
    }

    /** Closes the tracked socket when its session is no longer valid. */
    private async Revalidate(ws: WebSocket): Promise<void>
    {
        const tracked = this.clients.get(ws)
        if (tracked === undefined)
        {
            return
        }
        let live: boolean
        try
        {
            live = await this.options.Plane.gate.IsLive(tracked.sessionId, tracked.tenantId)
        }
        catch
        {
            live = false
        }
        if (!live && this.clients.has(ws))
        {
            this.Remove(ws)
            ws.terminate()
        }
    }

    private Remove(ws: WebSocket): void
    {
        const tracked = this.clients.get(ws)
        if (tracked === undefined)
        {
            return
        }
        this.clients.delete(ws)
        tracked.teardown()
    }
}
