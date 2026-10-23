import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type { IEnvironmentService } from './control-plane-host.js'
import { EnvironmentChangeKind } from './environment-record.js'
import { PlaneHttp } from './plane-http.js'
import type { TenantAuthEndpoint } from './tenant-auth/tenant-auth-endpoint.js'
import type { TenantAuthGate } from './tenant-auth/tenant-auth-gate.js'
import type { ITenantApiEndpoint, TenantPlane } from './tenant-auth/tenant-plane.js'
import type { TenantHostResolver } from './tenant-auth/tenant-host-resolver.js'
import { TenantEventType, type TenantEventBus } from './tenant-api/tenant-events.js'
import { TenantLogSocket } from './tenant-api/tenant-log-socket.js'

/**
 * The dedicated tenant-admin listener: its own `http.Server` + `WebSocketServer`, serving ONLY the tenant surface
 * (`/tenant-auth/*`, `/tenant-api/*`, and the tenant portal bundle). There is no operator route here, so the
 * operator plane is structurally unreachable on this listener regardless of the request host. The tenant id and the
 * OIDC callback are derived per request from the request's subdomain host (`<tenantId>.<baseDomain>`) via the
 * `TenantHostResolver`; a host that is not a known tenant subdomain is refused (403) before any routing, on both
 * HTTP and ws.
 */
export class TenantPlaneHost
{
    private static readonly BaseUrl = 'http://localhost'
    private static readonly TenantAuthPrefix = '/tenant-auth/'
    private static readonly TenantApiPrefix = '/tenant-api/'
    private static readonly TenantEventsPath = '/tenant-api/events'
    private static readonly TenantLogsStreamPattern = new RegExp(
        '^' + TenantPlaneHost.TenantApiPrefix + 'environments/([^/]+)/logs/stream$')
    private static readonly StatusForbidden = 403
    private static readonly StatusUnauthorized = 401
    private static readonly StatusInternal = 500
    private static readonly ForbiddenHostMessage = 'Host not allowed'
    private static readonly BadOriginMessage = 'Origin not allowed'
    private static readonly UnauthenticatedMessage = 'Authentication required'
    private static readonly GenericError = 'Internal server error'
    private static readonly NotListeningMessage = 'TenantPlaneHost is not listening'
    private static readonly CloseEvent = 'close'
    private static readonly ErrorEvent = 'error'
    private static readonly LogPrefix = '[tenant-plane] request failed:'

    private readonly endpoint: TenantAuthEndpoint
    private readonly gate: TenantAuthGate
    private readonly api: ITenantApiEndpoint
    private readonly events: TenantEventBus
    private readonly tenantStaticRootAbs: string
    private readonly changeSubscription: () => void
    private httpServer: HttpServer | undefined
    private wsServer: WebSocketServer | undefined
    /** Tenant ws sockets mapped to their teardown (events: unsubscribe; logs: kill the stream). Close() runs each. */
    private readonly clients = new Map<WebSocket, () => void>()

    public constructor(
        plane: TenantPlane,
        private readonly resolver: TenantHostResolver,
        tenantStaticRoot: string,
        private readonly service: IEnvironmentService)
    {
        this.endpoint = plane.endpoint
        this.gate = plane.gate
        this.api = plane.api
        this.events = plane.events
        this.tenantStaticRootAbs = resolve(tenantStaticRoot)
        // RULING 5: route every environment lifecycle change to the tenant bus, scoped by the env's owning tenant.
        // An unbound env (no tenantId) has no tenant audience, so it is skipped.
        this.changeSubscription = this.service.OnChanged(change =>
        {
            const rec = change.record
            if (rec.tenantId !== undefined)
            {
                this.events.Emit(rec.tenantId, { type: TenantPlaneHost.TenantEventFor(change.kind), environmentName: rec.name })
            }
        })
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

    public Listen(port: number, host: string): Promise<void>
    {
        const wss = new WebSocketServer({ noServer: true })
        const server = createServer((req, res) =>
        {
            void this.Handle(req, res)
        })
        server.on('upgrade', (req, socket, head) =>
        {
            this.RouteUpgrade(req, socket, head, wss)
        })
        this.httpServer = server
        this.wsServer = wss
        return new Promise((res, rej) =>
        {
            server.once('error', rej)
            server.listen(port, host, () =>
            {
                server.off('error', rej)
                res()
            })
        })
    }

    public async Close(): Promise<void>
    {
        this.changeSubscription()
        for (const [ws, teardown] of this.clients)
        {
            teardown()
            ws.terminate()
        }
        this.clients.clear()
        const wss = this.wsServer
        const server = this.httpServer
        this.wsServer = undefined
        this.httpServer = undefined
        if (wss !== undefined)
        {
            await new Promise<void>(res => wss.close(() => res()))
        }
        if (server !== undefined)
        {
            server.closeAllConnections()
            await new Promise<void>(res => server.close(() => res()))
        }
    }

    public Address(): { address: string; port: number }
    {
        const a = this.httpServer?.address() as AddressInfo | null | undefined
        if (a === null || a === undefined)
        {
            throw new Error(TenantPlaneHost.NotListeningMessage)
        }
        return { address: a.address, port: a.port }
    }

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        try
        {
            const host = req.headers[PlaneHttp.HostHeader] as string | undefined
            if (!this.resolver.Accepts(host))
            {
                req.resume()
                PlaneHttp.WriteJson(res, TenantPlaneHost.StatusForbidden, { error: TenantPlaneHost.ForbiddenHostMessage })
                return
            }
            const tenantId = this.resolver.TenantFor(host) as string
            const callbackUrl = this.resolver.CallbackFor(host as string)
            const path = new URL(req.url ?? PlaneHttp.RootPath, TenantPlaneHost.BaseUrl).pathname
            if (await this.RouteTenant(req, res, path, host as string, tenantId, callbackUrl))
            {
                return
            }
            // No operator/`/api/*` route exists on this listener: an unmatched path falls to the tenant bundle (404 if missing).
            await PlaneHttp.ServeStatic(req, res, path, this.tenantStaticRootAbs)
        }
        catch (err)
        {
            this.WriteError(res, err)
        }
    }

    /**
     * Dispatches the tenant surface and returns whether it answered. `/tenant-auth/*` is public (no gate) and
     * delegates to the auth endpoint with the host-derived tenant + callback. `/tenant-api/*` is gated: the gate
     * must resolve a `pts_session` principal (else 401), then the validated session is handed to the data API.
     * Every mutating `/tenant-*` request's Origin must match the request's own tenant host (CSRF). Any other path
     * is not ours (returns false, so the tenant bundle is served).
     */
    private async RouteTenant(req: IncomingMessage, res: ServerResponse, path: string, host: string, tenantId: string, callbackUrl: string): Promise<boolean>
    {
        const isAuth = path.startsWith(TenantPlaneHost.TenantAuthPrefix)
        if (!isAuth && !path.startsWith(TenantPlaneHost.TenantApiPrefix))
        {
            return false
        }
        if (PlaneHttp.IsMutating(req) && !PlaneHttp.OriginIsHost(req, host))
        {
            req.resume()
            PlaneHttp.WriteJson(res, TenantPlaneHost.StatusForbidden, { error: TenantPlaneHost.BadOriginMessage })
            return true
        }
        if (isAuth)
        {
            return await this.endpoint.Handle(req, res, path, tenantId, callbackUrl)
        }
        const session = await this.gate.Principal(req)
        // Defense in depth: the session's tenant must be the one this host resolves to. Host-only pts_session cookies
        // already prevent carrying a cookie across tenant hosts; this makes the host↔session binding structural. A
        // mismatch is answered with the same generic 401 as no session, so it is not an oracle for a valid-but-wrong cookie.
        if (session === null || session.tenantId !== tenantId)
        {
            req.resume()
            PlaneHttp.WriteJson(res, TenantPlaneHost.StatusUnauthorized, { error: TenantPlaneHost.UnauthenticatedMessage })
            return true
        }
        return await this.api.Handle(req, res, path, session)
    }

    /**
     * Dispatches a ws upgrade. Only `/tenant-api/events` and the tenant logs-stream pattern are served; any other
     * path destroys the socket. Each is gated by the request host (a known tenant subdomain), the tenant origin,
     * and a resolved `pts_session` principal; any failure destroys the socket.
     */
    private RouteUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void
    {
        const path = new URL(req.url ?? PlaneHttp.RootPath, TenantPlaneHost.BaseUrl).pathname
        if (path === TenantPlaneHost.TenantEventsPath)
        {
            this.UpgradeTenantEvents(req, socket, head, wss)
            return
        }
        const lm = TenantPlaneHost.TenantLogsStreamPattern.exec(path)
        if (lm !== null)
        {
            this.UpgradeTenantLogs(req, socket, head, wss, lm)
            return
        }
        socket.destroy()
    }

    /** The tenant events ws: on success subscribes the bus for the session's tenant and forwards each event as JSON. */
    private UpgradeTenantEvents(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void
    {
        if (!this.TenantUpgradeAllowed(req))
        {
            socket.destroy()
            return
        }
        void this.gate.Principal(req).then(session =>
        {
            if (session === null || session.tenantId !== this.TenantOf(req))
            {
                socket.destroy()
                return
            }
            wss.handleUpgrade(req, socket, head, ws =>
            {
                const unsubscribe = this.events.On(session.tenantId, ev =>
                {
                    if (ws.readyState === WebSocket.OPEN)
                    {
                        ws.send(JSON.stringify(ev))
                    }
                })
                this.Track(ws, unsubscribe)
            })
        }, () => socket.destroy())
    }

    /** The tenant log-stream ws: on success hands the socket to TenantLogSocket, which enforces env ownership and streams. */
    private UpgradeTenantLogs(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer, m: RegExpExecArray): void
    {
        if (!this.TenantUpgradeAllowed(req))
        {
            socket.destroy()
            return
        }
        const name = TenantPlaneHost.Decode(m[1] as string)
        if (name === undefined)
        {
            socket.destroy()
            return
        }
        void this.gate.Principal(req).then(session =>
        {
            if (session === null || session.tenantId !== this.TenantOf(req))
            {
                socket.destroy()
                return
            }
            wss.handleUpgrade(req, socket, head, ws =>
            {
                const logSocket = new TenantLogSocket(session, name, this.service)
                if (!logSocket.Attach(ws))
                {
                    // Not the session tenant's env (or unknown): the socket is already closed and no stream started.
                    return
                }
                this.Track(ws, () => logSocket.Dispose())
            })
        }, () => socket.destroy())
    }

    /** Both tenant ws routes share this gate: the request host is a known tenant subdomain and the (present) Origin matches it. */
    private TenantUpgradeAllowed(req: IncomingMessage): boolean
    {
        const host = req.headers[PlaneHttp.HostHeader] as string | undefined
        if (!this.resolver.Accepts(host))
        {
            return false
        }
        return PlaneHttp.OriginIsHost(req, host)
    }

    /** The tenant id this request's host resolves to (undefined if the host is not an accepted tenant subdomain). */
    private TenantOf(req: IncomingMessage): string | undefined
    {
        return this.resolver.TenantFor(req.headers[PlaneHttp.HostHeader] as string | undefined)
    }

    /** Records a tenant socket with its teardown and wires close/error to run that teardown and drop the entry. */
    private Track(ws: WebSocket, teardown: () => void): void
    {
        this.clients.set(ws, teardown)
        ws.on(TenantPlaneHost.CloseEvent, () => this.Remove(ws))
        ws.on(TenantPlaneHost.ErrorEvent, () => this.Remove(ws))
    }

    private Remove(ws: WebSocket): void
    {
        const teardown = this.clients.get(ws)
        if (teardown === undefined)
        {
            return
        }
        this.clients.delete(ws)
        teardown()
    }

    private static Decode(segment: string): string | undefined
    {
        try
        {
            return decodeURIComponent(segment)
        }
        catch
        {
            return undefined
        }
    }

    private WriteError(res: ServerResponse, err: unknown): void
    {
        if (res.headersSent)
        {
            res.end()
            return
        }
        console.error(TenantPlaneHost.LogPrefix, err)
        PlaneHttp.WriteJson(res, TenantPlaneHost.StatusInternal, { error: TenantPlaneHost.GenericError })
    }
}
