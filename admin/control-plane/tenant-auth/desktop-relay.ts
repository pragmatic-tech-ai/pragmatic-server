import { STATUS_CODES, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { ApplicationDeployProtocol, AppWriteStatus, GraphProtocol, type TokenIssuedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AuditRegistry } from '../audit-record.js'
import { AuditThrottle } from '../audit-throttle.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import type { IEnvironmentReach, EnvironmentUrlsLease } from '../environment-endpoints.js'
import type { EnvironmentRecord } from '../environment-record.js'
import { PlaneHttp } from '../plane-http.js'
import { TransportFailure } from '../transport-failure.js'
import { DesktopAction, DesktopTargetVerdict, type DesktopTargets } from './desktop-targets.js'
import type { DesktopAuthGate } from './desktop-auth-gate.js'
import type { IDesktopSessionConnections } from './desktop-endpoint.js'
import type { IPrincipalConnections } from './tenant-principal-sessions.js'
import { TenantAuditEntry } from './tenant-audit-entry.js'
import { TenantClientAddress } from './tenant-client-address.js'
import type { TenantSession } from './tenant-session.js'

/** Opens the onward WebSocket to an environment server with a bearer credential; resolves once it is open. */
export interface IUpstreamDialer
{
    Dial(url: string, bearer: string): Promise<WebSocket>
}

/** The production dialer: a `ws` client with `Authorization: Bearer`, a bounded handshake, and any non-101 answer a failure. */
export class WsUpstreamDialer implements IUpstreamDialer
{
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly HandshakeTimeoutMs = 10000
    private static readonly RefusedMessage = 'The environment server refused the relay connection.'
    private static readonly OpenEvent = 'open'
    private static readonly ErrorEvent = 'error'
    private static readonly UnexpectedResponseEvent = 'unexpected-response'

    public Dial(url: string, bearer: string): Promise<WebSocket>
    {
        const ws = new WebSocket(url, {
            headers: { [WsUpstreamDialer.AuthorizationHeader]: WsUpstreamDialer.BearerPrefix + bearer },
            handshakeTimeout: WsUpstreamDialer.HandshakeTimeoutMs,
        })
        return new Promise((resolve, reject) =>
        {
            ws.once(WsUpstreamDialer.OpenEvent, () => resolve(ws))
            ws.once(WsUpstreamDialer.ErrorEvent, err => reject(err))
            ws.once(WsUpstreamDialer.UnexpectedResponseEvent, () =>
            {
                ws.terminate()
                reject(new Error(WsUpstreamDialer.RefusedMessage))
            })
        })
    }
}

/** A cancellable one-shot timer. */
export interface IRelayTimer
{
    Cancel(): void
}

/** The relay's clock: the time now and one-shot timers (the seam tests drive heartbeats and deadlines through). */
export interface IRelayClock
{
    Now(): number
    Schedule(callback: () => void, delayMs: number): IRelayTimer
}

/** The production clock: Date.now and unref'd setTimeout, its delay clamped to what setTimeout accepts. */
export class SystemRelayClock implements IRelayClock
{
    /** setTimeout's ceiling (2^31 - 1 ms); a caller re-arms when it fires before its due time. */
    private static readonly MaxDelayMs = 2147483647
    private static readonly MinDelayMs = 0

    public Now(): number
    {
        return Date.now()
    }

    public Schedule(callback: () => void, delayMs: number): IRelayTimer
    {
        const handle = setTimeout(callback, Math.min(Math.max(SystemRelayClock.MinDelayMs, delayMs), SystemRelayClock.MaxDelayMs))
        // A relay's timers must not keep the process alive on their own.
        handle.unref?.()
        return { Cancel: () => clearTimeout(handle) }
    }
}

/**
 * The JSON-RPC methods a desktop relay forwards per action. `PragmaticClient` (pragmatic-protocol) sends no handshake of
 * its own: no initialize, no ping, and since it never passes a cancellation token to vscode-jsonrpc, no `$/cancelRequest`
 * either. So each action's set is exactly the methods its desktop flow calls: contribute lists graphs to pick one and
 * contributes to it; publish deploys an application.
 */
export class DesktopRelayAllowlist
{
    private static readonly Contribute: ReadonlySet<string> = new Set([GraphProtocol.List.method, GraphProtocol.Contribute.method])
    private static readonly Publish: ReadonlySet<string> = new Set([ApplicationDeployProtocol.Deploy.method])
    /** Audited methods and the params field naming what they act on (the audit note). */
    private static readonly AuditedNoteField: ReadonlyMap<string, string> = new Map([
        [GraphProtocol.Contribute.method, 'graphName'],
        [ApplicationDeployProtocol.Deploy.method, 'appName'],
    ])

    public static For(action: DesktopAction): ReadonlySet<string>
    {
        return action === DesktopAction.Contribute ? DesktopRelayAllowlist.Contribute : DesktopRelayAllowlist.Publish
    }

    /** The params field to note for an audited method; undefined when the method is not audited. */
    public static NoteFieldOf(method: string): string | undefined
    {
        return DesktopRelayAllowlist.AuditedNoteField.get(method)
    }

    /** Whether a reported outcome is an in-band failure (a deploy answered with a non-applied status). */
    public static IsInBandFailure(method: string, result: unknown): boolean
    {
        if (method !== ApplicationDeployProtocol.Deploy.method || typeof result !== 'object' || result === null)
        {
            return false
        }
        return (result as { status?: unknown }).status !== AppWriteStatus.Applied
    }
}

/** Who a relay serves and what it may do: enough for audit records, socket bookkeeping and the allowlist. */
type RelayContext = { session: TenantSession; actor: string; action: DesktopAction; envName: string }

/**
 * The Plexus desktop relay, `GET /desktop/relay?environment=<name>&action=<contribute|publish>` (a WebSocket upgrade).
 * Plexus never holds an environment credential: the relay authenticates the Desktop bearer, checks the env with the same
 * rule the targets list uses, mints a short-lived credential for the action (maker for contribute, deployer for publish),
 * dials the environment server with it, and pipes JSON-RPC text frames both ways. Client requests outside the action's
 * allowlist are answered -32601 here and never forwarded; a request reusing the id of any forwarded request still awaiting
 * its answer is answered -32600, and one beyond 32 awaiting answers (audited or not) -32603, neither forwarded; client notifications and client responses are dropped
 * silently (neither flow sends one, and a notification could not be audited); a malformed handshake is refused 400; a non-JSON, binary or batch frame closes the
 * relay with 1008. Upstream frames pass through untouched.
 *
 * Refusals are plain HTTP answers written before the upgrade: 403 for any request carrying an Origin header (desktop
 * only: a browser page cannot drive it), 401 (no valid desktop bearer), 400 (bad action or no
 * environment), 403 (not allowed: capability, type, tenant or unknown), 409 (allowed but not running), 502 (unreachable,
 * minting failed, or the environment server refused the dial). Each refusal is audited with its HTTP status under a
 * per-address throttle (anonymous and signed-in alike, so no flood can churn the shared log), and each forwarded contribute or
 * deploy is audited once when its response returns (200, or 500 for an error or a non-applied deploy; 502 if the relay
 * closed first). The tunnel lease is held for the whole relay and released exactly once. Neither the desktop token nor
 * the minted credential is ever logged, audited or echoed.
 *
 * A relay's lifetime is bounded. It pings the client every 30 s and terminates a client that has not answered the previous
 * ping by the next one (a 30 s pong window), so a crashed or sleeping desktop never holds a tunnel lease and an upstream
 * socket indefinitely. And it closes with 4001 (RelayPipe.Expired: expired, open a new relay) at the earlier of its
 * desktop session's expiry and its minted credential's expiry, so it never outlives either. While its console is no longer
 * registered with the platform (Retire, until Reinstate) every relay, open or still connecting, closes with 4003
 * (ConsoleRetiredCloseCode).
 */
export class DesktopRelay implements IPrincipalConnections, IDesktopSessionConnections
{
    public static readonly Path = '/desktop/relay'
    /** The close code a relay ends with when its console is no longer registered with the platform (Retire). */
    public static readonly ConsoleRetiredCloseCode = 4003
    private static readonly BaseUrl = 'http://localhost'
    private static readonly EnvironmentParam = 'environment'
    private static readonly ActionParam = 'action'
    private static readonly UpstreamQuery = '/?environment='
    private static readonly NoValue = ''
    private static readonly StatusUnauthorized = 401
    private static readonly StatusBadRequest = 400
    private static readonly StatusForbidden = 403
    private static readonly StatusConflict = 409
    private static readonly StatusInternal = 500
    private static readonly StatusBadGateway = 502
    private static readonly HttpVersion = 'HTTP/1.1 '
    private static readonly HeaderSeparator = '\r\n'
    private static readonly ResponseHeaders = 'Connection: close\r\nContent-Type: application/json\r\nContent-Length: '
    private static readonly Space = ' '
    private static readonly LogPrefix = '[desktop-relay] upstream failed:'
    private static readonly RevokeLogPrefix = '[desktop-relay] revoking the relay credential failed:'
    private static readonly ErrorEvent = 'error'
    private static readonly FinishEvent = 'finish'
    private static readonly CloseEvent = 'close'
    private static readonly MethodGet = 'GET'
    private static readonly UpgradeHeader = 'upgrade'
    private static readonly WebSocketUpgrade = 'websocket'
    private static readonly KeyHeader = 'sec-websocket-key'
    private static readonly VersionHeader = 'sec-websocket-version'
    /** The handshake shape ws accepts (its keyRegex and versions); anything else ws would abort without calling back. */
    private static readonly KeyPattern = /^[+/0-9A-Za-z]{22}==$/
    private static readonly Versions: ReadonlySet<string> = new Set(['13', '8'])
    private static readonly Messages: ReadonlyMap<number, string> = new Map([
        [DesktopRelay.StatusUnauthorized, 'Sign in to the desktop app again.'],
        [DesktopRelay.StatusBadRequest, 'The relay needs an environment and an action of contribute or publish.'],
        [DesktopRelay.StatusForbidden, 'You may not do this on that environment.'],
        [DesktopRelay.StatusConflict, 'The environment is not running.'],
        [DesktopRelay.StatusInternal, 'Internal server error'],
        [DesktopRelay.StatusBadGateway, 'The environment server could not be reached.'],
    ])

    private readonly wss = new WebSocketServer({ noServer: true })
    private readonly pipes = new Set<RelayPipe>()
    /** Audit appends still running (each starts after its answer was written); Close waits for them. */
    private readonly pendingAudits = new Set<Promise<void>>()
    /** Set by Retire, cleared by Reinstate: the code a relay still connecting is closed with instead of opening. */
    private retiredWith: number | undefined

    public constructor(
        private readonly gate: DesktopAuthGate,
        private readonly targets: DesktopTargets,
        private readonly service: IEnvironmentService,
        private readonly endpoints: IEnvironmentReach,
        private readonly audit: AuditRegistry,
        private readonly dialer: IUpstreamDialer = new WsUpstreamDialer(),
        /** Per client address: bounds how many refusals (anonymous or signed in) reach the audit log. */
        private readonly refusalThrottle: AuditThrottle = new AuditThrottle(),
        private readonly trustedProxy: boolean = false,
        private readonly clock: IRelayClock = new SystemRelayClock())
    {
    }

    public async Upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>
    {
        // The raw socket must not raise an unhandled error while the checks below are awaited.
        socket.on(DesktopRelay.ErrorEvent, () => undefined)
        const query = DesktopRelay.QueryOf(req)
        const rawEnv = query?.get(DesktopRelay.EnvironmentParam) ?? DesktopRelay.NoValue
        const rawAction = query?.get(DesktopRelay.ActionParam) ?? DesktopRelay.NoValue
        // ws's handleUpgrade drops a malformed handshake without calling back; refuse it here, before anything is minted.
        if (!DesktopRelay.IsWebSocketHandshake(req))
        {
            await this.Refuse(req, socket, DesktopRelay.StatusBadRequest, AuditRegistry.AnonymousActor, rawAction, rawEnv)
            return
        }
        // Desktop-only like the rest of `/desktop/*`: a browser page always sends Origin on a WebSocket, so it is refused.
        if (req.headers[PlaneHttp.OriginHeader] !== undefined)
        {
            await this.Refuse(req, socket, DesktopRelay.StatusForbidden, AuditRegistry.AnonymousActor, rawAction, rawEnv)
            return
        }
        let session: TenantSession | null
        try
        {
            session = await this.gate.Principal(req)
        }
        catch
        {
            await this.Refuse(req, socket, DesktopRelay.StatusInternal, AuditRegistry.AnonymousActor, rawAction, rawEnv)
            return
        }
        if (session === null)
        {
            await this.Refuse(req, socket, DesktopRelay.StatusUnauthorized, AuditRegistry.AnonymousActor, rawAction, rawEnv)
            return
        }
        const actor = TenantAuditEntry.ActorOf(session)
        const action = DesktopRelay.ActionOf(rawAction)
        if (action === undefined || rawEnv === DesktopRelay.NoValue)
        {
            await this.Refuse(req, socket, DesktopRelay.StatusBadRequest, actor, rawAction, rawEnv)
            return
        }
        let record: EnvironmentRecord
        try
        {
            const check = await this.targets.Check(session, rawEnv, action)
            if (check.verdict !== DesktopTargetVerdict.Allowed || check.record === undefined)
            {
                const status = check.verdict === DesktopTargetVerdict.NotRunning ? DesktopRelay.StatusConflict : DesktopRelay.StatusForbidden
                await this.Refuse(req, socket, status, actor, action, rawEnv)
                return
            }
            record = check.record
        }
        catch
        {
            await this.Refuse(req, socket, DesktopRelay.StatusInternal, actor, action, rawEnv)
            return
        }
        await this.Connect(req, socket, head, { session, actor, action, envName: record.name }, record)
    }

    /**
     * Ends every open relay (the tenant listener is closing) and resolves once no audit append is still writing: an
     * outcome or refusal is recorded after its answer, so a caller can see the answer before the write ends.
     */
    public async Close(): Promise<void>
    {
        for (const pipe of [...this.pipes])
        {
            pipe.Close(RelayPipe.GoingAway)
        }
        this.pipes.clear()
        // AppendAudit never rejects; a write started while waiting is waited for too.
        while (this.pendingAudits.size > 0)
        {
            await Promise.all([...this.pendingAudits])
        }
    }

    /** Closes the principal's relays (its password changed) except those under `keepSessionId`; returns how many. */
    public ClosePrincipal(tenantId: string, principalId: string, keepSessionId?: string): number
    {
        let closed = 0
        for (const pipe of [...this.pipes])
        {
            const s = pipe.context.session
            if (s.tenantId === tenantId && s.principalId === principalId && s.id !== keepSessionId)
            {
                pipe.Close(RelayPipe.PolicyViolation)
                closed++
            }
        }
        return closed
    }

    /** Closes every relay of the tenant (it was deleted: its sessions are revoked) with a policy close; returns how many. */
    public CloseTenant(tenantId: string): number
    {
        let closed = 0
        for (const pipe of [...this.pipes])
        {
            if (pipe.context.session.tenantId === tenantId)
            {
                pipe.Close(RelayPipe.PolicyViolation)
                closed++
            }
        }
        return closed
    }

    /** Closes the relays opened under session `sessionId` (it signed out) with a normal close; returns how many. */
    public CloseSession(sessionId: string): number
    {
        let closed = 0
        for (const pipe of [...this.pipes])
        {
            if (pipe.context.session.id === sessionId)
            {
                pipe.Close(RelayPipe.NormalClosure)
                closed++
            }
        }
        return closed
    }

    /**
     * Closes every open relay with `code` and returns how many; until Reinstate, a relay still connecting (its dial or session
     * re-check in flight) is closed with `code` as soon as its upgrade completes, so none stays open. Sessions are untouched.
     */
    public Retire(code: number): number
    {
        this.retiredWith = code
        let closed = 0
        for (const pipe of [...this.pipes])
        {
            pipe.Close(code)
            closed++
        }
        return closed
    }

    /** Lifts Retire: relays connect and stay open again. */
    public Reinstate(): void
    {
        this.retiredWith = undefined
    }

    /** Re-homes relays opened under a rotated session so a later ClosePrincipal keeps them. */
    public MoveSession(oldSessionId: string, newSessionId: string): void
    {
        for (const pipe of this.pipes)
        {
            if (pipe.context.session.id === oldSessionId)
            {
                pipe.context.session = { ...pipe.context.session, id: newSessionId }
            }
        }
    }

    /**
     * Revokes a relay's minted credential in its environment once the relay is done with it, so the env's token list does
     * not grow by one row per relay until expiry. Best effort and fire-and-forget: it never blocks or fails a close, and a
     * failure logs only the error's name (the credential then simply expires).
     */
    public RevokeCredential(envName: string, tokenRef: string): void
    {
        const log = (err: unknown): void => console.error(DesktopRelay.RevokeLogPrefix, err instanceof Error ? err.name : typeof err)
        try
        {
            this.service.AdminRevokeToken(envName, tokenRef).catch(log)
        }
        catch (err)
        {
            log(err)
        }
    }

    /** Best-effort audit append: never throws; tracked until done so Close can wait for it. */
    public async Record(actor: string, method: string, path: string, status: number, note?: string): Promise<void>
    {
        const append = this.AppendAudit(actor, method, path, status, note)
        this.pendingAudits.add(append)
        try
        {
            await append
        }
        finally
        {
            this.pendingAudits.delete(append)
        }
    }

    private async AppendAudit(actor: string, method: string, path: string, status: number, note: string | undefined): Promise<void>
    {
        // The relay's outcome does not depend on the audit write.
        await TenantAuditEntry.AppendBestEffort(this.audit, { actor, method, path, status, note })
    }

    /** Leases the env's address, mints the action's credential, dials onward, and only then completes the client upgrade. */
    private async Connect(req: IncomingMessage, socket: Duplex, head: Buffer, context: RelayContext, record: EnvironmentRecord): Promise<void>
    {
        let lease: EnvironmentUrlsLease | undefined
        let upstream: WebSocket
        let credential: TokenIssuedDto | undefined
        try
        {
            lease = await this.endpoints.UrlsFor(record)
            credential = await this.Mint(context.action, record.name)
            upstream = await this.dialer.Dial(lease.wsUrl + DesktopRelay.UpstreamQuery + encodeURIComponent(record.environmentId), credential.token)
        }
        catch (err)
        {
            // A dial refused or reset at the TCP level means the env's tunnel is dead: drop it so the next relay reopens it.
            if (TransportFailure.Is(err))
            {
                lease?.Fail()
            }
            lease?.Release()
            if (credential !== undefined)
            {
                this.RevokeCredential(record.name, credential.tokenRef)
            }
            // Only the error's name: messages from lower layers are not vetted for secret material.
            console.error(DesktopRelay.LogPrefix, err instanceof Error ? err.name : typeof err)
            await this.Refuse(req, socket, DesktopRelay.StatusBadGateway, context.actor, context.action, context.envName)
            return
        }
        const deadlineMs = DesktopRelay.DeadlineOf(context.session, credential)
        const pipe = new RelayPipe(this, context, upstream, lease, () => this.pipes.delete(pipe), this.clock, deadlineMs, credential.tokenRef)
        // The session may have ended while the credential was minted and the upstream dialed (a sign-out or password change
        // whose CloseSession / ClosePrincipal ran before this pipe existed): check again. From here to handleUpgrade there is
        // no await, so a later CloseSession / ClosePrincipal sees the pipe and a socket closing later hits the guard below.
        if (!await this.StillLive(req, context.session))
        {
            pipe.Close(RelayPipe.NormalClosure)
            await this.Refuse(req, socket, DesktopRelay.StatusUnauthorized, context.actor, context.action, context.envName)
            return
        }
        if (socket.destroyed)
        {
            pipe.Close(RelayPipe.GoingAway)
            return
        }
        // The pipe may have closed during that await (its deadline fell due, or the upstream closed or failed): it has
        // already released its lease and revoked its credential, so it is neither tracked nor upgraded; the client gets 502.
        if (pipe.IsClosed)
        {
            await this.Refuse(req, socket, DesktopRelay.StatusBadGateway, context.actor, context.action, context.envName)
            return
        }
        // Retired while this relay connected: it is closed now (lease released, credential revoked, never tracked) and the
        // upgrade completes only so the client sees the retirement code, exactly as the relays Retire closed did.
        const retired = this.retiredWith
        if (retired !== undefined)
        {
            pipe.Close(retired)
            this.wss.handleUpgrade(req, socket, head, client => pipe.Attach(client))
            return
        }
        this.pipes.add(pipe)
        // ws can still abort the handshake without calling back (a bad subprotocol or extension header, a socket that is no
        // longer writable): the socket then closes with no client attached, and the pipe must release its lease and upstream.
        socket.once(DesktopRelay.CloseEvent, () =>
        {
            if (!pipe.IsAttached)
            {
                pipe.Close(RelayPipe.GoingAway)
            }
        })
        this.wss.handleUpgrade(req, socket, head, client => pipe.Attach(client))
    }

    /** Whether the request's bearer still resolves to the same live desktop session. */
    private async StillLive(req: IncomingMessage, session: TenantSession): Promise<boolean>
    {
        try
        {
            return (await this.gate.Principal(req))?.id === session.id
        }
        catch
        {
            return false
        }
    }

    private async Mint(action: DesktopAction, envName: string): Promise<TokenIssuedDto>
    {
        return action === DesktopAction.Contribute
            ? await this.service.AdminIssueMakerToken(envName)
            : await this.service.AdminIssueDeployToken(envName)
    }

    /**
     * When the relay must end (epoch ms): the earlier of the session's expiry and the credential's (a credential without
     * one does not bound it). An unreadable expiry fails closed: the relay ends at once.
     */
    public static DeadlineOf(session: TenantSession, credential: TokenIssuedDto): number
    {
        const sessionMs = Date.parse(session.expiresAt)
        const credentialMs = credential.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(credential.expiresAt)
        const deadline = Math.min(sessionMs, credentialMs)
        return Number.isNaN(deadline) ? Number.NEGATIVE_INFINITY : deadline
    }

    /**
     * Answers a refusal and audits it, but only while the client's address is under the refusal throttle: anonymous or
     * signed in, no one address can flood the shared, capped audit log and evict the contribute and deploy outcome
     * records (those are never throttled).
     */
    private async Refuse(req: IncomingMessage, socket: Duplex, status: number, actor: string, method: string, path: string): Promise<void>
    {
        const ip = TenantClientAddress.Of(req, this.trustedProxy)
        const audited = this.refusalThrottle.CheckAllowed(ip).allowed
        // Counted before the awaited write so a parallel burst cannot slip past the throttle.
        this.refusalThrottle.RecordHit(ip)
        DesktopRelay.WriteRefusal(socket, status)
        if (audited)
        {
            await this.Record(actor, method, path, status)
        }
    }

    /** Writes a plain HTTP refusal on the not-yet-upgraded socket and ends it; `body` defaults to `{ error: <the status's sentence> }`. */
    public static WriteRefusal(socket: Duplex, status: number, body: object = { error: DesktopRelay.Messages.get(status) }): void
    {
        if (socket.destroyed)
        {
            return
        }
        const text = JSON.stringify(body)
        socket.once(DesktopRelay.FinishEvent, () => socket.destroy())
        socket.end(DesktopRelay.HttpVersion + String(status) + DesktopRelay.Space + String(STATUS_CODES[status]) + DesktopRelay.HeaderSeparator
            + DesktopRelay.ResponseHeaders + String(Buffer.byteLength(text)) + DesktopRelay.HeaderSeparator + DesktopRelay.HeaderSeparator + text)
    }

    /** A GET carrying `Upgrade: websocket`, a well-formed Sec-WebSocket-Key, and version 13 or 8. */
    private static IsWebSocketHandshake(req: IncomingMessage): boolean
    {
        const upgrade = req.headers[DesktopRelay.UpgradeHeader]
        const key = req.headers[DesktopRelay.KeyHeader]
        const version = req.headers[DesktopRelay.VersionHeader]
        return req.method === DesktopRelay.MethodGet
            && typeof upgrade === 'string' && upgrade.toLowerCase() === DesktopRelay.WebSocketUpgrade
            && typeof key === 'string' && DesktopRelay.KeyPattern.test(key)
            && typeof version === 'string' && DesktopRelay.Versions.has(version.trim())
    }

    private static QueryOf(req: IncomingMessage): URLSearchParams | undefined
    {
        try
        {
            return new URL(req.url ?? DesktopRelay.Path, DesktopRelay.BaseUrl).searchParams
        }
        catch
        {
            return undefined
        }
    }

    private static ActionOf(raw: string): DesktopAction | undefined
    {
        return (Object.values(DesktopAction) as string[]).includes(raw) ? raw as DesktopAction : undefined
    }
}

/** A forwarded request awaiting its response; `audited` ones are recorded when it arrives (with `note`). */
type InFlightRequest = { method: string; audited: boolean; note?: string }

/**
 * One live relay: the desktop client socket and the environment server socket, piped. Upstream frames that arrive before
 * the client upgrade completes are buffered. Either side closing closes the other; the lease is released exactly once.
 * Once attached, the client is pinged every HeartbeatMs and terminated when the previous ping went unanswered; at the
 * deadline the relay closes with Expired (4001).
 */
class RelayPipe
{
    public static readonly GoingAway = 1001
    public static readonly PolicyViolation = 1008
    public static readonly NormalClosure = 1000
    /** The relay reached its deadline (its desktop session or its minted credential expired): open a new relay. */
    public static readonly Expired = 4001
    /** The console is no longer registered with the platform (DesktopRelay.Retire); its one home is DesktopRelay. */
    public static readonly ConsoleRetired = DesktopRelay.ConsoleRetiredCloseCode
    /** A ping goes out this often; a client that has not answered the previous one by the next is terminated. */
    public static readonly HeartbeatMs = 30_000
    private static readonly PongEvent = 'pong'
    /** At most this many forwarded requests (audited or not) may await an answer on one relay. */
    public static readonly MaxPending = 32
    private static readonly MessageEvent = 'message'
    private static readonly CloseEvent = 'close'
    private static readonly ErrorEvent = 'error'
    private static readonly IdField = 'id'
    private static readonly MethodField = 'method'
    private static readonly ErrorField = 'error'
    private static readonly InternalError = 1011
    private static readonly SendableCodes: ReadonlySet<number> = new Set([1000, 1001, 1003, 1007, 1008, 1009, 1011, 1012, 1013])
    private static readonly MinApplicationCode = 3000
    private static readonly MaxApplicationCode = 4999
    private static readonly JsonRpcVersion = '2.0'
    private static readonly MethodNotFound = -32601
    private static readonly NotAvailableMessage = 'This method is not available through the desktop relay.'
    private static readonly InvalidRequest = -32600
    private static readonly DuplicateIdMessage = 'This request id is already waiting for an answer on the desktop relay.'
    private static readonly InternalErrorCode = -32603
    private static readonly TooManyPendingMessage = 'Too many requests are waiting for an answer on the desktop relay.'
    private static readonly StatusOk = 200
    private static readonly StatusFailed = 500
    private static readonly StatusUnanswered = 502

    private client: WebSocket | undefined
    private readonly buffered: { data: RawData; isBinary: boolean }[] = []
    /** Every forwarded request awaiting its answer, by JSON id: ids stay unique so each answer settles the right one. */
    private readonly pending = new Map<string, InFlightRequest>()
    private readonly allowed: ReadonlySet<string>
    private closed = false
    /** The code Close was given: a client attaching after the close is closed with it. */
    private closedWith: number = RelayPipe.GoingAway
    private awaitingPong = false
    private heartbeat: IRelayTimer | undefined
    private deadline: IRelayTimer | undefined

    public constructor(
        private readonly relay: DesktopRelay,
        public context: RelayContext,
        private readonly upstream: WebSocket,
        private readonly lease: EnvironmentUrlsLease,
        private readonly onClosed: () => void,
        private readonly clock: IRelayClock,
        private readonly deadlineMs: number,
        private readonly credentialRef: string)
    {
        this.allowed = DesktopRelayAllowlist.For(context.action)
        upstream.on(RelayPipe.MessageEvent, (data, isBinary) => this.FromUpstream(data, isBinary))
        upstream.on(RelayPipe.CloseEvent, code => this.Close(RelayPipe.SendableFrom(code)))
        upstream.on(RelayPipe.ErrorEvent, () => this.Close(RelayPipe.InternalError))
        this.ArmDeadline()
    }

    /** Whether the pipe has closed (its lease is released). */
    public get IsClosed(): boolean
    {
        return this.closed
    }

    /** Whether the client upgrade completed (Attach ran). */
    public get IsAttached(): boolean
    {
        return this.client !== undefined
    }

    public Attach(client: WebSocket): void
    {
        if (this.closed)
        {
            client.close(this.closedWith)
            return
        }
        this.client = client
        client.on(RelayPipe.MessageEvent, (data, isBinary) => this.FromClient(data, isBinary))
        client.on(RelayPipe.CloseEvent, () => this.Close(RelayPipe.NormalClosure))
        client.on(RelayPipe.ErrorEvent, () => this.Close(RelayPipe.InternalError))
        client.on(RelayPipe.PongEvent, () => { this.awaitingPong = false })
        for (const frame of this.buffered.splice(0))
        {
            client.send(frame.data, { binary: frame.isBinary })
        }
        this.ArmHeartbeat()
    }

    private ArmHeartbeat(): void
    {
        this.heartbeat = this.clock.Schedule(() => this.Beat(), RelayPipe.HeartbeatMs)
    }

    /** Pings the client, or terminates it when the previous ping is still unanswered (it is gone or half-open). */
    private Beat(): void
    {
        const client = this.client
        if (this.closed || client === undefined)
        {
            return
        }
        if (this.awaitingPong)
        {
            this.Close(RelayPipe.GoingAway)
            client.terminate()
            return
        }
        this.awaitingPong = true
        client.ping()
        this.ArmHeartbeat()
    }

    /** Closes the relay with Expired at the deadline; a timer that fired early (its delay was clamped) re-arms. */
    private ArmDeadline(): void
    {
        this.deadline = this.clock.Schedule(() =>
        {
            if (this.closed)
            {
                return
            }
            if (this.clock.Now() < this.deadlineMs)
            {
                this.ArmDeadline()
                return
            }
            this.Close(RelayPipe.Expired)
        }, this.deadlineMs - this.clock.Now())
    }

    /**
     * Closes both sides once (`code` is what the client sees), releases the lease, revokes the minted credential (best
     * effort), and audits unanswered audited calls.
     */
    public Close(code: number): void
    {
        if (this.closed)
        {
            return
        }
        this.closed = true
        this.closedWith = code
        this.heartbeat?.Cancel()
        this.deadline?.Cancel()
        this.lease.Release()
        this.onClosed()
        RelayPipe.CloseSocket(this.client, code)
        RelayPipe.CloseSocket(this.upstream, RelayPipe.NormalClosure)
        this.relay.RevokeCredential(this.context.envName, this.credentialRef)
        for (const entry of [...this.pending.values()].filter(e => e.audited))
        {
            void this.relay.Record(this.context.actor, this.context.action, this.context.envName, RelayPipe.StatusUnanswered, entry.note)
        }
        this.pending.clear()
    }

    private FromClient(data: RawData, isBinary: boolean): void
    {
        const message = isBinary ? undefined : RelayPipe.ParseObject(String(data))
        if (message === undefined)
        {
            this.Close(RelayPipe.PolicyViolation)
            return
        }
        const method = message.method
        if (typeof method !== 'string')
        {
            // A client response (the environment server sends the desktop flows no requests): nothing to forward.
            return
        }
        if (!Object.hasOwn(message, RelayPipe.IdField))
        {
            // A notification: neither action's flow sends one, and it could not be audited, so none is forwarded.
            return
        }
        if (!this.allowed.has(method))
        {
            this.Reject(message.id, RelayPipe.MethodNotFound, RelayPipe.NotAvailableMessage)
            return
        }
        const key = JSON.stringify(message.id)
        if (this.pending.has(key))
        {
            // A reused id would make the answer ambiguous (any method), so the audit could miss or misname a call.
            this.Reject(message.id, RelayPipe.InvalidRequest, RelayPipe.DuplicateIdMessage)
            return
        }
        if (this.pending.size >= RelayPipe.MaxPending)
        {
            this.Reject(message.id, RelayPipe.InternalErrorCode, RelayPipe.TooManyPendingMessage)
            return
        }
        const noteField = DesktopRelayAllowlist.NoteFieldOf(method)
        this.pending.set(key, noteField === undefined
            ? { method, audited: false }
            : { method, audited: true, note: RelayPipe.NoteOf(message.params, noteField) })
        this.upstream.send(String(data))
    }

    /** Answers a client request here with a JSON-RPC error; it is never forwarded. */
    private Reject(id: unknown, code: number, message: string): void
    {
        this.client?.send(JSON.stringify({ jsonrpc: RelayPipe.JsonRpcVersion, id, error: { code, message } }))
    }

    private FromUpstream(data: RawData, isBinary: boolean): void
    {
        if (this.pending.size > 0 && !isBinary)
        {
            this.Settle(String(data))
        }
        if (this.client === undefined)
        {
            this.buffered.push({ data, isBinary })
            return
        }
        this.client.send(data, { binary: isBinary })
    }

    /** Settles the in-flight request an upstream answer is for, auditing its outcome when it is an audited one. */
    private Settle(text: string): void
    {
        const message = RelayPipe.ParseObject(text)
        if (message === undefined || Object.hasOwn(message, RelayPipe.MethodField) || !Object.hasOwn(message, RelayPipe.IdField))
        {
            return
        }
        const key = JSON.stringify(message.id)
        const entry = this.pending.get(key)
        if (entry === undefined)
        {
            return
        }
        this.pending.delete(key)
        if (!entry.audited)
        {
            return
        }
        const failed = Object.hasOwn(message, RelayPipe.ErrorField) || DesktopRelayAllowlist.IsInBandFailure(entry.method, message.result)
        void this.relay.Record(this.context.actor, this.context.action, this.context.envName, failed ? RelayPipe.StatusFailed : RelayPipe.StatusOk, entry.note)
    }

    /** A single JSON-RPC message object; undefined for non-JSON, a batch (array), or a scalar. */
    private static ParseObject(text: string): Record<string, unknown> | undefined
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            return undefined
        }
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    }

    private static NoteOf(params: unknown, field: string): string | undefined
    {
        const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>)[field] : undefined
        return typeof value === 'string' ? value : undefined
    }

    /** A close code the relay may itself send on: reserved ones (1005, 1006, 1015, ...) become 1011. */
    private static SendableFrom(code: number): number
    {
        const application = code >= RelayPipe.MinApplicationCode && code <= RelayPipe.MaxApplicationCode
        return application || RelayPipe.SendableCodes.has(code) ? code : RelayPipe.InternalError
    }

    private static CloseSocket(ws: WebSocket | undefined, code: number): void
    {
        if (ws === undefined || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)
        {
            return
        }
        ws.close(code)
    }
}
