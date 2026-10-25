import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PlaneHttp } from './plane-http.js'
import type { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import type { HiveHealthDto } from './hive-health-producer.js'
import { AgentUnauthorizedError, BodyTooLargeError, HiveNotRegisteredError, UnknownHiveError } from './rollout-errors.js'

/** The dedicated public listener for the hive agent channel: two bearer-authenticated routes, nothing else. */
export class AgentChannelHost
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPattern = /^Bearer (\S+)$/
    private static readonly RoutePattern = /^\/agent\/hives\/([^/]+)\/(target|snapshot)$/
    private static readonly TargetSegment = 'target'
    private static readonly SnapshotSegment = 'snapshot'
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusTooLarge = 413
    private static readonly StatusInternal = 500
    private static readonly MaxBodyBytes = 1048576
    private static readonly Utf8 = 'utf8'
    private static readonly NotListeningMessage = 'AgentChannelHost is not listening'
    private static readonly UnauthorizedMessage = 'Unauthorized'
    private static readonly BadRequestMessage = 'Request body must be { environments: HiveHealth[] }'
    private static readonly BadNameMessage = 'Invalid hive id in path'
    private static readonly TooLargeMessage = 'Request body too large'
    private static readonly InternalMessage = 'Internal error'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly CloseValue = 'close'
    private static readonly FallbackErrorName = 'Error'
    private static readonly LogPrefix = '[agent-channel]'

    private httpServer: HttpServer | undefined

    public constructor(private readonly deployments: PlatformDeploymentRegistry)
    {
    }

    public Listen(port: number, bind: string): Promise<void>
    {
        const server = createServer((req, res) =>
        {
            void this.Handle(req, res)
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

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
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
        const path = (req.url ?? '').split('?')[0] as string
        const m = AgentChannelHost.RoutePattern.exec(path)
        const isTarget = m !== null && m[2] === AgentChannelHost.TargetSegment && req.method === PlaneHttp.MethodGet
        const isSnapshot = m !== null && m[2] === AgentChannelHost.SnapshotSegment && req.method === PlaneHttp.MethodPost
        if (m === null || (!isTarget && !isSnapshot))
        {
            req.resume()
            PlaneHttp.WriteNotFound(res)
            return
        }
        const id = AgentChannelHost.Decode(m[1] as string)
        if (id === undefined)
        {
            req.resume()
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusBadRequest, { error: AgentChannelHost.BadNameMessage })
            return
        }
        const bearer = AgentChannelHost.BearerToken(req)
        if (bearer === undefined)
        {
            req.resume()
            throw new AgentUnauthorizedError(id)
        }
        await this.deployments.VerifyAgentToken(id, bearer)
        if (isTarget)
        {
            this.ServeTarget(res, id)
            return
        }
        await this.ReceiveSnapshot(req, res, id)
    }

    private ServeTarget(res: ServerResponse, id: string): void
    {
        const target = this.deployments.TargetFor(id)
        if (target === undefined)
        {
            PlaneHttp.WriteNotFound(res)
            return
        }
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { version: target.version, image: target.image })
    }

    private async ReceiveSnapshot(req: IncomingMessage, res: ServerResponse, id: string): Promise<void>
    {
        const environments = AgentChannelHost.ParseSnapshot(await this.ReadBody(req))
        if (environments === undefined)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusBadRequest, { error: AgentChannelHost.BadRequestMessage })
            return
        }
        await this.deployments.ReportSnapshot(id, environments)
        res.writeHead(AgentChannelHost.StatusNoContent)
        res.end()
    }

    /** The validated environments of a { environments: HiveHealthDto[] } body, or undefined when it is anything else. */
    private static ParseSnapshot(raw: string): HiveHealthDto[] | undefined
    {
        let body: unknown
        try
        {
            body = JSON.parse(raw)
        }
        catch
        {
            return undefined
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body))
        {
            return undefined
        }
        const environments = (body as { environments?: unknown }).environments
        if (!Array.isArray(environments) || !environments.every(e => AgentChannelHost.IsHiveHealth(e)))
        {
            return undefined
        }
        return (environments as HiveHealthDto[]).map(h => ({ environmentName: h.environmentName, ready: h.ready, runningImage: h.runningImage, detail: h.detail }))
    }

    private static IsHiveHealth(e: unknown): e is HiveHealthDto
    {
        if (e === null || typeof e !== 'object' || Array.isArray(e))
        {
            return false
        }
        const h = e as Record<string, unknown>
        return typeof h.environmentName === 'string' && h.environmentName.length > 0
            && typeof h.ready === 'boolean'
            && (h.runningImage === undefined || typeof h.runningImage === 'string')
            && typeof h.detail === 'string'
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

    /** Maps a failure to a fixed-text response; an unregistered hive is indistinguishable from a wrong token, and no inner-error text reaches the body or log. */
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
        if (err instanceof AgentUnauthorizedError || err instanceof HiveNotRegisteredError || err instanceof UnknownHiveError)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusUnauthorized, { error: AgentChannelHost.UnauthorizedMessage })
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
