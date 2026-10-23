import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { EnvironmentDto, HiveDto, HiveHealthDto, HiveRolloutDto, ManifestDto, SessionDto, TenantEvent } from '../src/tenant-types.js'

// Serves the built dist/ statically and fakes the 7a tenant surface with canned
// data, recording every mutating call. GATED: used only by the Playwright spec.
export class FakeTenantControlPlane
{
    public static readonly HiveOneId = 'hive-1'
    public static readonly HiveOneName = 'Production Hive'
    public static readonly HiveTwoId = 'hive-2'
    public static readonly HiveTwoName = 'Staging Hive'
    public static readonly EnvOneName = 'alpha-env'
    public static readonly EnvTwoName = 'beta-env'
    public static readonly OlderVersion = 'v1'
    public static readonly CurrentVersion = 'v2'
    public static readonly NewerVersion = 'v3'
    public static readonly TenantId = 'tenant-1'
    public static readonly PrincipalId = 'principal-1'
    public static readonly UserEmail = 'owner@example.com'
    public static readonly RunningStatus = 'running'
    public static readonly StoppedStatus = 'stopped'
    public static readonly StartAction = 'start'

    private static readonly SessionPath = '/tenant-auth/session'
    private static readonly HivesPath = '/tenant-api/hives'
    private static readonly EnvironmentsPath = '/tenant-api/environments'
    private static readonly ManifestsPath = '/tenant-api/manifests'
    private static readonly EventsPath = '/tenant-api/events'
    private static readonly HivePrefix = '/tenant-api/hives/'
    private static readonly EnvPrefix = '/tenant-api/environments/'
    private static readonly RolloutLeaf = 'rollout'
    private static readonly HealthLeaf = 'health'
    private static readonly TargetLeaf = 'target'
    private static readonly LogsSuffix = '/logs/stream'
    private static readonly Actions = ['start', 'stop', 'restart']
    private static readonly PathSeparator = '/'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly UpgradeEvent = 'upgrade'
    private static readonly CloseEvent = 'close'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly Utf8 = 'utf8'
    private static readonly QuerySeparator = '?'
    private static readonly Empty = ''
    private static readonly RootPath = '/'
    private static readonly IndexFile = 'index.html'
    private static readonly ParentSegment = '..'
    private static readonly HostLocal = '127.0.0.1'
    private static readonly JsonType = 'application/json'
    private static readonly DefaultType = 'application/octet-stream'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly CreatedAt = '2026-01-01T00:00:00.000Z'
    private static readonly Types: Record<string, string> =
    {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
    }

    public readonly TargetCalls: Array<{ subject: string; version: string }> = []
    public readonly LifecycleCalls: Array<{ subject: string; action: string }> = []
    private readonly root = fileURLToPath(new URL('../dist/', import.meta.url))
    private readonly eventSockets = new Set<WebSocket>()
    private readonly logSockets = new Map<string, Set<WebSocket>>()
    private readonly eventServer = new WebSocketServer({ noServer: true })
    private readonly logServer = new WebSocketServer({ noServer: true })
    private server: Server | undefined

    public async Start(): Promise<string>
    {
        this.server = createServer((req, res) => { void this.Handle(req, res) })
        this.server.on(FakeTenantControlPlane.UpgradeEvent, (req: IncomingMessage, socket: Duplex, head: Buffer) => { this.Upgrade(req, socket, head) })
        await new Promise<void>(resolve => this.server!.listen(0, FakeTenantControlPlane.HostLocal, resolve))
        const addr = this.server.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        return `http://${FakeTenantControlPlane.HostLocal}:${port}`
    }

    public async Stop(): Promise<void>
    {
        for (const s of this.eventSockets)
        {
            s.terminate()
        }
        for (const set of this.logSockets.values())
        {
            for (const s of set)
            {
                s.terminate()
            }
        }
        this.server?.closeAllConnections()
        await new Promise<void>(resolve => this.server?.close(() => resolve()))
    }

    // Pushes a TenantEvent frame to every connected events socket; returns how many received it.
    public PushEvent(ev: TenantEvent): number
    {
        const text = JSON.stringify(ev)
        for (const s of this.eventSockets)
        {
            s.send(text)
        }
        return this.eventSockets.size
    }

    // Pushes a raw log chunk to the sockets following the named environment; returns how many received it.
    public PushLog(envName: string, chunk: string): number
    {
        const set = this.logSockets.get(envName) ?? new Set<WebSocket>()
        for (const s of set)
        {
            s.send(chunk)
        }
        return set.size
    }

    public LogSocketCount(envName: string): number
    {
        return this.logSockets.get(envName)?.size ?? 0
    }

    public EventSocketCount(): number
    {
        return this.eventSockets.size
    }

    private Upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
    {
        const path = (req.url ?? FakeTenantControlPlane.RootPath).split(FakeTenantControlPlane.QuerySeparator)[0]!
        if (path === FakeTenantControlPlane.EventsPath)
        {
            this.eventServer.handleUpgrade(req, socket, head, ws =>
            {
                this.eventSockets.add(ws)
                ws.on(FakeTenantControlPlane.CloseEvent, () => { this.eventSockets.delete(ws) })
            })
            return
        }
        const name = this.LogEnvName(path)
        if (name !== undefined)
        {
            this.logServer.handleUpgrade(req, socket, head, ws =>
            {
                const set = this.logSockets.get(name) ?? new Set<WebSocket>()
                set.add(ws)
                this.logSockets.set(name, set)
                ws.on(FakeTenantControlPlane.CloseEvent, () => { set.delete(ws) })
            })
            return
        }
        socket.destroy()
    }

    private LogEnvName(path: string): string | undefined
    {
        if (!path.startsWith(FakeTenantControlPlane.EnvPrefix) || !path.endsWith(FakeTenantControlPlane.LogsSuffix))
        {
            return undefined
        }
        return decodeURIComponent(path.slice(FakeTenantControlPlane.EnvPrefix.length, path.length - FakeTenantControlPlane.LogsSuffix.length))
    }

    private Hives(): HiveDto[]
    {
        return [
            this.Hive(FakeTenantControlPlane.HiveOneId, FakeTenantControlPlane.HiveOneName),
            this.Hive(FakeTenantControlPlane.HiveTwoId, FakeTenantControlPlane.HiveTwoName),
        ]
    }

    private Hive(id: string, displayName: string): HiveDto
    {
        return {
            id,
            tenantId: FakeTenantControlPlane.TenantId,
            displayName,
            cluster: { backend: 'docker', mode: 'shared' },
            registry: { mode: 'shared' },
            createdAt: FakeTenantControlPlane.CreatedAt,
        }
    }

    private Env(name: string, hiveId: string, status: string): EnvironmentDto
    {
        return {
            name,
            template: 'dev-blank',
            type: 'runtime',
            environmentId: `${name}-id`,
            hiveId,
            tenantId: FakeTenantControlPlane.TenantId,
            hostPort: 4101,
            status,
            createdAt: FakeTenantControlPlane.CreatedAt,
            httpUrl: 'http://localhost:4101',
            wsUrl: 'ws://localhost:4101/',
        }
    }

    private Environments(): EnvironmentDto[]
    {
        return [
            this.Env(FakeTenantControlPlane.EnvOneName, FakeTenantControlPlane.HiveOneId, FakeTenantControlPlane.RunningStatus),
            this.Env(FakeTenantControlPlane.EnvTwoName, FakeTenantControlPlane.HiveTwoId, FakeTenantControlPlane.StoppedStatus),
        ]
    }

    // By publishedAt: v3 newest (available), v2 current, v1 previous.
    private Manifests(): ManifestDto[]
    {
        return [
            { id: FakeTenantControlPlane.OlderVersion, image: 'app:1', publishedAt: '2026-01-01T00:00:00.000Z' },
            { id: FakeTenantControlPlane.CurrentVersion, image: 'app:2', publishedAt: '2026-02-01T00:00:00.000Z' },
            { id: FakeTenantControlPlane.NewerVersion, image: 'app:3', publishedAt: '2026-03-01T00:00:00.000Z' },
        ]
    }

    private Rollout(hiveId: string): HiveRolloutDto
    {
        const envs = this.Environments().filter(e => e.hiveId === hiveId)
        return {
            targetVersion: FakeTenantControlPlane.CurrentVersion,
            environments: envs.map(e => ({ environmentName: e.name, runningImage: 'app:2', obsolete: false, ready: true })),
        }
    }

    private Health(hiveId: string): HiveHealthDto[]
    {
        return this.Environments().filter(e => e.hiveId === hiveId)
            .map(e => ({ environmentName: e.name, ready: true, runningImage: 'app:2', detail: FakeTenantControlPlane.Empty }))
    }

    private static ReadBody(req: IncomingMessage): Promise<string>
    {
        return new Promise(resolve =>
        {
            const chunks: Buffer[] = []
            req.on(FakeTenantControlPlane.DataEvent, (c: Buffer) => { chunks.push(c) })
            req.on(FakeTenantControlPlane.EndEvent, () => { resolve(Buffer.concat(chunks).toString(FakeTenantControlPlane.Utf8)) })
        })
    }

    private static Json(res: ServerResponse, status: number, body: unknown): void
    {
        res.writeHead(status, { [FakeTenantControlPlane.ContentTypeHeader]: FakeTenantControlPlane.JsonType })
        res.end(JSON.stringify(body))
    }

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const method = req.method ?? FakeTenantControlPlane.MethodGet
        const path = (req.url ?? FakeTenantControlPlane.RootPath).split(FakeTenantControlPlane.QuerySeparator)[0]!
        if (path === FakeTenantControlPlane.SessionPath)
        {
            const session: SessionDto = { tenantId: FakeTenantControlPlane.TenantId, principalId: FakeTenantControlPlane.PrincipalId, email: FakeTenantControlPlane.UserEmail }
            FakeTenantControlPlane.Json(res, 200, session)
            return
        }
        if (path === FakeTenantControlPlane.HivesPath)
        {
            FakeTenantControlPlane.Json(res, 200, this.Hives())
            return
        }
        if (path === FakeTenantControlPlane.EnvironmentsPath)
        {
            FakeTenantControlPlane.Json(res, 200, this.Environments())
            return
        }
        if (path === FakeTenantControlPlane.ManifestsPath)
        {
            FakeTenantControlPlane.Json(res, 200, this.Manifests())
            return
        }
        if (path.startsWith(FakeTenantControlPlane.HivePrefix))
        {
            await this.HandleHive(method, path, req, res)
            return
        }
        if (path.startsWith(FakeTenantControlPlane.EnvPrefix))
        {
            await this.HandleEnvironment(method, path, req, res)
            return
        }
        await this.Serve(path, res)
    }

    private async HandleHive(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const [rawId, leaf] = path.slice(FakeTenantControlPlane.HivePrefix.length).split(FakeTenantControlPlane.PathSeparator)
        const id = decodeURIComponent(rawId ?? FakeTenantControlPlane.Empty)
        if (leaf === FakeTenantControlPlane.RolloutLeaf)
        {
            FakeTenantControlPlane.Json(res, 200, this.Rollout(id))
        }
        else if (leaf === FakeTenantControlPlane.HealthLeaf)
        {
            FakeTenantControlPlane.Json(res, 200, this.Health(id))
        }
        else if (leaf === FakeTenantControlPlane.TargetLeaf && method === FakeTenantControlPlane.MethodPost)
        {
            const body = JSON.parse(await FakeTenantControlPlane.ReadBody(req)) as { version: string }
            this.TargetCalls.push({ subject: id, version: body.version })
            res.writeHead(204)
            res.end()
        }
        else
        {
            res.writeHead(404)
            res.end()
        }
    }

    private async HandleEnvironment(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const [rawName, action] = path.slice(FakeTenantControlPlane.EnvPrefix.length).split(FakeTenantControlPlane.PathSeparator)
        const name = decodeURIComponent(rawName ?? FakeTenantControlPlane.Empty)
        const env = this.Environments().find(e => e.name === name)
        if (env === undefined || action === undefined || !FakeTenantControlPlane.Actions.includes(action) || method !== FakeTenantControlPlane.MethodPost)
        {
            res.writeHead(404)
            res.end()
            return
        }
        await FakeTenantControlPlane.ReadBody(req)
        this.LifecycleCalls.push({ subject: name, action })
        FakeTenantControlPlane.Json(res, 200, env)
    }

    private async Serve(path: string, res: ServerResponse): Promise<void>
    {
        const rel = path === FakeTenantControlPlane.RootPath ? FakeTenantControlPlane.IndexFile : normalize(path).slice(1)
        if (rel.startsWith(FakeTenantControlPlane.ParentSegment))
        {
            res.writeHead(404)
            res.end()
            return
        }
        try
        {
            const body = await readFile(join(this.root, rel))
            res.writeHead(200, { [FakeTenantControlPlane.ContentTypeHeader]: FakeTenantControlPlane.Types[extname(rel)] ?? FakeTenantControlPlane.DefaultType })
            res.end(body)
        }
        catch
        {
            res.writeHead(404)
            res.end()
        }
    }
}
