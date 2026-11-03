import { test, expect, type Locator, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

// A recorded API call: method + path (+ parsed JSON body when one was sent).
type Call = { method: string; path: string; body?: unknown }

// Serves the built dist/ statically and fakes the control-plane API with
// canned data, recording every login/logout and every mutating call (which it
// refuses), except the stand-up of NewHiveId and its automatic agent install,
// which it plays through (Installing, then Connected). GATED: needs Playwright
// browser binaries and a prior `npm run build`; not part of `npm test`.
class FakeControlPlane
{
    public static readonly LoginPath = '/api/login'
    public static readonly LogoutPath = '/api/logout'
    public static readonly MethodPost = 'POST'
    public static readonly OperatorEmail = 'op@example.com'
    public static readonly OperatorPassword = 'correct-horse'
    public static readonly ClientId = 'tailspin'
    public static readonly ClientName = 'Tailspin Holdings'
    public static readonly TenantId = 'tailspin-prod'
    public static readonly TenantName = 'Tailspin Production'
    public static readonly HiveId = 'hive-eu-1'
    public static readonly HiveName = 'EU Hive 1'
    public static readonly SilentHiveId = 'hive-us-1'
    public static readonly SilentHiveName = 'US Hive 1'
    public static readonly Version = '4.2.0'
    public static readonly PreviousVersion = '4.1.0'
    public static readonly Image = 'registry.example/apps/maps:4.2.0'
    public static readonly Digest = 'sha256:0f3a9c'
    // The digest as the release detail shows it (the hash, algorithm dropped).
    public static readonly DigestLabel = '0f3a9c'
    // The ledger row's action label for AdoptAction, as the hive detail shows it.
    public static readonly AdoptedLabel = 'Adopted'
    // The check-in row's summary for the one ready environment Observations() reports.
    public static readonly CheckInSummary = '1 of 1 ready'
    public static readonly Notes = 'Faster capability maps.'
    public static readonly CredentialRef = 'registry-pull/tailspin'
    public static readonly FontExt = '.woff2'
    // The Local hive the stand-up test provisions; its install runs automatically.
    public static readonly NewHiveId = 'tailspin-local'
    public static readonly NewHiveName = 'Tailspin local'
    // The provision's one-time token: the automatic path must never show it.
    public static readonly ProvisionToken = 'e2e-provision-token-never-shown'
    private static readonly ProvisionPath = '/api/provision'
    // Deleting HiveId plays the agent-removal failure, then succeeds when forced (delete anyway).
    public static readonly HiveItemPath = '/api/hives/hive-eu-1'
    public static readonly UninstallFailure = "Could not remove the hive's agent from its cluster: kubectl failed: connection refused. Fix cluster access and retry, or delete anyway to remove only the platform record."
    public static readonly UninstallFailureStart = /^Could not remove the hive's agent/
    private static readonly UninstallFailedCode = 'agent-uninstall-failed'
    public static readonly ForcedNotice = 'The agent was not removed: the agent may remain in the cluster, locked out (its token is revoked), until someone removes it.'
    public static readonly DeletedNoticeStart = /^Hive hive-eu-1 was deleted\./
    private static readonly ForceQuery = 'force=true'
    private static readonly MethodDelete = 'DELETE'
    private static readonly NewHiveBootstrapPath = '/api/hives/tailspin-local/bootstrap'
    private static readonly NewHiveInstallPath = '/api/hives/tailspin-local/agent-install'
    private static readonly InstallStartedAt = '2026-11-03T10:00:00.000Z'
    private static readonly InstallFinishedAt = '2026-11-03T10:02:00.000Z'
    private static readonly InstallingState = 'installing'
    private static readonly ConnectedState = 'connected'
    private static readonly PreparingStep = 'preparing-cluster'
    private static readonly StoringTokenStep = 'storing-token'
    private static readonly WaitingStep = 'waiting-for-check-in'
    private static readonly LocalBackend = 'local'
    private static readonly SessionPath = '/api/session'
    private static readonly ClientsPath = '/api/clients'
    private static readonly TenantsPath = '/api/tenants'
    private static readonly FleetPath = '/api/fleet'
    private static readonly HivesPath = '/api/hives'
    private static readonly RolloutsPath = '/api/rollouts'
    private static readonly PoliciesPath = '/api/policies'
    private static readonly ManifestsPath = '/api/manifests'
    private static readonly HiveLedgerPath = '/api/hives/hive-eu-1/ledger'
    private static readonly HiveObservationsPath = '/api/hives/hive-eu-1/observations'
    private static readonly HiveBootstrapPath = '/api/hives/hive-eu-1/bootstrap'
    public static readonly BootstrapFileName = 'bootstrap-hive-eu-1.json'
    private static readonly ApiPrefix = '/api/'
    private static readonly StableChannel = 'stable'
    private static readonly EarlyChannel = 'early'
    private static readonly AdoptAction = 'adopted'
    private static readonly LedgerId = 'l-1'
    private static readonly ObservationId = 'o-1'
    private static readonly PublishedAt = '2026-10-10T00:00:00.000Z'
    private static readonly AdoptedAt = '2026-10-12T00:00:00.000Z'
    private static readonly FullRole = 'full'
    private static readonly PrincipalId = 'p-1'
    private static readonly CreatedAt = '2026-01-01T00:00:00.000Z'
    private static readonly ClusterBackend = 'aks'
    private static readonly ClusterMode = 'attach'
    private static readonly EnvName = 'production'
    private static readonly EnvDetail = 'ready'
    private static readonly UnauthenticatedError = 'unauthenticated'
    private static readonly RefusedError = 'refused by the e2e fake'
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly SessionCookie = 'sid=test; Path=/; HttpOnly'
    private static readonly HtmlExt = '.html'
    private static readonly JsExt = '.js'
    private static readonly CssExt = '.css'
    private static readonly SvgExt = '.svg'
    private static readonly RootPath = '/'
    private static readonly IndexFile = 'index.html'
    private static readonly ParentSegment = '..'
    private static readonly QuerySeparator = '?'
    private static readonly MethodGet = 'GET'
    private static readonly HostLocal = '127.0.0.1'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly JsonType = 'application/json'
    private static readonly DefaultType = 'application/octet-stream'
    private static readonly Types: Record<string, string> =
    {
        [FakeControlPlane.HtmlExt]: 'text/html',
        [FakeControlPlane.JsExt]: 'text/javascript',
        [FakeControlPlane.CssExt]: 'text/css',
        [FakeControlPlane.SvgExt]: 'image/svg+xml',
        [FakeControlPlane.FontExt]: 'font/woff2',
    }

    public readonly Calls: Call[] = []
    // Every static file requested but not found in dist/ (fonts included).
    public readonly NotFound: string[] = []
    // Every theme font served.
    public readonly FontsServed: string[] = []
    public Authenticated = true
    // Reads of the new hive's install status so far (the first reports a running step, later ones Connected).
    public InstallReads = 0
    // Whether the hive was deleted with force (delete anyway).
    public ForcedDelete = false
    private readonly root = fileURLToPath(new URL('../dist/', import.meta.url))
    private server: Server | undefined

    public async Start(): Promise<string>
    {
        this.server = createServer((req, res) => { void this.Handle(req, res) })
        await new Promise<void>(resolve => this.server!.listen(0, FakeControlPlane.HostLocal, resolve))
        const addr = this.server.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        return `http://${FakeControlPlane.HostLocal}:${port}`
    }

    public async Stop(): Promise<void>
    {
        await new Promise<void>(resolve => this.server?.close(() => resolve()))
    }

    public Find(method: string, path: string): Call | undefined
    {
        return this.Calls.find(c => c.method === method && c.path === path)
    }

    // Every refused mutating call: all but login/logout and the played-through stand-up writes.
    public get Mutations(): Call[]
    {
        return this.Calls.filter(c => c.path !== FakeControlPlane.LoginPath && c.path !== FakeControlPlane.LogoutPath && !FakeControlPlane.IsPlayedWrite(c.path))
    }

    private static IsPlayedWrite(path: string): boolean
    {
        return path === FakeControlPlane.ProvisionPath || path === FakeControlPlane.NewHiveInstallPath || path === FakeControlPlane.HiveItemPath
    }

    private Operator(): Record<string, unknown>
    {
        return { email: FakeControlPlane.OperatorEmail, principalId: FakeControlPlane.PrincipalId, role: FakeControlPlane.FullRole }
    }

    private Clients(): unknown[]
    {
        return [{ id: FakeControlPlane.ClientId, displayName: FakeControlPlane.ClientName, createdAt: FakeControlPlane.CreatedAt }]
    }

    private Tenants(): unknown[]
    {
        return [{ id: FakeControlPlane.TenantId, clientId: FakeControlPlane.ClientId, displayName: FakeControlPlane.TenantName, createdAt: FakeControlPlane.CreatedAt }]
    }

    private Fleet(): unknown[]
    {
        return [{
            id: FakeControlPlane.HiveId,
            displayName: FakeControlPlane.HiveName,
            tenant: { id: FakeControlPlane.TenantId, displayName: FakeControlPlane.TenantName },
            client: { id: FakeControlPlane.ClientId, displayName: FakeControlPlane.ClientName },
            clusterBackend: FakeControlPlane.ClusterBackend,
            clusterMode: FakeControlPlane.ClusterMode,
            lastSeen: new Date().toISOString(),
            environments: [{ name: FakeControlPlane.EnvName, ready: true, image: FakeControlPlane.Image, detail: FakeControlPlane.EnvDetail }],
        }, {
            // Never checked in: listed under Needs attention.
            id: FakeControlPlane.SilentHiveId,
            displayName: FakeControlPlane.SilentHiveName,
            tenant: null,
            client: null,
            clusterBackend: FakeControlPlane.ClusterBackend,
            clusterMode: FakeControlPlane.ClusterMode,
            lastSeen: null,
            environments: [],
        }]
    }

    private Hives(): unknown[]
    {
        return [{
            id: FakeControlPlane.HiveId,
            tenantId: FakeControlPlane.TenantId,
            displayName: FakeControlPlane.HiveName,
            cluster: { backend: FakeControlPlane.ClusterBackend, mode: FakeControlPlane.ClusterMode },
            registry: { mode: FakeControlPlane.ClusterMode, credentialRef: FakeControlPlane.CredentialRef },
        }]
    }

    private Rollouts(): unknown[]
    {
        return [{
            hiveId: FakeControlPlane.HiveId,
            targetVersion: FakeControlPlane.Version,
            environments: [{ environmentName: FakeControlPlane.EnvName, runningImage: FakeControlPlane.Image, obsolete: false, ready: true }],
        }]
    }

    private Policies(): unknown[]
    {
        return [{
            tenantId: FakeControlPlane.TenantId,
            hiveId: FakeControlPlane.HiveId,
            channels: [FakeControlPlane.StableChannel, FakeControlPlane.EarlyChannel],
            minVersion: FakeControlPlane.PreviousVersion,
        }]
    }

    private Ledger(): unknown[]
    {
        return [{
            id: FakeControlPlane.LedgerId,
            tenantId: FakeControlPlane.TenantId,
            hiveId: FakeControlPlane.HiveId,
            version: FakeControlPlane.Version,
            action: FakeControlPlane.AdoptAction,
            at: FakeControlPlane.AdoptedAt,
        }]
    }

    private Observations(): unknown[]
    {
        return [{
            id: FakeControlPlane.ObservationId,
            hiveId: FakeControlPlane.HiveId,
            environments: [{ environmentName: FakeControlPlane.EnvName, ready: true, runningImage: FakeControlPlane.Image, detail: FakeControlPlane.EnvDetail }],
            reportedAt: new Date().toISOString(),
        }]
    }

    // The hive's secret-free agent install bundle.
    private Bootstrap(): unknown
    {
        return {
            hiveId: FakeControlPlane.HiveId,
            fileName: FakeControlPlane.BootstrapFileName,
            manifest: '{"apiVersion":"v1","kind":"List","items":[]}',
            namespace: 'pragmatic-system',
            agentName: 'pragmatic-hive-hive-eu-1-agent',
            hiveSelector: 'pragmatic/hive=hive-eu-1',
            tokenSecretName: 'pragmatic-hive-hive-eu-1-agent-token',
            tokenSecretKey: 'token',
            channelUrl: 'http://host.docker.internal:7001',
            autoInstall: false,
        }
    }

    // The new Local hive's bundle: the control plane installs its agent.
    private NewHiveBootstrap(): unknown
    {
        return {
            hiveId: FakeControlPlane.NewHiveId,
            fileName: 'bootstrap-' + FakeControlPlane.NewHiveId + '.json',
            manifest: '{"apiVersion":"v1","kind":"List","items":[]}',
            namespace: 'pragmatic-system',
            agentName: 'pragmatic-hive-' + FakeControlPlane.NewHiveId + '-agent',
            hiveSelector: 'pragmatic/hive=' + FakeControlPlane.NewHiveId,
            tokenSecretName: 'pragmatic-hive-' + FakeControlPlane.NewHiveId + '-agent-token',
            tokenSecretKey: 'token',
            channelUrl: 'http://host.docker.internal:7001',
            autoInstall: true,
        }
    }

    // The stand-up's provision result onto the existing client and tenant: the hive and only an agent token.
    private Provisioned(): unknown
    {
        return {
            client: this.Clients()[0],
            tenant: this.Tenants()[0],
            hive: {
                id: FakeControlPlane.NewHiveId,
                tenantId: FakeControlPlane.TenantId,
                displayName: FakeControlPlane.NewHiveName,
                cluster: { backend: FakeControlPlane.LocalBackend, mode: FakeControlPlane.ClusterMode },
                registry: { mode: FakeControlPlane.ClusterMode },
            },
            secrets: { agentToken: FakeControlPlane.ProvisionToken },
        }
    }

    private static InstallStatus(state: string, step: string): Record<string, unknown>
    {
        const status: Record<string, unknown> = { state, step, startedAt: FakeControlPlane.InstallStartedAt }
        if (state !== FakeControlPlane.InstallingState)
        {
            status.finishedAt = FakeControlPlane.InstallFinishedAt
        }
        return status
    }

    // The automatic install as the control plane plays it: the first read is mid-way, later reads Connected.
    private InstallProgress(): unknown
    {
        this.InstallReads++
        return this.InstallReads === 1
            ? FakeControlPlane.InstallStatus(FakeControlPlane.InstallingState, FakeControlPlane.StoringTokenStep)
            : FakeControlPlane.InstallStatus(FakeControlPlane.ConnectedState, FakeControlPlane.WaitingStep)
    }

    private Manifests(): unknown[]
    {
        return [{
            id: FakeControlPlane.Version,
            image: FakeControlPlane.Image,
            notes: FakeControlPlane.Notes,
            publishedAt: FakeControlPlane.PublishedAt,
            channel: FakeControlPlane.StableChannel,
            digest: FakeControlPlane.Digest,
            signed: true,
        }]
    }

    private static ReadBody(req: IncomingMessage): Promise<string>
    {
        return new Promise(resolve =>
        {
            const chunks: Buffer[] = []
            req.on('data', (c: Buffer) => { chunks.push(c) })
            req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
        })
    }

    private static Json(res: ServerResponse, status: number, body: unknown): void
    {
        res.writeHead(status, { [FakeControlPlane.ContentTypeHeader]: FakeControlPlane.JsonType })
        res.end(JSON.stringify(body))
    }

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const method = req.method ?? FakeControlPlane.MethodGet
        const path = (req.url ?? FakeControlPlane.RootPath).split(FakeControlPlane.QuerySeparator)[0]!
        if (path === FakeControlPlane.SessionPath)
        {
            if (this.Authenticated)
            {
                FakeControlPlane.Json(res, 200, this.Operator())
            }
            else
            {
                FakeControlPlane.Json(res, 401, { error: FakeControlPlane.UnauthenticatedError })
            }
            return
        }
        if (path === FakeControlPlane.LoginPath)
        {
            const raw = await FakeControlPlane.ReadBody(req)
            this.Calls.push({ method, path, body: JSON.parse(raw) })
            this.Authenticated = true
            res.writeHead(200, { [FakeControlPlane.ContentTypeHeader]: FakeControlPlane.JsonType, [FakeControlPlane.SetCookieHeader]: FakeControlPlane.SessionCookie })
            res.end(JSON.stringify(this.Operator()))
            return
        }
        if (path === FakeControlPlane.LogoutPath)
        {
            await FakeControlPlane.ReadBody(req)
            this.Calls.push({ method, path })
            this.Authenticated = false
            FakeControlPlane.Json(res, 200, {})
            return
        }
        if (path.startsWith(FakeControlPlane.ApiPrefix))
        {
            await this.Api(method, path, req, res)
            return
        }
        await this.Serve(path, res)
    }

    // Lists for the pages the spec visits, [] for every other read, and a
    // refusal for every write (recorded so a test can assert none happened).
    // The events ticket is refused too, so the client opens no socket.
    private async Api(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        if (!this.Authenticated)
        {
            FakeControlPlane.Json(res, 401, { error: FakeControlPlane.UnauthenticatedError })
            return
        }
        if (method !== FakeControlPlane.MethodGet)
        {
            const raw = await FakeControlPlane.ReadBody(req)
            this.Calls.push({ method, path, body: raw.length > 0 ? JSON.parse(raw) : undefined })
            if (path === FakeControlPlane.ProvisionPath)
            {
                FakeControlPlane.Json(res, 201, this.Provisioned())
                return
            }
            if (path === FakeControlPlane.HiveItemPath && method === FakeControlPlane.MethodDelete)
            {
                this.ForcedDelete = (req.url ?? '').includes(FakeControlPlane.ForceQuery)
                if (this.ForcedDelete)
                {
                    FakeControlPlane.Json(res, 200, { ok: true, retained: [], notice: FakeControlPlane.ForcedNotice })
                }
                else
                {
                    FakeControlPlane.Json(res, 409, { error: FakeControlPlane.UninstallFailure, code: FakeControlPlane.UninstallFailedCode })
                }
                return
            }
            if (path === FakeControlPlane.NewHiveInstallPath)
            {
                FakeControlPlane.Json(res, 202, FakeControlPlane.InstallStatus(FakeControlPlane.InstallingState, FakeControlPlane.PreparingStep))
                return
            }
            FakeControlPlane.Json(res, 401, { error: FakeControlPlane.RefusedError })
            return
        }
        switch (path)
        {
            case FakeControlPlane.ClientsPath:
                FakeControlPlane.Json(res, 200, this.Clients())
                return
            case FakeControlPlane.TenantsPath:
                FakeControlPlane.Json(res, 200, this.Tenants())
                return
            case FakeControlPlane.FleetPath:
                FakeControlPlane.Json(res, 200, this.Fleet())
                return
            case FakeControlPlane.HivesPath:
                FakeControlPlane.Json(res, 200, this.Hives())
                return
            case FakeControlPlane.RolloutsPath:
                FakeControlPlane.Json(res, 200, this.Rollouts())
                return
            case FakeControlPlane.PoliciesPath:
                FakeControlPlane.Json(res, 200, this.Policies())
                return
            case FakeControlPlane.HiveLedgerPath:
                FakeControlPlane.Json(res, 200, this.Ledger())
                return
            case FakeControlPlane.HiveObservationsPath:
                FakeControlPlane.Json(res, 200, this.Observations())
                return
            case FakeControlPlane.ManifestsPath:
                FakeControlPlane.Json(res, 200, this.Manifests())
                return
            case FakeControlPlane.HiveBootstrapPath:
                FakeControlPlane.Json(res, 200, this.Bootstrap())
                return
            case FakeControlPlane.NewHiveBootstrapPath:
                FakeControlPlane.Json(res, 200, this.NewHiveBootstrap())
                return
            case FakeControlPlane.NewHiveInstallPath:
                FakeControlPlane.Json(res, 200, this.InstallProgress())
                return
            default:
                FakeControlPlane.Json(res, 200, [])
        }
    }

    private async Serve(path: string, res: ServerResponse): Promise<void>
    {
        const rel = path === FakeControlPlane.RootPath ? FakeControlPlane.IndexFile : normalize(path).slice(1)
        if (rel.startsWith(FakeControlPlane.ParentSegment))
        {
            this.NotFound.push(path)
            res.writeHead(404)
            res.end()
            return
        }
        try
        {
            const body = await readFile(join(this.root, rel))
            res.writeHead(200, { [FakeControlPlane.ContentTypeHeader]: FakeControlPlane.Types[extname(rel)] ?? FakeControlPlane.DefaultType })
            res.end(body)
            if (extname(rel) === FakeControlPlane.FontExt)
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

// The new app's visible text, as its .mu markup spells it.
class PortalText
{
    public static readonly SignInText = 'Operator sign in'
    public static readonly LoginLabel = 'Log in'
    public static readonly EmailPlaceholder = 'Email'
    public static readonly PasswordPlaceholder = 'Password'
    public static readonly LogoutLabel = 'Log out'
    public static readonly FleetSubtitle = 'Every hive, read from its last check-in. Exceptions first.'
    public static readonly TenantsSubtitle = 'Customer workspaces. Each is bound to exactly one hive.'
    public static readonly TenantDetailCaption = 'Hive binding'
    public static readonly BackLabel = 'Back'
    public static readonly ClientsSubtitle = 'Contracting organisations. Each has one or more tenants; each tenant runs in exactly one hive.'
    public static readonly CreateClientLabel = 'Create client'
    // A single-line dialog caption: wrapped text renders as one SVG text per line.
    public static readonly NewClientCaption = 'Subscription reference (optional)'
    public static readonly CancelLabel = 'Cancel'
    public static readonly NeedsAttentionCaption = 'Needs attention'
    public static readonly StandUpLabel = 'Stand up a hive'
    public static readonly NewClientChoice = 'New client'
    public static readonly NewTenantChoice = 'New tenant'
    public static readonly NextLabel = 'Next'
    public static readonly ClientIdCaption = 'Client id'
    public static readonly TenantIdCaption = 'Tenant id'
    public static readonly HiveIdCaption = 'Hive id'
    public static readonly HiveIdPlaceholder = 'e.g. tailspin-hive'
    public static readonly HiveNamePlaceholder = 'e.g. Tailspin hive'
    public static readonly StandUpSubmitLabel = 'Stand up hive'
    public static readonly InstallingCaption = 'Installing the agent'
    public static readonly ApplyStepLabel = 'Apply the agent'
    public static readonly CheckInStepLabel = 'Wait for the agent to check in'
    public static readonly ConnectedText = 'Connected. The agent checked in.'
    public static readonly ManualTokenCaption = 'One-time agent token'
    public static readonly DeleteHiveLabel = 'Delete hive'
    public static readonly DeleteLabel = 'Delete'
    public static readonly DeleteAnywayLabel = 'Delete anyway'
    public static readonly DeleteAnywayTitle = 'Delete the hive anyway?'
    // Each rail section's page title (its H3), in RailEntry order.
    public static readonly SectionTitles: readonly string[] = [
        'Fleet', 'Clients', 'Tenants', 'Hives', 'Registry & Releases', 'Release Policy', 'Activity', 'Settings',
    ]
    public static readonly HiveDetailCaptions: readonly string[] = [
        'Agent install', 'Download bundle', 'Reissue agent token',
        'Home channel', 'Credentials', 'Rollout', 'Per-hive policy', 'Version history', 'Recent check-ins',
    ]
    public static readonly ReleaseDetailCaptions: readonly string[] = [
        'Manifest', 'What\'s new', 'Where it runs',
    ]
    // Text a template shows only when a binding or a label formatter failed.
    public static readonly BrokenBinding = /undefined|\[object Object\]|NaN/
}

// The rail's entries, in the order app.mu lists the section modules.
enum RailEntry
{
    Fleet,
    Clients,
    Tenants,
    Hives,
    Releases,
    ReleasePolicy,
    Activity,
    Settings,
}

// Interaction helpers. Mural renders the whole app as SVG, and each control's
// hit rect sits over its text, so clicks are forced through it. The portal's
// TextBoxes are real browser inputs (TextBox.UsesNativeInput), found by their
// placeholder attribute. The rail is icon-only (its names are tooltips), so an entry is
// clicked at its position, derived from RailLayout below; every click then
// asserts the entry's page title, so a layout drift fails loudly.
class PortalSteps
{
    // The rail's geometry in CSS px at the default viewport, the one place
    // the spec knows it. Mural's ActivityBarRail template is 48 wide (so its
    // icons centre at x=24); its entries are fixed-pitch ActivityBarItems 40
    // apart (32 high + the item padding), the first centred at y=97 (below
    // the shell's title bar and the rail's header actions).
    private static readonly RailLayout = { CenterX: 24, FirstCenterY: 97, Pitch: 40 } as const

    // Text boxes are real browser inputs (TextBox.UsesNativeInput): focus one by its placeholder.
    public static async TypeInto(page: Page, placeholder: string, text: string): Promise<void>
    {
        await page.locator('input[placeholder="' + placeholder + '"]').last().click()
        await page.keyboard.type(text)
    }

    // A dialog's input sits under the dialog's hit rect: focus it with a forced click.
    public static async TypeIntoDialog(page: Page, placeholder: string, text: string): Promise<void>
    {
        const input = page.locator('input[placeholder="' + placeholder + '"]').last()
        await input.click({ force: true })
        await input.pressSequentially(text)
        await expect(input).toHaveValue(text)
    }

    public static Text(page: Page, text: string): Locator
    {
        return page.getByText(text, { exact: true })
    }

    public static async Click(page: Page, text: string): Promise<void>
    {
        await PortalSteps.Text(page, text).first().click({ force: true })
    }

    // Clicks a rail entry and waits for that section's page title.
    public static async OpenSection(page: Page, entry: RailEntry): Promise<void>
    {
        const layout = PortalSteps.RailLayout
        await page.mouse.click(layout.CenterX, layout.FirstCenterY + layout.Pitch * entry)
        await expect(PortalSteps.Visible(page, PortalText.SectionTitles[entry]!)).toBeVisible()
    }

    // The first visible exact match (tooltips and offscreen copies excluded).
    public static Visible(page: Page, text: string): Locator
    {
        return PortalSteps.Text(page, text).filter({ visible: true }).first()
    }

    // Asserts no rendered text shows a broken binding.
    public static async ExpectNoBrokenText(page: Page): Promise<void>
    {
        await expect(page.getByText(PortalText.BrokenBinding)).toHaveCount(0)
    }
}

test.describe('admin portal', () =>
{
    const fake = new FakeControlPlane()
    let base = ''

    test.beforeAll(async () => { base = await fake.Start() })
    test.afterAll(async () => { await fake.Stop() })
    test.beforeEach(() =>
    {
        fake.Authenticated = true
        fake.Calls.length = 0
        fake.NotFound.length = 0
        fake.FontsServed.length = 0
        fake.InstallReads = 0
        fake.ForcedDelete = false
    })
    test.afterEach(() =>
    {
        expect(fake.Mutations).toEqual([])
        expect(fake.NotFound).toEqual([])
    })

    test('the theme fonts are served from the build', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await expect.poll(() => fake.FontsServed.length).toBeGreaterThan(0)
        expect(fake.NotFound).toEqual([])
    })

    test('every rail entry opens its section', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        for (const entry of [RailEntry.Clients, RailEntry.Tenants, RailEntry.Hives, RailEntry.Releases,
            RailEntry.ReleasePolicy, RailEntry.Activity, RailEntry.Settings, RailEntry.Fleet])
        {
            await PortalSteps.OpenSection(page, entry)
        }
    })

    test('Fleet: a hive that never checked in is listed under Needs attention', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await expect(PortalSteps.Visible(page, PortalText.NeedsAttentionCaption)).toBeVisible()
        // Once in the Needs-attention list, once in the hives table.
        await expect(PortalSteps.Text(page, FakeControlPlane.SilentHiveName).filter({ visible: true })).toHaveCount(2)
        await PortalSteps.ExpectNoBrokenText(page)
    })

    test('Fleet: a hive row opens the hive detail with every section rendered', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.Click(page, FakeControlPlane.HiveName)
        for (const caption of PortalText.HiveDetailCaptions)
        {
            await expect(PortalSteps.Visible(page, caption)).toBeVisible()
        }
        await expect(PortalSteps.Visible(page, FakeControlPlane.HiveId)).toBeVisible()
        await expect(PortalSteps.Visible(page, FakeControlPlane.BootstrapFileName)).toBeVisible()
        await expect(PortalSteps.Visible(page, FakeControlPlane.CredentialRef)).toBeVisible()
        await expect(PortalSteps.Visible(page, FakeControlPlane.Version)).toBeVisible()
        await expect(PortalSteps.Visible(page, FakeControlPlane.Image)).toBeVisible()
        // Row-specific: the Version history (ledger) row and the Recent check-ins row.
        await expect(PortalSteps.Visible(page, FakeControlPlane.AdoptedLabel)).toBeVisible()
        await expect(PortalSteps.Visible(page, FakeControlPlane.CheckInSummary)).toBeVisible()
        await PortalSteps.ExpectNoBrokenText(page)
    })

    test('Releases: a version row opens the release detail with every section rendered', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.OpenSection(page, RailEntry.Releases)
        await PortalSteps.Click(page, FakeControlPlane.Version)
        for (const caption of PortalText.ReleaseDetailCaptions)
        {
            await expect(PortalSteps.Visible(page, caption)).toBeVisible()
        }
        await expect(PortalSteps.Visible(page, FakeControlPlane.DigestLabel)).toBeVisible()
        await expect(PortalSteps.Visible(page, FakeControlPlane.Notes)).toBeVisible()
        await expect(PortalSteps.Visible(page, FakeControlPlane.HiveName)).toBeVisible()
        await PortalSteps.ExpectNoBrokenText(page)
    })

    test('logging in posts the credentials and then shows the Fleet page', async ({ page }) =>
    {
        fake.Authenticated = false
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.SignInText)).toBeVisible()
        await PortalSteps.TypeInto(page, PortalText.EmailPlaceholder, FakeControlPlane.OperatorEmail)
        await PortalSteps.TypeInto(page, PortalText.PasswordPlaceholder, FakeControlPlane.OperatorPassword)
        await PortalSteps.Click(page, PortalText.LoginLabel)
        await expect.poll(() => fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.LoginPath)).toBeDefined()
        expect(fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.LoginPath)!.body).toEqual({
            email: FakeControlPlane.OperatorEmail,
            password: FakeControlPlane.OperatorPassword,
        })
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await expect(PortalSteps.Text(page, FakeControlPlane.HiveName).first()).toBeVisible()
    })

    test('Tenants: a tenant row opens its detail and Back returns to the list', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.OpenSection(page, RailEntry.Tenants)
        await PortalSteps.Click(page, FakeControlPlane.TenantName)
        await expect(PortalSteps.Text(page, PortalText.TenantDetailCaption)).toBeVisible()
        await PortalSteps.Click(page, PortalText.BackLabel)
        await expect(PortalSteps.Text(page, PortalText.TenantsSubtitle)).toBeVisible()
        await expect(PortalSteps.Text(page, PortalText.TenantDetailCaption)).not.toBeVisible()
    })

    test('Clients: Create client opens the dialog and Cancel closes it', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.OpenSection(page, RailEntry.Clients)
        await expect(PortalSteps.Text(page, PortalText.ClientsSubtitle)).toBeVisible()
        await PortalSteps.Click(page, PortalText.CreateClientLabel)
        await expect(PortalSteps.Text(page, PortalText.NewClientCaption)).toBeVisible()
        await PortalSteps.Click(page, PortalText.CancelLabel)
        await expect(PortalSteps.Text(page, PortalText.NewClientCaption)).not.toBeVisible()
        await expect(PortalSteps.Text(page, PortalText.ClientsSubtitle)).toBeVisible()
    })

    test('Hives: the stand-up wizard picks an existing client and tenant from ComboBoxes', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.OpenSection(page, RailEntry.Hives)
        await PortalSteps.Click(page, PortalText.StandUpLabel)
        await expect(PortalSteps.Visible(page, PortalText.NewClientChoice)).toBeVisible()
        await expect(PortalSteps.Visible(page, PortalText.ClientIdCaption)).toBeVisible()
        await PortalSteps.Click(page, PortalText.NewClientChoice)
        await PortalSteps.Visible(page, FakeControlPlane.ClientName).click({ force: true })
        await expect(PortalSteps.Text(page, PortalText.ClientIdCaption).filter({ visible: true })).toHaveCount(0)
        await PortalSteps.Click(page, PortalText.NextLabel)
        await expect(PortalSteps.Visible(page, PortalText.NewTenantChoice)).toBeVisible()
        await PortalSteps.Click(page, PortalText.NewTenantChoice)
        await PortalSteps.Visible(page, FakeControlPlane.TenantName).click({ force: true })
        await expect(PortalSteps.Text(page, PortalText.TenantIdCaption).filter({ visible: true })).toHaveCount(0)
        await PortalSteps.Click(page, PortalText.NextLabel)
        await expect(PortalSteps.Visible(page, PortalText.HiveIdCaption)).toBeVisible()
        await PortalSteps.ExpectNoBrokenText(page)
    })

    test('Hives: standing up a Local hive installs its agent automatically and ends Connected, never showing the token', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.OpenSection(page, RailEntry.Hives)
        await PortalSteps.Click(page, PortalText.StandUpLabel)
        await expect(PortalSteps.Visible(page, PortalText.NewClientChoice)).toBeVisible()
        await PortalSteps.Click(page, PortalText.NewClientChoice)
        await PortalSteps.Visible(page, FakeControlPlane.ClientName).click({ force: true })
        await PortalSteps.Click(page, PortalText.NextLabel)
        await expect(PortalSteps.Visible(page, PortalText.NewTenantChoice)).toBeVisible()
        await PortalSteps.Click(page, PortalText.NewTenantChoice)
        await PortalSteps.Visible(page, FakeControlPlane.TenantName).click({ force: true })
        await PortalSteps.Click(page, PortalText.NextLabel)
        await expect(PortalSteps.Visible(page, PortalText.HiveIdCaption)).toBeVisible()
        await PortalSteps.TypeInto(page, PortalText.HiveIdPlaceholder, FakeControlPlane.NewHiveId)
        await PortalSteps.TypeInto(page, PortalText.HiveNamePlaceholder, FakeControlPlane.NewHiveName)
        await PortalSteps.Click(page, PortalText.NextLabel)
        await PortalSteps.Click(page, PortalText.StandUpSubmitLabel)
        await expect(PortalSteps.Visible(page, PortalText.InstallingCaption)).toBeVisible()
        await expect(PortalSteps.Visible(page, PortalText.ApplyStepLabel)).toBeVisible()
        await expect(PortalSteps.Visible(page, PortalText.CheckInStepLabel)).toBeVisible()
        await expect.poll(() => fake.Find(FakeControlPlane.MethodPost, '/api/hives/' + FakeControlPlane.NewHiveId + '/agent-install')).toBeDefined()
        // Polled every 2 s: a mid-way read, then Connected.
        await expect(PortalSteps.Visible(page, PortalText.ConnectedText)).toBeVisible({ timeout: 10000 })
        expect(fake.InstallReads).toBeGreaterThanOrEqual(2)
        await expect(page.getByText(FakeControlPlane.ProvisionToken)).toHaveCount(0)
        await expect(PortalSteps.Text(page, PortalText.ManualTokenCaption).filter({ visible: true })).toHaveCount(0)
        await PortalSteps.ExpectNoBrokenText(page)
    })

    test('Hives: a delete that cannot remove the agent shows why and offers Delete anyway, which force-deletes', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.Click(page, FakeControlPlane.HiveName)
        await PortalSteps.Visible(page, PortalText.DeleteHiveLabel).click({ force: true })
        await PortalSteps.TypeIntoDialog(page, FakeControlPlane.HiveId, FakeControlPlane.HiveId)
        await PortalSteps.Visible(page, PortalText.DeleteLabel).click({ force: true })
        // Wrapped text renders one SVG text per line: match the reason's first words.
        await expect(page.getByText(FakeControlPlane.UninstallFailureStart).filter({ visible: true }).first()).toBeVisible()
        await expect.poll(() => fake.Find('DELETE', FakeControlPlane.HiveItemPath)).toBeDefined()
        expect(fake.ForcedDelete).toBe(false)
        await PortalSteps.Visible(page, PortalText.CancelLabel).click({ force: true })
        await PortalSteps.Visible(page, PortalText.DeleteAnywayLabel).click({ force: true })
        await expect(PortalSteps.Visible(page, PortalText.DeleteAnywayTitle)).toBeVisible()
        await PortalSteps.TypeIntoDialog(page, FakeControlPlane.HiveId, FakeControlPlane.HiveId)
        await PortalSteps.Text(page, PortalText.DeleteAnywayLabel).filter({ visible: true }).last().click({ force: true })
        await expect.poll(() => fake.ForcedDelete).toBe(true)
        await expect(PortalSteps.Text(page, PortalText.DeleteAnywayTitle).filter({ visible: true })).toHaveCount(0)
        // Back on the hives list, which says what the delete anyway may have left behind.
        await expect(page.getByText(FakeControlPlane.DeletedNoticeStart).filter({ visible: true }).first()).toBeVisible()
        await PortalSteps.ExpectNoBrokenText(page)
    })

    test('Log out posts to the server and returns to the login page', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.Click(page, PortalText.LogoutLabel)
        await expect.poll(() => fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.LogoutPath)).toBeDefined()
        await expect(PortalSteps.Text(page, PortalText.SignInText)).toBeVisible()
    })
})
