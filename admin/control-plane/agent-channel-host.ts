import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PlaneHttp } from './plane-http.js'
import type { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { ConsoleAdvertReceiver, ConsoleNotEnabledError, InvalidConsoleAdvertError } from './console-advert-receiver.js'
import { AdoptionLedgerDtoMapper } from './tenant-api/rollout-client.js'
import { DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError } from './tenant-api/tenant-email-domains.js'
import { InvalidEmailDomainError } from './email-domain-policy.js'
import type { DomainVerificationAnswer } from './domain-verification-record.js'
import type { HiveHealthDto } from './hive-health-producer.js'
import { AgentUnauthorizedError, BodyTooLargeError, ChannelNotSubscribedError, HiveNotRegisteredError, ManifestNotGatedError, ManifestWithdrawnError, ReleaseNotRunnableYetError, TenantOnHoldError, UnknownHiveError, UnknownManifestError, VersionBelowFloorError } from './rollout-errors.js'

/** The dedicated public listener for the hive agent channel: eight bearer-authenticated routes (target, snapshot, adoptable, status, adopt, ledger, console, console/verify-domain), nothing else. The console routes are mounted only when an advert receiver is given. */
export class AgentChannelHost
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPattern = /^Bearer (\S+)$/
    private static readonly RoutePattern = /^\/agent\/hives\/([^/]+)\/(target|snapshot|adoptable|status|adopt|ledger|console|console\/verify-domain)$/
    private static readonly ConsoleSegment = 'console'
    private static readonly VerifyDomainSegment = 'console/verify-domain'
    private static readonly TargetSegment = 'target'
    private static readonly SnapshotSegment = 'snapshot'
    private static readonly AdoptableSegment = 'adoptable'
    private static readonly StatusSegment = 'status'
    private static readonly AdoptSegment = 'adopt'
    private static readonly LedgerSegment = 'ledger'
    private static readonly LimitParam = 'limit'
    private static readonly DefaultLedgerLimit = 200
    private static readonly BaseUrl = 'http://localhost'
    private static readonly RootPath = '/'
    private static readonly SegmentMethods: ReadonlyMap<string, string> = new Map([
        [AgentChannelHost.TargetSegment, PlaneHttp.MethodGet],
        [AgentChannelHost.SnapshotSegment, PlaneHttp.MethodPost],
        [AgentChannelHost.AdoptableSegment, PlaneHttp.MethodGet],
        [AgentChannelHost.StatusSegment, PlaneHttp.MethodGet],
        [AgentChannelHost.AdoptSegment, PlaneHttp.MethodPost],
        [AgentChannelHost.LedgerSegment, PlaneHttp.MethodGet],
        [AgentChannelHost.ConsoleSegment, PlaneHttp.MethodPost],
        [AgentChannelHost.VerifyDomainSegment, PlaneHttp.MethodPost]
    ])
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusConflict = 409
    private static readonly StatusForbidden = 403
    private static readonly StatusTooManyRequests = 429
    private static readonly StatusUnavailable = 503
    private static readonly InvalidDomainMessage = 'Invalid email domain'
    private static readonly DomainNotClaimedMessage = 'Domain is not among the reported email domains'
    private static readonly ThrottledMessage = 'Too many verification attempts'
    private static readonly UnavailableMessage = 'Domain verification unavailable'
    private static readonly StatusTooLarge = 413
    private static readonly StatusInternal = 500
    private static readonly MaxBodyBytes = 1048576
    private static readonly Utf8 = 'utf8'
    private static readonly NotListeningMessage = 'AgentChannelHost is not listening'
    private static readonly UnauthorizedMessage = 'Unauthorized'
    private static readonly BadRequestMessage = 'Request body must be { environments: HiveHealth[] }'
    private static readonly VersionKey = 'version'
    private static readonly AdoptBadRequestMessage = 'Request body must be { version: string }'
    private static readonly AdoptRefusedMessage = 'Version is not adoptable for this hive'
    private static readonly BadNameMessage = 'Invalid hive id in path'
    private static readonly TooLargeMessage = 'Request body too large'
    private static readonly InternalMessage = 'Internal error'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly CloseValue = 'close'
    private static readonly FallbackErrorName = 'Error'
    private static readonly LogPrefix = '[agent-channel]'

    private httpServer: HttpServer | undefined

    public constructor(private readonly deployments: PlatformDeploymentRegistry, private readonly adverts?: ConsoleAdvertReceiver)
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
        if (m === null || AgentChannelHost.SegmentMethods.get(m[2] as string) !== req.method || !this.IsMounted(m[2] as string))
        {
            req.resume()
            PlaneHttp.WriteNotFound(res)
            return
        }
        const segment = m[2] as string
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
        switch (segment)
        {
            case AgentChannelHost.TargetSegment:
                this.ServeTarget(res, id)
                return
            case AgentChannelHost.AdoptableSegment:
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, this.deployments.AdoptableFor(id))
                return
            case AgentChannelHost.StatusSegment:
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, this.deployments.StatusFor(id))
                return
            case AgentChannelHost.LedgerSegment:
                PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, AdoptionLedgerDtoMapper.ToDtos(this.deployments.LedgerForHive(id, AgentChannelHost.LedgerLimit(req))))
                return
            case AgentChannelHost.AdoptSegment:
                await this.ReceiveAdoption(req, res, id)
                return
            case AgentChannelHost.ConsoleSegment:
                await this.ReceiveConsoleAdvert(req, res, id)
                return
            case AgentChannelHost.VerifyDomainSegment:
                await this.ReceiveVerifyDomain(req, res, id)
                return
            default:
                await this.ReceiveSnapshot(req, res, id)
        }
    }

    /** Whether the route segment is served: every segment is, except console and console/verify-domain when no advert receiver was given. */
    private IsMounted(segment: string): boolean
    {
        return (segment !== AgentChannelHost.ConsoleSegment && segment !== AgentChannelHost.VerifyDomainSegment) || this.adverts !== undefined
    }

    /** The ?limit= of a ledger request, clamped to [0, DefaultLedgerLimit]; the default when absent or not a number. */
    private static LedgerLimit(req: IncomingMessage): number
    {
        const raw = new URL(req.url ?? AgentChannelHost.RootPath, AgentChannelHost.BaseUrl).searchParams.get(AgentChannelHost.LimitParam)
        const n = raw === null ? Number.NaN : Number.parseInt(raw, 10)
        return Number.isFinite(n) ? Math.min(Math.max(n, 0), AgentChannelHost.DefaultLedgerLimit) : AgentChannelHost.DefaultLedgerLimit
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

    private async ReceiveAdoption(req: IncomingMessage, res: ServerResponse, id: string): Promise<void>
    {
        const version = AgentChannelHost.ParseAdoption(await this.ReadBody(req))
        if (version === undefined)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusBadRequest, { error: AgentChannelHost.AdoptBadRequestMessage })
            return
        }
        await this.deployments.RecordAdoption(id, version)
        res.writeHead(AgentChannelHost.StatusNoContent)
        res.end()
    }

    /** Stores the advert the hive's console reports and answers the email domains the control plane refused, plus the tenant's last operator Owner reset (ownerResetAt) when there is one; a body that is not JSON is reported with the receiver's shape sentence, never echoed. */
    private async ReceiveConsoleAdvert(req: IncomingMessage, res: ServerResponse, id: string): Promise<void>
    {
        const body = AgentChannelHost.ParseConsoleJson(await this.ReadBody(req), ConsoleAdvertReceiver.BadShape)
        const outcome = await (this.adverts as ConsoleAdvertReceiver).Receive(id, body)
        const answer: { refusedEmailDomains: string[]; ownerResetAt?: string; domainVerifications?: DomainVerificationAnswer[] } = { refusedEmailDomains: outcome.refusedEmailDomains }
        if (outcome.ownerResetAt !== undefined)
        {
            answer.ownerResetAt = outcome.ownerResetAt
        }
        if (outcome.domainVerifications !== undefined)
        {
            answer.domainVerifications = outcome.domainVerifications
        }
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, answer)
    }

    /** Verifies one claimed domain for the hive's tenant and answers { verification }; a body that is not JSON is reported with the fixed verify sentence, never echoed. */
    private async ReceiveVerifyDomain(req: IncomingMessage, res: ServerResponse, id: string): Promise<void>
    {
        const body = AgentChannelHost.ParseConsoleJson(await this.ReadBody(req), ConsoleAdvertReceiver.BadVerifyShape)
        const verification = await (this.adverts as ConsoleAdvertReceiver).VerifyDomain(id, body)
        PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, { verification })
    }

    /** The parsed JSON of a console-route body; a body that is not JSON raises the given fixed sentence as a 400. */
    private static ParseConsoleJson(raw: string, badShape: string): unknown
    {
        try
        {
            return JSON.parse(raw)
        }
        catch
        {
            throw new InvalidConsoleAdvertError(badShape)
        }
    }

    /** The version of a { version: non-empty string } body, or undefined when it is anything else. */
    private static ParseAdoption(raw: string): string | undefined
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
        const version = (body as Record<string, unknown>)[AgentChannelHost.VersionKey]
        return typeof version === 'string' && version.length > 0 ? version : undefined
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
        if (err instanceof InvalidConsoleAdvertError)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusBadRequest, { error: err.message })
            return
        }
        if (err instanceof ConsoleNotEnabledError)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusConflict, { error: err.message })
            return
        }
        // Verification refusals carry fixed text, never the inner message. UnknownTenantError is deliberately unmapped (a logged 500).
        if (err instanceof InvalidEmailDomainError)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusBadRequest, { error: AgentChannelHost.InvalidDomainMessage })
            return
        }
        if (err instanceof DomainNotClaimedError)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusConflict, { error: AgentChannelHost.DomainNotClaimedMessage })
            return
        }
        if (err instanceof DomainVerifyThrottledError)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusTooManyRequests, { error: AgentChannelHost.ThrottledMessage })
            return
        }
        if (err instanceof DomainVerificationUnavailableError)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusUnavailable, { error: AgentChannelHost.UnavailableMessage })
            return
        }
        // Intentionally route-agnostic: only the adopt route can raise a gating refusal, a release-policy refusal or a registry
        // release hives cannot run yet; the agent never learns which rule failed.
        if (err instanceof ManifestNotGatedError || err instanceof UnknownManifestError || err instanceof ManifestWithdrawnError ||
            err instanceof TenantOnHoldError || err instanceof ChannelNotSubscribedError || err instanceof VersionBelowFloorError ||
            err instanceof ReleaseNotRunnableYetError)
        {
            PlaneHttp.WriteJson(res, AgentChannelHost.StatusForbidden, { error: AgentChannelHost.AdoptRefusedMessage })
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
