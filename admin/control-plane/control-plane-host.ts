import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import {
    CreateFailedError,
    DockerUnavailableError,
    EnvironmentExistsError,
    EnvironmentNotFoundError,
    ImageMissingError
} from './environment-service.js'
import { EnvStatus, Template, type EnvironmentRecord } from './environment-record.js'
import { PortUnavailableError } from './port-allocator.js'
import { InvalidEnvironmentNameError, TemplateCatalog } from './template-catalog.js'
import type { IOperatorIdentity } from './operator-identity.js'
import { SessionCookie } from './session-cookie.js'

export interface IEnvironmentService
{
    Create(name: string, template: Template, hostPort?: number): Promise<EnvironmentRecord>
    Start(name: string): Promise<EnvironmentRecord>
    Stop(name: string): Promise<EnvironmentRecord>
    Delete(name: string): Promise<void>
    List(): readonly EnvironmentRecord[]
    ListReconciled(): Promise<readonly EnvironmentRecord[]>
    Logs(name: string): Promise<string>
}

/** The only shape ever sent to a client: connect info, no internals or secrets. */
export type EnvironmentDto = {
    name: string
    template: Template
    tenantId: string
    hostPort: number
    status: EnvStatus
    createdAt: string
    httpUrl: string
    wsUrl: string
}

export type ChangedEvent = { type: string }

type ErrorCtor = abstract new (...args: never[]) => Error
type CreateBody = { name?: unknown; template?: unknown; hostPort?: unknown }
type LoginBody = { email?: unknown; password?: unknown }

class BodyTooLargeError extends Error
{
}

export class ControlPlaneHost
{
    private static readonly LocalName = 'localhost'
    private static readonly HttpScheme = 'http://'
    private static readonly WsScheme = 'ws://'
    private static readonly BaseUrl = ControlPlaneHost.HttpScheme + ControlPlaneHost.LocalName
    private static readonly PortSeparator = ':'
    private static readonly AllowedHosts: ReadonlySet<string> = new Set([ControlPlaneHost.LocalName, '127.0.0.1', '[::1]'])
    private static readonly HostHeaderPattern = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/
    private static readonly HostHeader = 'host'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly JsonMediaType = 'application/json'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly TransferEncodingHeader = 'transfer-encoding'
    private static readonly StatusForbidden = 403
    private static readonly StatusUnsupported = 415
    private static readonly ForbiddenHostMessage = 'Host not allowed'
    private static readonly UnsupportedMediaMessage = 'Content-Type must be application/json'
    private static readonly BadNameMessage = 'Invalid environment name in path'
    private static readonly NotListeningMessage = 'ControlPlaneHost is not listening'
    private static readonly OperationFailedMessage = 'Environment operation failed'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly LogPrefix = '[control-plane] request failed:'
    private static readonly TenantQuery = '/?tenant='
    private static readonly ApiPrefix = '/api/'
    private static readonly PingPath = '/api/ping'
    private static readonly TemplatesPath = '/api/templates'
    private static readonly EnvironmentsPath = '/api/environments'
    private static readonly EventsPath = '/api/events'
    private static readonly LoginPath = '/api/login'
    private static readonly SessionPath = '/api/session'
    private static readonly LogoutPath = '/api/logout'
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly OriginHeader = 'origin'
    private static readonly CookieHeader = 'cookie'
    private static readonly StatusUnauthorized = 401
    private static readonly InvalidCredentialsMessage = 'Invalid email or password'
    private static readonly UnauthenticatedMessage = 'Authentication required'
    private static readonly BadOriginMessage = 'Origin not allowed'
    private static readonly CredentialsRequiredMessage = 'email and password (strings) are required'
    private static readonly StartAction = 'start'
    private static readonly StopAction = 'stop'
    private static readonly LogsAction = 'logs'
    private static readonly EnvPathPattern = new RegExp(
        '^' + ControlPlaneHost.EnvironmentsPath + '/([^/]+)(?:/(' +
        [ControlPlaneHost.StartAction, ControlPlaneHost.StopAction, ControlPlaneHost.LogsAction].join('|') + '))?$')
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly MethodDelete = 'DELETE'
    private static readonly IndexFile = 'index.html'
    private static readonly RootPath = '/'
    private static readonly Utf8 = 'utf8'
    private static readonly ContentType = 'Content-Type'
    private static readonly JsonType = 'application/json; charset=utf-8'
    private static readonly DefaultType = 'application/octet-stream'
    private static readonly ChangedType = 'environments-changed'
    private static readonly MaxBodyBytes = 4096
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly StatusBadRequest = 400
    private static readonly StatusNotFound = 404
    private static readonly StatusConflict = 409
    private static readonly StatusTooLarge = 413
    private static readonly StatusInternal = 500
    private static readonly StatusUnavailable = 503
    private static readonly GenericError = 'Internal server error'
    private static readonly NotFoundMessage = 'Not found'
    private static readonly TooLargeMessage = 'Request body too large'
    private static readonly BadJsonMessage = 'Request body must be valid JSON'
    private static readonly NameRequiredMessage = 'name (string) is required'
    private static readonly TemplateInvalidMessage = 'template must be one of: '
    private static readonly HostPortInvalidMessage = 'hostPort must be an integer between 1 and 65535'
    private static readonly MaxPort = 65535
    private static readonly MimeTypes: ReadonlyMap<string, string> = new Map([
        ['.html', 'text/html; charset=utf-8'],
        ['.js', 'text/javascript; charset=utf-8'],
        ['.mjs', 'text/javascript; charset=utf-8'],
        ['.css', 'text/css; charset=utf-8'],
        ['.json', 'application/json; charset=utf-8'],
        ['.svg', 'image/svg+xml'],
        ['.png', 'image/png'],
        ['.ico', 'image/x-icon'],
        ['.map', 'application/json; charset=utf-8'],
        ['.txt', 'text/plain; charset=utf-8']
    ])
    private static readonly ErrorStatuses: ReadonlyMap<ErrorCtor, number> = new Map<ErrorCtor, number>([
        [InvalidEnvironmentNameError, ControlPlaneHost.StatusBadRequest],
        [EnvironmentNotFoundError, ControlPlaneHost.StatusNotFound],
        [EnvironmentExistsError, ControlPlaneHost.StatusConflict],
        [PortUnavailableError, ControlPlaneHost.StatusConflict],
        [ImageMissingError, ControlPlaneHost.StatusConflict],
        [DockerUnavailableError, ControlPlaneHost.StatusUnavailable],
        [CreateFailedError, ControlPlaneHost.StatusInternal]
    ])

    private httpServer: HttpServer | undefined
    private wsServer: WebSocketServer | undefined
    private readonly clients = new Set<WebSocket>()
    private readonly staticRootAbs: string

    public constructor(
        private readonly service: IEnvironmentService,
        staticRoot: string,
        private readonly operator: IOperatorIdentity,
        private readonly secureCookie: boolean)
    {
        this.staticRootAbs = resolve(staticRoot)
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
            const path = new URL(req.url ?? ControlPlaneHost.RootPath, ControlPlaneHost.BaseUrl).pathname
            if (path !== ControlPlaneHost.EventsPath || !ControlPlaneHost.HostAllowed(req) || !ControlPlaneHost.OriginAllowed(req))
            {
                socket.destroy()
                return
            }
            void this.Authenticated(req).then(ok =>
            {
                if (!ok)
                {
                    socket.destroy()
                    return
                }
                wss.handleUpgrade(req, socket, head, ws =>
                {
                    this.clients.add(ws)
                    ws.on(ControlPlaneHost.CloseEvent, () => this.clients.delete(ws))
                    ws.on(ControlPlaneHost.ErrorEvent, () => this.clients.delete(ws))
                })
            }, () => socket.destroy())
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
        for (const c of this.clients)
        {
            c.terminate()
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
            throw new Error(ControlPlaneHost.NotListeningMessage)
        }
        return { address: a.address, port: a.port }
    }

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        try
        {
            if (!ControlPlaneHost.HostAllowed(req))
            {
                this.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.ForbiddenHostMessage })
                return
            }
            if (ControlPlaneHost.HasBody(req) && !ControlPlaneHost.IsJson(req))
            {
                req.resume()
                this.WriteJson(res, ControlPlaneHost.StatusUnsupported, { error: ControlPlaneHost.UnsupportedMediaMessage })
                return
            }
            const path = new URL(req.url ?? ControlPlaneHost.RootPath, ControlPlaneHost.BaseUrl).pathname
            if (path.startsWith(ControlPlaneHost.ApiPrefix))
            {
                if (ControlPlaneHost.IsMutating(req) && !ControlPlaneHost.OriginAllowed(req))
                {
                    req.resume()
                    this.WriteJson(res, ControlPlaneHost.StatusForbidden, { error: ControlPlaneHost.BadOriginMessage })
                    return
                }
                if (!ControlPlaneHost.IsPublicApi(path) && !(await this.Authenticated(req)))
                {
                    req.resume()
                    this.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
                    return
                }
            }
            const handled = await this.RouteApi(req, res, path)
            if (!handled)
            {
                await this.ServeStatic(req, res, path)
            }
        }
        catch (err)
        {
            this.WriteError(res, err)
        }
    }

    /** Returns false when the request does not match any API route (falls through to static). */
    private async RouteApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
    {
        const method = req.method ?? ControlPlaneHost.MethodGet
        if (path === ControlPlaneHost.PingPath && method === ControlPlaneHost.MethodGet)
        {
            this.WriteJson(res, ControlPlaneHost.StatusOk, { ok: true })
            return true
        }
        if (path === ControlPlaneHost.LoginPath && method === ControlPlaneHost.MethodPost)
        {
            await this.HandleLogin(req, res)
            return true
        }
        if (path === ControlPlaneHost.SessionPath && method === ControlPlaneHost.MethodGet)
        {
            const who = await this.Principal(req)
            if (who === null)
            {
                this.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.UnauthenticatedMessage })
            }
            else
            {
                this.WriteJson(res, ControlPlaneHost.StatusOk, { email: who.email })
            }
            return true
        }
        if (path === ControlPlaneHost.LogoutPath && method === ControlPlaneHost.MethodPost)
        {
            const token = SessionCookie.Read(req.headers[ControlPlaneHost.CookieHeader])
            if (token !== undefined)
            {
                await this.operator.Revoke(token)
            }
            res.setHeader(ControlPlaneHost.SetCookieHeader, SessionCookie.BuildClearing(this.secureCookie))
            this.WriteJson(res, ControlPlaneHost.StatusOk, { ok: true })
            return true
        }
        if (path === ControlPlaneHost.TemplatesPath && method === ControlPlaneHost.MethodGet)
        {
            this.WriteJson(res, ControlPlaneHost.StatusOk, TemplateCatalog.All())
            return true
        }
        if (path === ControlPlaneHost.EnvironmentsPath)
        {
            if (method === ControlPlaneHost.MethodGet)
            {
                this.WriteJson(res, ControlPlaneHost.StatusOk, (await this.service.ListReconciled()).map(r => ControlPlaneHost.ToDto(r)))
                return true
            }
            if (method === ControlPlaneHost.MethodPost)
            {
                await this.HandleCreate(req, res)
                return true
            }
            return false
        }
        const m = ControlPlaneHost.EnvPathPattern.exec(path)
        if (m === null)
        {
            return false
        }
        let name: string
        try
        {
            name = decodeURIComponent(m[1] as string)
        }
        catch
        {
            this.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadNameMessage })
            return true
        }
        const action = m[2]
        if (action === ControlPlaneHost.StartAction && method === ControlPlaneHost.MethodPost)
        {
            const rec = await this.service.Start(name)
            this.WriteJson(res, ControlPlaneHost.StatusOk, ControlPlaneHost.ToDto(rec))
            this.Broadcast(ControlPlaneHost.Changed())
            return true
        }
        if (action === ControlPlaneHost.StopAction && method === ControlPlaneHost.MethodPost)
        {
            const rec = await this.service.Stop(name)
            this.WriteJson(res, ControlPlaneHost.StatusOk, ControlPlaneHost.ToDto(rec))
            this.Broadcast(ControlPlaneHost.Changed())
            return true
        }
        if (action === ControlPlaneHost.LogsAction && method === ControlPlaneHost.MethodGet)
        {
            const logs = await this.service.Logs(name)
            this.WriteJson(res, ControlPlaneHost.StatusOk, { logs })
            return true
        }
        if (action === undefined && method === ControlPlaneHost.MethodDelete)
        {
            await this.service.Delete(name)
            this.WriteJson(res, ControlPlaneHost.StatusOk, { ok: true })
            this.Broadcast(ControlPlaneHost.Changed())
            return true
        }
        return false
    }

    private async HandleLogin(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const raw = await this.ReadBody(req)
        let body: LoginBody
        try
        {
            body = JSON.parse(raw) as LoginBody
        }
        catch
        {
            this.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadJsonMessage })
            return
        }
        if (body === null || typeof body !== 'object' || typeof body.email !== 'string' || typeof body.password !== 'string')
        {
            this.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.CredentialsRequiredMessage })
            return
        }
        const session = await this.operator.Authenticate(body.email, body.password)
        if (session === null)
        {
            this.WriteJson(res, ControlPlaneHost.StatusUnauthorized, { error: ControlPlaneHost.InvalidCredentialsMessage })
            return
        }
        res.setHeader(ControlPlaneHost.SetCookieHeader, SessionCookie.Build(session.token, session.expiresAt, this.secureCookie))
        this.WriteJson(res, ControlPlaneHost.StatusOk, { email: body.email })
    }

    private async Principal(req: IncomingMessage): Promise<{ email: string } | null>
    {
        const token = SessionCookie.Read(req.headers[ControlPlaneHost.CookieHeader])
        return token === undefined || token.length === 0 ? null : await this.operator.ValidateToken(token)
    }

    private async Authenticated(req: IncomingMessage): Promise<boolean>
    {
        return (await this.Principal(req)) !== null
    }

    private async HandleCreate(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const raw = await this.ReadBody(req)
        let body: CreateBody
        try
        {
            body = JSON.parse(raw) as CreateBody
        }
        catch
        {
            this.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.BadJsonMessage })
            return
        }
        const valid = Object.values(Template) as string[]
        if (body === null || typeof body !== 'object' || typeof body.name !== 'string' || body.name.length === 0)
        {
            this.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.NameRequiredMessage })
            return
        }
        if (typeof body.template !== 'string' || !valid.includes(body.template))
        {
            this.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.TemplateInvalidMessage + valid.join(', ') })
            return
        }
        let hostPort: number | undefined
        if (body.hostPort !== undefined)
        {
            if (typeof body.hostPort !== 'number' || !Number.isInteger(body.hostPort) || body.hostPort < 1 || body.hostPort > ControlPlaneHost.MaxPort)
            {
                this.WriteJson(res, ControlPlaneHost.StatusBadRequest, { error: ControlPlaneHost.HostPortInvalidMessage })
                return
            }
            hostPort = body.hostPort
        }
        const rec = await this.service.Create(body.name, body.template as Template, hostPort)
        this.WriteJson(res, ControlPlaneHost.StatusCreated, ControlPlaneHost.ToDto(rec))
        this.Broadcast(ControlPlaneHost.Changed())
    }

    private ReadBody(req: IncomingMessage): Promise<string>
    {
        return new Promise((resolveBody, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on('data', (c: Buffer) =>
            {
                size += c.length
                if (size > ControlPlaneHost.MaxBodyBytes)
                {
                    tooLarge = true
                    return
                }
                chunks.push(c)
            })
            req.on('end', () =>
            {
                if (tooLarge)
                {
                    reject(new BodyTooLargeError(ControlPlaneHost.TooLargeMessage))
                    return
                }
                resolveBody(Buffer.concat(chunks).toString(ControlPlaneHost.Utf8))
            })
            req.on('error', reject)
        })
    }

    private async ServeStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>
    {
        if (req.method !== ControlPlaneHost.MethodGet)
        {
            this.WriteNotFound(res)
            return
        }
        let rel: string
        try
        {
            rel = decodeURIComponent(path)
        }
        catch
        {
            this.WriteNotFound(res)
            return
        }
        if (rel === ControlPlaneHost.RootPath)
        {
            rel = ControlPlaneHost.RootPath + ControlPlaneHost.IndexFile
        }
        const abs = resolve(this.staticRootAbs, '.' + rel)
        if (!abs.startsWith(this.staticRootAbs + sep))
        {
            this.WriteNotFound(res)
            return
        }
        try
        {
            const data = await readFile(abs)
            const type = ControlPlaneHost.MimeTypes.get(extname(abs).toLowerCase()) ?? ControlPlaneHost.DefaultType
            res.writeHead(ControlPlaneHost.StatusOk, { [ControlPlaneHost.ContentType]: type })
            res.end(data)
        }
        catch
        {
            this.WriteNotFound(res)
        }
    }

    private WriteNotFound(res: ServerResponse): void
    {
        this.WriteJson(res, ControlPlaneHost.StatusNotFound, { error: ControlPlaneHost.NotFoundMessage })
    }

    private WriteError(res: ServerResponse, err: unknown): void
    {
        if (res.headersSent)
        {
            res.end()
            return
        }
        if (err instanceof BodyTooLargeError)
        {
            this.WriteJson(res, ControlPlaneHost.StatusTooLarge, { error: ControlPlaneHost.TooLargeMessage })
            return
        }
        const status = this.StatusFor(err)
        if (status === undefined || status >= ControlPlaneHost.StatusInternal && status !== ControlPlaneHost.StatusUnavailable)
        {
            console.error(ControlPlaneHost.LogPrefix, err)
            this.WriteJson(res, ControlPlaneHost.StatusInternal, { error: ControlPlaneHost.OperationFailedMessage })
            return
        }
        if (err instanceof ImageMissingError)
        {
            this.WriteJson(res, status, { error: err.message, buildCommand: err.buildCommand })
            return
        }
        this.WriteJson(res, status, { error: (err as Error).message })
    }

    private StatusFor(err: unknown): number | undefined
    {
        if (!(err instanceof Error))
        {
            return undefined
        }
        return ControlPlaneHost.ErrorStatuses.get(err.constructor as ErrorCtor)
    }

    private WriteJson(res: ServerResponse, status: number, body: unknown): void
    {
        res.writeHead(status, { [ControlPlaneHost.ContentType]: ControlPlaneHost.JsonType })
        res.end(JSON.stringify(body))
    }

    private Broadcast(event: ChangedEvent): void
    {
        const text = JSON.stringify(event)
        for (const c of this.clients)
        {
            if (c.readyState === WebSocket.OPEN)
            {
                c.send(text)
            }
        }
    }

    private static HostAllowed(req: IncomingMessage): boolean
    {
        const header = req.headers[ControlPlaneHost.HostHeader]
        const m = header === undefined ? null : ControlPlaneHost.HostHeaderPattern.exec(header)
        return m !== null && ControlPlaneHost.AllowedHosts.has((m[1] as string).toLowerCase())
    }

    private static IsPublicApi(path: string): boolean
    {
        return path === ControlPlaneHost.PingPath || path === ControlPlaneHost.LoginPath || path === ControlPlaneHost.SessionPath
    }

    private static IsMutating(req: IncomingMessage): boolean
    {
        return req.method === ControlPlaneHost.MethodPost || req.method === ControlPlaneHost.MethodDelete
    }

    /** Absent Origin is allowed (non-browser / same-origin navigation); a present one must equal our own origin. */
    private static OriginAllowed(req: IncomingMessage): boolean
    {
        const origin = req.headers[ControlPlaneHost.OriginHeader]
        return origin === undefined || origin === ControlPlaneHost.HttpScheme + req.headers[ControlPlaneHost.HostHeader]
    }

    private static HasBody(req: IncomingMessage): boolean
    {
        if (req.method !== ControlPlaneHost.MethodPost)
        {
            return false
        }
        const len = req.headers[ControlPlaneHost.ContentLengthHeader]
        return (len !== undefined && len !== '0') || req.headers[ControlPlaneHost.TransferEncodingHeader] !== undefined
    }

    private static IsJson(req: IncomingMessage): boolean
    {
        const type = req.headers[ControlPlaneHost.ContentTypeHeader] ?? ''
        return type.split(';')[0]!.trim().toLowerCase() === ControlPlaneHost.JsonMediaType
    }

    private static Changed(): ChangedEvent
    {
        return { type: ControlPlaneHost.ChangedType }
    }

    private static ToDto(r: EnvironmentRecord): EnvironmentDto
    {
        return {
            name: r.name,
            template: r.template,
            tenantId: r.tenantId,
            hostPort: r.hostPort,
            status: r.status,
            createdAt: r.createdAt,
            httpUrl: ControlPlaneHost.HttpScheme + ControlPlaneHost.LocalName + ControlPlaneHost.PortSeparator + String(r.hostPort),
            wsUrl: ControlPlaneHost.WsScheme + ControlPlaneHost.LocalName + ControlPlaneHost.PortSeparator + String(r.hostPort) + ControlPlaneHost.TenantQuery + r.tenantId
        }
    }
}
