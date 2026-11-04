import { STATUS_CODES, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { ApplicationDeployProtocol, AppWriteStatus, GraphProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AuditRegistry } from '../audit-record.js'
import { AuditThrottle } from '../audit-throttle.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import type { EnvironmentEndpoints, EnvironmentUrlsLease } from '../environment-endpoints.js'
import type { EnvironmentRecord } from '../environment-record.js'
import { PlaneHttp } from '../plane-http.js'
import { DesktopAction, DesktopTargetVerdict, type DesktopTargets } from './desktop-targets.js'
import type { DesktopAuthGate } from './desktop-auth-gate.js'
import type { IDesktopSessionConnections } from './desktop-endpoint.js'
import type { IPrincipalConnections } from './tenant-principal-sessions.js'
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
 * minting failed, or the environment server refused the dial). Each refusal is audited with its HTTP status (anonymous
 * refusals under a per-address throttle, so an unauthenticated flood cannot churn the log), and each forwarded contribute or
 * deploy is audited once when its response returns (200, or 500 for an error or a non-applied deploy; 502 if the relay
 * closed first). The tunnel lease is held for the whole relay and released exactly once. Neither the desktop token nor
 * the minted credential is ever logged, audited or echoed.
 */
export class DesktopRelay implements IPrincipalConnections, IDesktopSessionConnections
{
    public static readonly Path = '/desktop/relay'
    private static readonly BaseUrl = 'http://localhost'
    private static readonly EnvironmentParam = 'environment'
    private static readonly ActionParam = 'action'
    private static readonly UpstreamQuery = '/?environment='
    private static readonly ActorSeparator = '/'
    private static readonly NoValue = ''
    private static readonly MaxAuditField = 128
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

    public constructor(
        private readonly gate: DesktopAuthGate,
        private readonly targets: DesktopTargets,
        private readonly service: IEnvironmentService,
        private readonly endpoints: EnvironmentEndpoints,
        private readonly audit: AuditRegistry,
        private readonly dialer: IUpstreamDialer = new WsUpstreamDialer(),
        private readonly anonymousThrottle: AuditThrottle = new AuditThrottle(),
        private readonly trustedProxy: boolean = false)
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
            await this.RefuseAnonymous(req, socket, DesktopRelay.StatusBadRequest, rawAction, rawEnv)
            return
        }
        // Desktop-only like the rest of `/desktop/*`: a browser page always sends Origin on a WebSocket, so it is refused.
        if (req.headers[PlaneHttp.OriginHeader] !== undefined)
        {
            await this.RefuseAnonymous(req, socket, DesktopRelay.StatusForbidden, rawAction, rawEnv)
            return
        }
        let session: TenantSession | null
        try
        {
            session = await this.gate.Principal(req)
        }
        catch
        {
            await this.Refuse(socket, DesktopRelay.StatusInternal, AuditRegistry.AnonymousActor, rawAction, rawEnv)
            return
        }
        if (session === null)
        {
            await this.RefuseAnonymous(req, socket, DesktopRelay.StatusUnauthorized, rawAction, rawEnv)
            return
        }
        const actor = DesktopRelay.ActorOf(session)
        const action = DesktopRelay.ActionOf(rawAction)
        if (action === undefined || rawEnv === DesktopRelay.NoValue)
        {
            await this.Refuse(socket, DesktopRelay.StatusBadRequest, actor, rawAction, rawEnv)
            return
        }
        let record: EnvironmentRecord
        try
        {
            const check = await this.targets.Check(session, rawEnv, action)
            if (check.verdict !== DesktopTargetVerdict.Allowed || check.record === undefined)
            {
                const status = check.verdict === DesktopTargetVerdict.NotRunning ? DesktopRelay.StatusConflict : DesktopRelay.StatusForbidden
                await this.Refuse(socket, status, actor, action, rawEnv)
                return
            }
            record = check.record
        }
        catch
        {
            await this.Refuse(socket, DesktopRelay.StatusInternal, actor, action, rawEnv)
            return
        }
        await this.Connect(req, socket, head, { session, actor, action, envName: record.name }, record)
    }

    /** Ends every open relay (the tenant listener is closing). */
    public Close(): void
    {
        for (const pipe of [...this.pipes])
        {
            pipe.Close(RelayPipe.GoingAway)
        }
        this.pipes.clear()
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

    /** Best-effort audit append: never throws. */
    public async Record(actor: string, method: string, path: string, status: number, note?: string): Promise<void>
    {
        const entry = { actor, method: DesktopRelay.Clip(method), path: DesktopRelay.Clip(path), status, at: new Date().toISOString() }
        try
        {
            await this.audit.Append(note === undefined ? entry : { ...entry, note: DesktopRelay.Clip(note) })
        }
        catch
        {
            // The relay's outcome does not depend on the audit write.
        }
    }

    /** Leases the env's address, mints the action's credential, dials onward, and only then completes the client upgrade. */
    private async Connect(req: IncomingMessage, socket: Duplex, head: Buffer, context: RelayContext, record: EnvironmentRecord): Promise<void>
    {
        let lease: EnvironmentUrlsLease | undefined
        let upstream: WebSocket
        try
        {
            lease = await this.endpoints.UrlsFor(record)
            const credential = await this.Mint(context.action, record.name)
            upstream = await this.dialer.Dial(lease.wsUrl + DesktopRelay.UpstreamQuery + encodeURIComponent(record.environmentId), credential)
        }
        catch (err)
        {
            lease?.Release()
            // Only the error's name: messages from lower layers are not vetted for secret material.
            console.error(DesktopRelay.LogPrefix, err instanceof Error ? err.name : typeof err)
            await this.Refuse(socket, DesktopRelay.StatusBadGateway, context.actor, context.action, context.envName)
            return
        }
        const pipe = new RelayPipe(this, context, upstream, lease, () => this.pipes.delete(pipe))
        // The session may have ended while the credential was minted and the upstream dialed (a sign-out or password change
        // whose CloseSession / ClosePrincipal ran before this pipe existed): check again. From here to handleUpgrade there is
        // no await, so a later CloseSession / ClosePrincipal sees the pipe and a socket closing later hits the guard below.
        if (!await this.StillLive(req, context.session))
        {
            pipe.Close(RelayPipe.NormalClosure)
            await this.Refuse(socket, DesktopRelay.StatusUnauthorized, context.actor, context.action, context.envName)
            return
        }
        if (socket.destroyed)
        {
            pipe.Close(RelayPipe.GoingAway)
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

    private async Mint(action: DesktopAction, envName: string): Promise<string>
    {
        const issued = action === DesktopAction.Contribute
            ? await this.service.AdminIssueMakerToken(envName)
            : await this.service.AdminIssueDeployToken(envName)
        return issued.token
    }

    /** A refusal before any principal is known: audited as anonymous, but only while the address is under the throttle. */
    private async RefuseAnonymous(req: IncomingMessage, socket: Duplex, status: number, rawAction: string, rawEnv: string): Promise<void>
    {
        const ip = TenantClientAddress.Of(req, this.trustedProxy)
        const audited = this.anonymousThrottle.CheckAllowed(ip).allowed
        // Counted before the awaited write so a parallel burst cannot slip past the throttle.
        this.anonymousThrottle.RecordHit(ip)
        DesktopRelay.WriteRefusal(socket, status)
        if (audited)
        {
            await this.Record(AuditRegistry.AnonymousActor, rawAction, rawEnv, status)
        }
    }

    private async Refuse(socket: Duplex, status: number, actor: string, method: string, path: string): Promise<void>
    {
        DesktopRelay.WriteRefusal(socket, status)
        await this.Record(actor, method, path, status)
    }

    /** Writes a plain HTTP refusal on the not-yet-upgraded socket and ends it. */
    private static WriteRefusal(socket: Duplex, status: number): void
    {
        if (socket.destroyed)
        {
            return
        }
        const body = JSON.stringify({ error: DesktopRelay.Messages.get(status) })
        socket.once(DesktopRelay.FinishEvent, () => socket.destroy())
        socket.end(DesktopRelay.HttpVersion + String(status) + DesktopRelay.Space + String(STATUS_CODES[status]) + DesktopRelay.HeaderSeparator
            + DesktopRelay.ResponseHeaders + String(Buffer.byteLength(body)) + DesktopRelay.HeaderSeparator + DesktopRelay.HeaderSeparator + body)
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

    private static ActorOf(session: TenantSession): string
    {
        return session.tenantId + DesktopRelay.ActorSeparator + (session.email ?? session.principalId)
    }

    private static Clip(text: string): string
    {
        return text.length > DesktopRelay.MaxAuditField ? text.slice(0, DesktopRelay.MaxAuditField) : text
    }
}

/** A forwarded request awaiting its response; `audited` ones are recorded when it arrives (with `note`). */
type InFlightRequest = { method: string; audited: boolean; note?: string }

/**
 * One live relay: the desktop client socket and the environment server socket, piped. Upstream frames that arrive before
 * the client upgrade completes are buffered. Either side closing closes the other; the lease is released exactly once.
 */
class RelayPipe
{
    public static readonly GoingAway = 1001
    public static readonly PolicyViolation = 1008
    public static readonly NormalClosure = 1000
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

    public constructor(
        private readonly relay: DesktopRelay,
        public context: RelayContext,
        private readonly upstream: WebSocket,
        private readonly lease: EnvironmentUrlsLease,
        private readonly onClosed: () => void)
    {
        this.allowed = DesktopRelayAllowlist.For(context.action)
        upstream.on(RelayPipe.MessageEvent, (data, isBinary) => this.FromUpstream(data, isBinary))
        upstream.on(RelayPipe.CloseEvent, code => this.Close(RelayPipe.SendableFrom(code)))
        upstream.on(RelayPipe.ErrorEvent, () => this.Close(RelayPipe.InternalError))
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
            client.close(RelayPipe.GoingAway)
            return
        }
        this.client = client
        client.on(RelayPipe.MessageEvent, (data, isBinary) => this.FromClient(data, isBinary))
        client.on(RelayPipe.CloseEvent, () => this.Close(RelayPipe.NormalClosure))
        client.on(RelayPipe.ErrorEvent, () => this.Close(RelayPipe.InternalError))
        for (const frame of this.buffered.splice(0))
        {
            client.send(frame.data, { binary: frame.isBinary })
        }
    }

    /** Closes both sides once (`code` is what the client sees), releases the lease, and audits unanswered audited calls. */
    public Close(code: number): void
    {
        if (this.closed)
        {
            return
        }
        this.closed = true
        this.lease.Release()
        this.onClosed()
        RelayPipe.CloseSocket(this.client, code)
        RelayPipe.CloseSocket(this.upstream, RelayPipe.NormalClosure)
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
