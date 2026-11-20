import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentChannelOperation, type AgentChannelRequest, type IAgentChannelBackend } from './agent-channel-backend.js'
import type { IDesktopDiscoveryBackend } from './desktop-discovery-contract.js'
import type { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'
import { InternalApiRoutes } from './internal-api-routes.js'
import { PlaneHttp } from './plane-http.js'
import { BodyTooLargeError } from './rollout-errors.js'

/**
 * Admin's internal listener for the edge: the agent channel and desktop discovery, carried verbatim (request in, the
 * exact reply out; the reply's own Status is inside the 200 body). Every POST needs the internal bearer. Published on
 * host loopback only (never through Caddy), so it is unreachable from the internet by construction.
 */
export class InternalApiHost
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPattern = /^Bearer (\S+)$/
    private static readonly QuerySeparator = '?'
    /** The edge forwards hive bodies of up to 1 MiB raw inside a JSON string; escaping can grow each byte to a
     *  six-character escape, so the cap covers the worst case plus the envelope. */
    private static readonly MaxBodyBytes = 6 * 1048576 + 65536
    private static readonly ConnectionHeader = 'Connection'
    private static readonly CloseValue = 'close'
    private static readonly MaxEmailLength = 254
    private static readonly Utf8 = 'utf8'
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusTooLarge = 413
    private static readonly StatusInternal = 500
    private static readonly UnauthorizedBody = { error: 'unauthorized' }
    private static readonly BadRequestBody = { error: 'bad-request' }
    private static readonly TooLargeBody = { error: 'too-large' }
    private static readonly InternalBody = { error: 'internal' }
    private static readonly OkBody = { ok: true }
    private static readonly NotListeningMessage = 'InternalApiHost is not listening'
    private static readonly TooLarge = 'too-large'
    private static readonly FallbackErrorName = 'Error'
    private static readonly LogPrefix = '[internal-api]'
    private static readonly Operations: ReadonlySet<string> = new Set(Object.values(AgentChannelOperation))

    private httpServer: HttpServer | undefined

    public constructor(private readonly credential: InternalApiCredential, private readonly agent: IAgentChannelBackend, private readonly discovery: IDesktopDiscoveryBackend)
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
            throw new Error(InternalApiHost.NotListeningMessage)
        }
        return { address: a.address, port: a.port }
    }

    private async Serve(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const I = InternalApiHost
        try
        {
            const path = (req.url ?? '').split(I.QuerySeparator)[0] as string
            if (path === InternalApiRoutes.Healthz && req.method === PlaneHttp.MethodGet)
            {
                req.resume()
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, I.OkBody)
                return
            }
            if ((path !== InternalApiRoutes.Agent && path !== InternalApiRoutes.Discover) || req.method !== PlaneHttp.MethodPost)
            {
                req.resume()
                PlaneHttp.WriteNotFound(res)
                return
            }
            if (!this.Authorized(req))
            {
                req.resume()
                PlaneHttp.WriteJson(res, I.StatusUnauthorized, I.UnauthorizedBody)
                return
            }
            const body = I.ParseJson(await I.ReadBody(req))
            if (path === InternalApiRoutes.Agent)
            {
                const request = I.AgentRequestOf(body)
                if (request === undefined)
                {
                    PlaneHttp.WriteJson(res, I.StatusBadRequest, I.BadRequestBody)
                    return
                }
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.agent.Handle(request))
                return
            }
            const email = I.EmailOf(body)
            if (email === undefined)
            {
                PlaneHttp.WriteJson(res, I.StatusBadRequest, I.BadRequestBody)
                return
            }
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, await this.discovery.Discover(email))
        }
        catch (err)
        {
            if (res.headersSent)
            {
                res.end()
                return
            }
            if (err instanceof BodyTooLargeError)
            {
                // The whole body was read and discarded first (the caller is already authenticated and on loopback), so
                // the 413 reaches it instead of a connection reset; the connection then closes.
                res.setHeader(I.ConnectionHeader, I.CloseValue)
                PlaneHttp.WriteJson(res, I.StatusTooLarge, I.TooLargeBody)
                return
            }
            console.error(I.LogPrefix, err instanceof Error ? err.name : I.FallbackErrorName)
            PlaneHttp.WriteJson(res, I.StatusInternal, I.InternalBody)
        }
    }

    private Authorized(req: IncomingMessage): boolean
    {
        const header = req.headers[InternalApiHost.AuthorizationHeader]
        const m = typeof header === 'string' ? InternalApiHost.BearerPattern.exec(header) : null
        return m !== null && this.credential.Matches(m[1] as string)
    }

    /** The validated request, or undefined for anything that is not one. */
    private static AgentRequestOf(body: unknown): AgentChannelRequest | undefined
    {
        if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body))
        {
            return undefined
        }
        const b = body as Record<string, unknown>
        const query = b.Query
        const queryOk = query === undefined || (query !== null && typeof query === 'object' && !Array.isArray(query)
            && Object.values(query as Record<string, unknown>).every(v => typeof v === 'string'))
        if (typeof b.Operation !== 'string' || !InternalApiHost.Operations.has(b.Operation)
            || typeof b.HiveId !== 'string' || b.HiveId.length === 0 || typeof b.Token !== 'string' || b.Token.length === 0
            || (b.Body !== undefined && typeof b.Body !== 'string') || !queryOk)
        {
            return undefined
        }
        return { Operation: b.Operation as AgentChannelOperation, HiveId: b.HiveId, Token: b.Token, Body: b.Body as string | undefined, Query: query as Record<string, string> | undefined }
    }

    private static EmailOf(body: unknown): string | undefined
    {
        const email = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).email : undefined
        return typeof email === 'string' && email.length > 0 && email.length <= InternalApiHost.MaxEmailLength ? email : undefined
    }

    private static ParseJson(raw: string): unknown
    {
        try
        {
            return JSON.parse(raw)
        }
        catch
        {
            return undefined
        }
    }

    private static ReadBody(req: IncomingMessage): Promise<string>
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
                if (size > InternalApiHost.MaxBodyBytes)
                {
                    tooLarge = true
                    chunks.length = 0
                    return
                }
                chunks.push(c)
            })
            // An oversized body is refused only once it has drained: closing with unread bytes in the socket makes TCP
            // reset the connection, and the caller would see ECONNRESET instead of the 413.
            req.on('end', () =>
            {
                if (tooLarge)
                {
                    reject(new BodyTooLargeError(InternalApiHost.TooLarge))
                    return
                }
                resolveBody(Buffer.concat(chunks).toString(InternalApiHost.Utf8))
            })
            req.on('error', reject)
        })
    }
}
