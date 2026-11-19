import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PlaneHttp } from './plane-http.js'
import { AgentChannelOperation, type AgentChannelReply, type IAgentChannelBackend } from './agent-channel-backend.js'
import { LocalAgentChannelBackend } from './local-agent-channel-backend.js'
import { BodyTooLargeError } from './rollout-errors.js'

/** The dedicated public listener for the hive agent channel: eight bearer-authenticated routes (target, snapshot,
 *  adoptable, status, adopt, ledger, console, console/verify-domain), nothing else. This class is the HTTP layer only
 *  (route, method, hive id, bearer presence, body size); the backend verifies the bearer and answers, in-process or
 *  over admin's internal API. The console routes are mounted only when the backend serves them. */
export class AgentChannelHost
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPattern = /^Bearer (\S+)$/
    private static readonly RoutePattern = /^\/agent\/hives\/([^/]+)\/(target|snapshot|adoptable|status|adopt|ledger|console|console\/verify-domain)$/
    private static readonly BaseUrl = 'http://localhost'
    private static readonly RootPath = '/'
    private static readonly QuerySeparator = '?'
    private static readonly SegmentMethods: ReadonlyMap<string, string> = new Map([
        [AgentChannelOperation.Target, PlaneHttp.MethodGet],
        [AgentChannelOperation.Snapshot, PlaneHttp.MethodPost],
        [AgentChannelOperation.Adoptable, PlaneHttp.MethodGet],
        [AgentChannelOperation.Status, PlaneHttp.MethodGet],
        [AgentChannelOperation.Adopt, PlaneHttp.MethodPost],
        [AgentChannelOperation.Ledger, PlaneHttp.MethodGet],
        [AgentChannelOperation.Console, PlaneHttp.MethodPost],
        [AgentChannelOperation.ConsoleVerifyDomain, PlaneHttp.MethodPost]
    ])
    private static readonly StatusBadRequest = 400
    private static readonly StatusTooLarge = 413
    private static readonly StatusInternal = 500
    private static readonly MaxBodyBytes = 1048576
    private static readonly Utf8 = 'utf8'
    private static readonly NotListeningMessage = 'AgentChannelHost is not listening'
    private static readonly BadNameMessage = 'Invalid hive id in path'
    private static readonly TooLargeMessage = 'Request body too large'
    private static readonly InternalMessage = 'Internal error'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly CloseValue = 'close'
    private static readonly FallbackErrorName = 'Error'
    private static readonly LogPrefix = '[agent-channel]'

    private httpServer: HttpServer | undefined

    public constructor(private readonly backend: IAgentChannelBackend)
    {
    }

    public Listen(port: number, bind: string): Promise<void>
    {
        const server = createServer((req, res) =>
        {
            void this.Serve(req, res)
        })
        return new Promise((resolve, reject) =>
        {
            server.once('error', reject)
            server.listen(port, bind, () =>
            {
                server.off('error', reject)
                this.httpServer = server
                resolve()
            })
        })
    }

    public async Close(): Promise<void>
    {
        const server = this.httpServer
        this.httpServer = undefined
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
            throw new Error(AgentChannelHost.NotListeningMessage)
        }
        return { address: a.address, port: a.port }
    }

    /** True when the request is for an agent-channel route (any method); lets a combined listener (the edge) dispatch. */
    public static IsChannelPath(url: string | undefined): boolean
    {
        return AgentChannelHost.RoutePattern.test((url ?? '').split(AgentChannelHost.QuerySeparator)[0] as string)
    }

    /** Serves one agent-channel request; never throws. */
    public async Serve(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        try
        {
            await this.Route(req, res)
        }
        catch (err)
        {
            this.WriteError(req, res, err)
        }
    }

    private async Route(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const A = AgentChannelHost
        const path = (req.url ?? '').split(A.QuerySeparator)[0] as string
        const m = A.RoutePattern.exec(path)
        if (m === null || A.SegmentMethods.get(m[2] as string) !== req.method || !this.IsMounted(m[2] as string))
        {
            req.resume()
            PlaneHttp.WriteNotFound(res)
            return
        }
        const operation = m[2] as AgentChannelOperation
        const id = A.Decode(m[1] as string)
        if (id === undefined)
        {
            req.resume()
            PlaneHttp.WriteJson(res, A.StatusBadRequest, { error: A.BadNameMessage })
            return
        }
        const bearer = A.BearerToken(req)
        if (bearer === undefined)
        {
            req.resume()
            A.WriteReply(res, LocalAgentChannelBackend.UnauthorizedReply)
            return
        }
        let body: string | undefined
        if (req.method === PlaneHttp.MethodPost)
        {
            body = await this.ReadBody(req)
        }
        else
        {
            req.resume()
        }
        A.WriteReply(res, await this.backend.Handle({ Operation: operation, HiveId: id, Token: bearer, Body: body, Query: A.QueryOf(req) }))
    }

    private static WriteReply(res: ServerResponse, reply: AgentChannelReply): void
    {
        if (reply.Body === undefined)
        {
            res.writeHead(reply.Status)
            res.end()
            return
        }
        PlaneHttp.WriteJson(res, reply.Status, reply.Body)
    }

    /** Whether the route segment is served: every segment is, except the console ones when the backend does not serve them. */
    private IsMounted(segment: string): boolean
    {
        return (segment !== AgentChannelOperation.Console && segment !== AgentChannelOperation.ConsoleVerifyDomain) || this.backend.ServesConsole()
    }

    private static QueryOf(req: IncomingMessage): Record<string, string> | undefined
    {
        const params = new URL(req.url ?? AgentChannelHost.RootPath, AgentChannelHost.BaseUrl).searchParams
        const query: Record<string, string> = {}
        for (const [k, v] of params)
        {
            query[k] = v
        }
        return Object.keys(query).length === 0 ? undefined : query
    }

    /** The token from a well-formed "Authorization: Bearer <token>" header, else undefined. */
    private static BearerToken(req: IncomingMessage): string | undefined
    {
        const header = req.headers[AgentChannelHost.AuthorizationHeader]
        const m = typeof header === 'string' ? AgentChannelHost.BearerPattern.exec(header) : null
        return m === null ? undefined : m[1]
    }

    private static Decode(segment: string): string | undefined
    {
        try
        {
            const id = decodeURIComponent(segment)
            return id.length === 0 ? undefined : id
        }
        catch
        {
            return undefined
        }
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
                if (tooLarge)
                {
                    return
                }
                size += c.length
                if (size > AgentChannelHost.MaxBodyBytes)
                {
                    tooLarge = true
                    chunks.length = 0
                    reject(new BodyTooLargeError(AgentChannelHost.TooLargeMessage))
                    return
                }
                chunks.push(c)
            })
            req.on('end', () =>
            {
                if (tooLarge)
                {
                    return
                }
                resolveBody(Buffer.concat(chunks).toString(AgentChannelHost.Utf8))
            })
            req.on('error', reject)
        })
    }

    /** The HTTP layer's own failures: an oversized body (413) or an unexpected error (500, name-only log). */
    private WriteError(req: IncomingMessage, res: ServerResponse, err: unknown): void
    {
        if (err instanceof BodyTooLargeError)
        {
            this.WriteTooLarge(req, res)
            return
        }
        req.resume()
        if (res.headersSent)
        {
            res.end()
            return
        }
        console.error(AgentChannelHost.LogPrefix, err instanceof Error ? err.name : AgentChannelHost.FallbackErrorName)
        PlaneHttp.WriteJson(res, AgentChannelHost.StatusInternal, { error: AgentChannelHost.InternalMessage })
    }

    /** Sheds an oversized body: answers 413 and closes the connection once the response is flushed, so the remainder is never read. */
    private WriteTooLarge(req: IncomingMessage, res: ServerResponse): void
    {
        if (res.headersSent)
        {
            req.destroy()
            return
        }
        res.setHeader(AgentChannelHost.ConnectionHeader, AgentChannelHost.CloseValue)
        res.once('finish', () => req.destroy())
        PlaneHttp.WriteJson(res, AgentChannelHost.StatusTooLarge, { error: AgentChannelHost.TooLargeMessage })
    }
}
