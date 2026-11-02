import { test, expect, type Locator, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

// A recorded API call: method + path (+ parsed JSON body when one was sent).
type Call = { method: string; path: string; body?: unknown }

// Serves the built dist/ statically and fakes the control-plane API with
// canned data, recording every login/logout and every mutating call (which it
// refuses). GATED: needs Playwright browser binaries and a prior
// `npm run build`; not part of `npm test`.
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

    // Every mutating call other than login/logout: the fake refuses them all.
    public get Mutations(): Call[]
    {
        return this.Calls.filter(c => c.path !== FakeControlPlane.LoginPath && c.path !== FakeControlPlane.LogoutPath)
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
    // Each rail section's page title (its H3), in RailEntry order.
    public static readonly SectionTitles: readonly string[] = [
        'Fleet', 'Clients', 'Tenants', 'Hives', 'Registry & Releases', 'Release Policy', 'Activity', 'Settings',
    ]
    public static readonly HiveDetailCaptions: readonly string[] = [
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

// Interaction helpers. Mural renders the whole app as SVG: a TextBox is a
// surface with a hidden key sink (no <input>), and each control's hit rect
// sits over its text, so clicks are forced through it. A TextBox's placeholder
// follows its caption in document order, so the field is the placeholder's
// last match. The rail is icon-only (its names are tooltips), so an entry is
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

    public static async TypeInto(page: Page, placeholder: string, text: string): Promise<void>
    {
        await page.getByText(placeholder, { exact: true }).last().click({ force: true })
        await page.keyboard.type(text)
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

    test('Log out posts to the server and returns to the login page', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.Click(page, PortalText.LogoutLabel)
        await expect.poll(() => fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.LogoutPath)).toBeDefined()
        await expect(PortalSteps.Text(page, PortalText.SignInText)).toBeVisible()
    })
})
