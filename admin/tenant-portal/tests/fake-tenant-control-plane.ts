import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { EnvStatus, EnvType, SecurityRoleKind, Template, TeamMemberOrigin, TenantEventType } from '../src/tenant-types.js'
import type { AccountDto, EnvironmentDto, GrantDto, GrantMutationDto, HiveDto, HiveHealthDto, HiveRolloutDto, ManifestDto, SecurityCatalogDto, SecurityChangesDto, SecurityModelDto, ServiceTokenSummaryDto, SessionDto, TeamMemberDto, TenantEvent, TenantProfileDto } from '../src/tenant-types.js'

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
    public static readonly OrganisationName = 'Example Org'
    public static readonly OwnerRoleLabel = 'Tenant owner'
    public static readonly OwnerContact = 'owner-contact@example.com'
    public static readonly TenantDisplayName = 'Example Tenant'
    public static readonly HiveDisplayName = 'Example Hive'
    public static readonly RunningStatus = 'running'
    public static readonly StoppedStatus = 'stopped'
    public static readonly StartAction = 'start'
    public static readonly CurrentImage = 'app:2'
    public static readonly ChangedStatus = 'degraded'

    private static readonly SessionPath = '/tenant-auth/session'
    public static readonly LogoutPath = '/tenant-auth/logout'
    // The own-password change: WrongCurrentPassword is refused (403), ThrottledPassword throttled (429), any other accepted.
    public static readonly PasswordPath = '/tenant-auth/password'
    public static readonly WrongCurrentPassword = 'e2e-not-the-password'
    public static readonly WrongPasswordError = 'The current password is not correct.'
    public static readonly BeginLoginPath = '/tenant-auth/oidc/begin'
    public static readonly IdpPageText = 'Identity provider sign-in (e2e stub)'
    private static readonly IdpPage = '<!doctype html><title>IdP</title><p>Identity provider sign-in (e2e stub)</p>'
    private static readonly HtmlType = 'text/html'
    private static readonly LedgerLeaf = 'ledger'
    private static readonly UnauthorizedMessage = 'unauthorized'
    private static readonly AdoptedAction = 'adopted'
    private static readonly AdoptedAt = '2026-02-02T10:30:00.000Z'
    private static readonly FontExt = '.woff2'
    private static readonly ProfilePath = '/tenant-api/profile'
    private static readonly HivesPath = '/tenant-api/hives'
    private static readonly EnvironmentsPath = '/tenant-api/environments'
    private static readonly BadRequestMessage = 'bad request'
    private static readonly CreatedIdSuffix = '-created-id'
    private static readonly ManifestsPath = '/tenant-api/manifests'
    private static readonly EventsPath = '/tenant-api/events'
    private static readonly HivePrefix = '/tenant-api/hives/'
    private static readonly EnvPrefix = '/tenant-api/environments/'
    private static readonly RolloutLeaf = 'rollout'
    private static readonly HealthLeaf = 'health'
    private static readonly TargetLeaf = 'target'
    private static readonly AdminSegment = 'admin'
    private static readonly SnapshotLeaf = 'snapshot'
    private static readonly AccountsLeaf = 'accounts'
    private static readonly GrantsLeaf = 'grants'
    private static readonly TokensLeaf = 'tokens'
    private static readonly SecurityModelLeaf = 'security-model'
    private static readonly SecurityCatalogLeaf = 'security-catalog'
    private static readonly TeamMembersLeaf = 'team-members'
    private static readonly SecurityChangesLeaf = 'security-changes'
    public static readonly IssuedTokenValue = 'fake-secret-token'
    public static readonly MethodDelete = 'DELETE'
    private static readonly MethodPut = 'PUT'
    private static readonly AdminMarker = '/admin/'
    private static readonly TenantKind = 'Tenant'
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
        '.woff2': 'font/woff2',
    }

    public readonly TargetCalls: Array<{ subject: string; version: string }> = []
    // False: /tenant-auth/session answers 401 (the portal redirects to the IdP).
    public Authenticated = true
    // When set, /tenant-auth/session fails with this status (not a 401).
    public SessionFailureStatus: number | undefined
    public static readonly SessionFailureMessage = 'session store unavailable'
    public LogoutCalls = 0
    public BeginLoginCalls = 0
    // Each own-password change body, in call order.
    public readonly PasswordCalls: unknown[] = []
    public readonly DeletedEnvironments: string[] = []
    // Every static file requested but missing from dist/, and every theme font served.
    public readonly NotFound: string[] = []
    public readonly FontsServed: string[] = []
    public EnvironmentsRequests = 0
    // Names of environments created through the POST route, for e2e assertions.
    public readonly CreatedEnvironments: string[] = []
    // When set, the next environments list reports alpha-env with this status.
    public AlphaStatusOverride: string | undefined
    // When true the environments list is empty (drives the honest empty state).
    public EmptyEnvironments = false
    public readonly Accounts: AccountDto[] =
    [
        { principalId: 'owner-1', email: 'owner@example.com', disabled: false },
        { principalId: 'editor-1', email: 'editor@example.com', disabled: false },
    ]
    public readonly Grants: GrantDto[] =
    [
        { subject: 'owner-1', role: 'Owner', resourceKind: 'Tenant', resourcePath: [] },
        { subject: 'editor-1', role: 'Editor', resourceKind: 'Tenant', resourcePath: [] },
    ]
    public readonly Tokens: ServiceTokenSummaryDto[] =
    [
        { tokenRef: 'ref-1', principalId: 'svc-1', scopes: ['read'], expiresAt: null, revoked: false },
    ]
    // The C5 setting: a root unit holding the owner as System Administrator, one team.
    public SecurityModel: SecurityModelDto =
    {
        businessUnits: [{ id: 'root', name: 'Root' }],
        users: [{ principalId: 'owner-1', businessUnitId: 'root' }],
        teams: [{ id: 'team-1', name: 'Core', businessUnitId: 'root', idpGroups: ['core-group'], manualMembers: ['editor-1'] }],
        roleAssignments: [{ role: 'SystemAdministrator', principalIds: ['owner-1'], teamIds: [] }],
        profileAssignments: [],
        roleOverrides: [],
        profileOverrides: [],
    }
    // The environment's catalog: the three base roles and the `projects` package's roles.
    public SecurityCatalog: SecurityCatalogDto =
    {
        roles:
        [
            { name: 'SystemAdministrator', kind: SecurityRoleKind.Base, defaults: [] },
            { name: 'BasicUser', kind: SecurityRoleKind.Base, defaults: [{ action: 'read', concept: 'projects.Project', level: 'user' }] },
            { name: 'Reader', kind: SecurityRoleKind.Base, defaults: [{ action: 'read', concept: 'projects.Project', level: 'organization' }] },
            { name: 'projects.ProjectManager', kind: SecurityRoleKind.Package, package: 'projects', defaults: [{ action: 'read', concept: 'projects.Project', level: 'businessUnitAndChildren' }] },
            { name: 'projects.ProjectMember', kind: SecurityRoleKind.Package, package: 'projects', defaults: [{ action: 'read', concept: 'projects.Task', level: 'user' }] },
        ],
        concepts:
        [
            { name: 'projects.Project', package: 'projects', owned: true },
            { name: 'projects.Task', package: 'projects', owned: true },
            { name: 'projects.Category', package: 'projects', owned: false },
        ],
        securedFields: [{ concept: 'projects.Project', field: 'Budget' }],
        profiles: [{ name: 'projects.Finance', package: 'projects', defaults: [{ concept: 'projects.Project', field: 'Budget', read: true, update: false, create: false }] }],
    }
    // Each team's members as the server reports them (synced via an IdP group link, or manual).
    public readonly TeamMembers = new Map<string, TeamMemberDto[]>(
    [
        ['team-1', [{ principalId: 'owner-1', origin: TeamMemberOrigin.Synced }, { principalId: 'editor-1', origin: TeamMemberOrigin.Manual }]],
    ])
    // The change log: what each deploy changed in the security defaults.
    public readonly SecurityChanges: SecurityChangesDto[] =
    [
        {
            at: '2026-01-02T00:00:00.000Z', delivery: 'projects', version: '1.1.0',
            roleDefaults: [{ role: 'BasicUser', concept: 'projects.Project', action: 'read', before: 'none', after: 'user' }],
            profileDefaults: [], securedFieldsAdded: [{ concept: 'projects.Project', field: 'Budget' }], securedFieldsRemoved: [],
            roleOverridesDropped: [], profileOverridesDropped: [], rolesRemoved: [], profilesRemoved: [],
        },
    ]
    public readonly AdminCalls: Array<{ env: string; method: string; leaf: string; body: unknown }> = []
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
        this.eventServer.close()
        this.logServer.close()
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

    private Env(name: string, hiveId: string, status: string, template: Template = Template.DevBlank, type: EnvType = EnvType.Runtime, environmentId = `${name}-id`): EnvironmentDto
    {
        return {
            name,
            template,
            type,
            environmentId,
            hiveId,
            tenantId: FakeTenantControlPlane.TenantId,
            hostPort: 4101,
            status: status as EnvStatus,
            createdAt: FakeTenantControlPlane.CreatedAt,
            httpUrl: 'http://localhost:4101',
            wsUrl: 'ws://localhost:4101/',
        }
    }

    private Environments(): EnvironmentDto[]
    {
        if (this.EmptyEnvironments)
        {
            return []
        }
        return [
            this.Env(FakeTenantControlPlane.EnvOneName, FakeTenantControlPlane.HiveOneId, this.AlphaStatusOverride ?? FakeTenantControlPlane.RunningStatus),
            this.Env(FakeTenantControlPlane.EnvTwoName, FakeTenantControlPlane.HiveTwoId, FakeTenantControlPlane.StoppedStatus),
        ]
    }

    // By publishedAt: v3 newest (available), v2 current, v1 previous.
    private Manifests(): ManifestDto[]
    {
        return [
            { id: FakeTenantControlPlane.OlderVersion, image: 'app:1', publishedAt: '2026-01-01T00:00:00.000Z' },
            { id: FakeTenantControlPlane.CurrentVersion, image: FakeTenantControlPlane.CurrentImage, publishedAt: '2026-02-01T00:00:00.000Z' },
            { id: FakeTenantControlPlane.NewerVersion, image: 'app:3', publishedAt: '2026-03-01T00:00:00.000Z' },
        ]
    }

    private Rollout(hiveId: string): HiveRolloutDto
    {
        const envs = this.Environments().filter(e => e.hiveId === hiveId)
        return {
            targetVersion: FakeTenantControlPlane.CurrentVersion,
            environments: envs.map(e => ({ environmentName: e.name, runningImage: FakeTenantControlPlane.CurrentImage, obsolete: false, ready: true })),
        }
    }

    private Health(hiveId: string): HiveHealthDto[]
    {
        return this.Environments().filter(e => e.hiveId === hiveId)
            .map(e => ({ environmentName: e.name, ready: true, runningImage: FakeTenantControlPlane.CurrentImage, detail: FakeTenantControlPlane.Empty }))
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
        if (path === FakeTenantControlPlane.LogoutPath && method === FakeTenantControlPlane.MethodPost)
        {
            await FakeTenantControlPlane.ReadBody(req)
            this.LogoutCalls++
            this.Authenticated = false
            FakeTenantControlPlane.Json(res, 200, {})
            return
        }
        if (path === FakeTenantControlPlane.PasswordPath && method === FakeTenantControlPlane.MethodPost)
        {
            const body = JSON.parse(await FakeTenantControlPlane.ReadBody(req)) as { currentPassword?: string }
            this.PasswordCalls.push(body)
            const wrong = body.currentPassword === FakeTenantControlPlane.WrongCurrentPassword
            FakeTenantControlPlane.Json(res, wrong ? 403 : 200, wrong ? { error: FakeTenantControlPlane.WrongPasswordError } : { ok: true, otherSessionsEnded: true })
            return
        }
        if (path === FakeTenantControlPlane.BeginLoginPath)
        {
            this.BeginLoginCalls++
            res.writeHead(200, { [FakeTenantControlPlane.ContentTypeHeader]: FakeTenantControlPlane.HtmlType })
            res.end(FakeTenantControlPlane.IdpPage)
            return
        }
        if (path === FakeTenantControlPlane.SessionPath && this.SessionFailureStatus !== undefined)
        {
            FakeTenantControlPlane.Json(res, this.SessionFailureStatus, { error: FakeTenantControlPlane.SessionFailureMessage })
            return
        }
        if (path === FakeTenantControlPlane.SessionPath && !this.Authenticated)
        {
            FakeTenantControlPlane.Json(res, 401, { error: FakeTenantControlPlane.UnauthorizedMessage })
            return
        }
        if (path === FakeTenantControlPlane.SessionPath)
        {
            const session: SessionDto = { tenantId: FakeTenantControlPlane.TenantId, principalId: FakeTenantControlPlane.PrincipalId, email: FakeTenantControlPlane.UserEmail }
            FakeTenantControlPlane.Json(res, 200, session)
            return
        }
        if (path === FakeTenantControlPlane.ProfilePath)
        {
            const profile: TenantProfileDto = {
                principalId: FakeTenantControlPlane.PrincipalId,
                email: FakeTenantControlPlane.UserEmail,
                roleLabel: FakeTenantControlPlane.OwnerRoleLabel,
                environment: { id: FakeTenantControlPlane.TenantId, displayName: FakeTenantControlPlane.TenantDisplayName, organisation: FakeTenantControlPlane.OrganisationName },
                hive: { id: FakeTenantControlPlane.HiveOneId, displayName: FakeTenantControlPlane.HiveDisplayName },
                capabilities: { envs: true, adopt: true, access: true, settings: true },
                ownerContact: FakeTenantControlPlane.OwnerContact
            }
            FakeTenantControlPlane.Json(res, 200, profile)
            return
        }
        if (path === FakeTenantControlPlane.HivesPath)
        {
            FakeTenantControlPlane.Json(res, 200, this.Hives())
            return
        }
        if (path === FakeTenantControlPlane.EnvironmentsPath && method === FakeTenantControlPlane.MethodPost)
        {
            await this.HandleCreate(req, res)
            return
        }
        if (path === FakeTenantControlPlane.EnvironmentsPath)
        {
            this.EnvironmentsRequests++
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
        if (path.startsWith(FakeTenantControlPlane.EnvPrefix) && path.includes(FakeTenantControlPlane.AdminMarker))
        {
            await this.HandleAdmin(method, path, req, res)
            return
        }
        if (path.startsWith(FakeTenantControlPlane.EnvPrefix))
        {
            await this.HandleEnvironment(method, path, req, res)
            return
        }
        await this.Serve(path, res)
    }

    private async HandleCreate(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        let body: { name?: unknown; template?: unknown; type?: unknown }
        try
        {
            body = JSON.parse(await FakeTenantControlPlane.ReadBody(req)) as typeof body
        }
        catch
        {
            FakeTenantControlPlane.Json(res, 400, { error: FakeTenantControlPlane.BadRequestMessage })
            return
        }
        const templates: string[] = Object.values(Template)
        const types: string[] = Object.values(EnvType)
        if (typeof body.name !== 'string' || body.name.length === 0
            || typeof body.template !== 'string' || !templates.includes(body.template)
            || typeof body.type !== 'string' || !types.includes(body.type))
        {
            FakeTenantControlPlane.Json(res, 400, { error: FakeTenantControlPlane.BadRequestMessage })
            return
        }
        const name = body.name
        const dto = this.Env(name, FakeTenantControlPlane.HiveOneId, FakeTenantControlPlane.RunningStatus, body.template as Template, body.type as EnvType, `${name}${FakeTenantControlPlane.CreatedIdSuffix}`)
        this.CreatedEnvironments.push(name)
        this.PushEvent({ type: TenantEventType.EnvironmentCreated, environmentName: name })
        FakeTenantControlPlane.Json(res, 201, dto)
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
        else if (leaf === FakeTenantControlPlane.LedgerLeaf)
        {
            FakeTenantControlPlane.Json(res, 200, [{
                version: FakeTenantControlPlane.CurrentVersion, action: FakeTenantControlPlane.AdoptedAction,
                at: FakeTenantControlPlane.AdoptedAt, hiveId: id,
            }])
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
        if (env !== undefined && action === undefined && method === FakeTenantControlPlane.MethodDelete)
        {
            this.DeletedEnvironments.push(name)
            res.writeHead(204)
            res.end()
            return
        }
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

    // /tenant-api/environments/:name/admin/(snapshot|accounts[/:id]|grants|tokens|security-model|security-catalog|team-members/:id|security-changes)
    private async HandleAdmin(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const [rawName, admin, leaf, rawId] = path.slice(FakeTenantControlPlane.EnvPrefix.length).split(FakeTenantControlPlane.PathSeparator)
        const env = decodeURIComponent(rawName ?? FakeTenantControlPlane.Empty)
        const known = this.Environments().some(e => e.name === env)
        if (!known || admin !== FakeTenantControlPlane.AdminSegment)
        {
            res.writeHead(404)
            res.end()
            return
        }
        if (leaf === FakeTenantControlPlane.SnapshotLeaf && method === FakeTenantControlPlane.MethodGet)
        {
            FakeTenantControlPlane.Json(res, 200, { accounts: this.Accounts, grants: this.Grants })
            return
        }
        const raw = await FakeTenantControlPlane.ReadBody(req)
        const body: unknown = raw.length > 0 ? JSON.parse(raw) : undefined
        if (leaf === FakeTenantControlPlane.AccountsLeaf && method === FakeTenantControlPlane.MethodPost)
        {
            const a = body as { email: string; principalId: string }
            this.Accounts.push({ principalId: a.principalId, email: a.email, disabled: false })
            this.AdminCalls.push({ env, method, leaf, body })
            FakeTenantControlPlane.Json(res, 201, { ok: true })
        }
        else if (leaf === FakeTenantControlPlane.AccountsLeaf && method === FakeTenantControlPlane.MethodDelete && rawId !== undefined)
        {
            const id = decodeURIComponent(rawId)
            const account = this.Accounts.find(a => a.principalId === id)
            if (account !== undefined)
            {
                account.disabled = true
            }
            this.AdminCalls.push({ env, method, leaf: leaf + FakeTenantControlPlane.PathSeparator + id, body })
            FakeTenantControlPlane.Json(res, 200, { ok: true })
        }
        else if (leaf === FakeTenantControlPlane.GrantsLeaf && method === FakeTenantControlPlane.MethodPost)
        {
            const g = body as GrantMutationDto
            this.Grants.push({ subject: g.subject, role: g.role, resourceKind: g.resourceKind ?? FakeTenantControlPlane.TenantKind, resourcePath: g.resourcePath ?? [] })
            this.AdminCalls.push({ env, method, leaf, body })
            FakeTenantControlPlane.Json(res, 200, { ok: true })
        }
        else if (leaf === FakeTenantControlPlane.GrantsLeaf && method === FakeTenantControlPlane.MethodDelete)
        {
            const g = body as GrantMutationDto
            const i = this.Grants.findIndex(x => x.subject === g.subject && x.role === g.role)
            if (i >= 0)
            {
                this.Grants.splice(i, 1)
            }
            this.AdminCalls.push({ env, method, leaf, body })
            FakeTenantControlPlane.Json(res, 200, { ok: true })
        }
        else if (leaf === FakeTenantControlPlane.TokensLeaf && method === FakeTenantControlPlane.MethodGet)
        {
            FakeTenantControlPlane.Json(res, 200, this.Tokens)
        }
        else if (leaf === FakeTenantControlPlane.TokensLeaf && method === FakeTenantControlPlane.MethodPost)
        {
            const t = body as { principalId: string; scopes: string[]; expiresInSeconds: number | null }
            const tokenRef = 'ref-' + String(this.Tokens.length + 1)
            const expiresAt = t.expiresInSeconds === null ? null : new Date(Date.parse(FakeTenantControlPlane.CreatedAt) + t.expiresInSeconds * 1000).toISOString()
            this.Tokens.push({ tokenRef, principalId: t.principalId, scopes: t.scopes, expiresAt, revoked: false })
            this.AdminCalls.push({ env, method, leaf, body })
            FakeTenantControlPlane.Json(res, 201, { tokenRef, token: FakeTenantControlPlane.IssuedTokenValue, principalId: t.principalId, scopes: t.scopes, expiresAt })
        }
        else if (leaf === FakeTenantControlPlane.TokensLeaf && method === FakeTenantControlPlane.MethodDelete)
        {
            const t = body as { tokenRef: string }
            const token = this.Tokens.find(x => x.tokenRef === t.tokenRef)
            if (token !== undefined)
            {
                token.revoked = true
            }
            this.AdminCalls.push({ env, method, leaf, body })
            FakeTenantControlPlane.Json(res, 200, { ok: true })
        }
        else if (leaf === FakeTenantControlPlane.SecurityModelLeaf && method === FakeTenantControlPlane.MethodGet)
        {
            FakeTenantControlPlane.Json(res, 200, this.SecurityModel)
        }
        else if (leaf === FakeTenantControlPlane.SecurityModelLeaf && method === FakeTenantControlPlane.MethodPut)
        {
            this.SecurityModel = (body as { securityModel: SecurityModelDto }).securityModel
            this.AdminCalls.push({ env, method, leaf, body })
            FakeTenantControlPlane.Json(res, 200, { ok: true })
        }
        else if (leaf === FakeTenantControlPlane.SecurityCatalogLeaf && method === FakeTenantControlPlane.MethodGet)
        {
            FakeTenantControlPlane.Json(res, 200, this.SecurityCatalog)
        }
        else if (leaf === FakeTenantControlPlane.TeamMembersLeaf && method === FakeTenantControlPlane.MethodGet && rawId !== undefined)
        {
            FakeTenantControlPlane.Json(res, 200, this.TeamMembers.get(decodeURIComponent(rawId)) ?? [])
        }
        else if (leaf === FakeTenantControlPlane.SecurityChangesLeaf && method === FakeTenantControlPlane.MethodGet)
        {
            FakeTenantControlPlane.Json(res, 200, this.SecurityChanges)
        }
        else
        {
            res.writeHead(404)
            res.end()
        }
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
            if (extname(rel) === FakeTenantControlPlane.FontExt)
            {
                this.FontsServed.push(path)
            }
        }
        catch
        {
            this.NotFound.push(path)
            res.writeHead(404)
            res.end()
        }
    }
}
