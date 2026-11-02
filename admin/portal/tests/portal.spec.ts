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
    private static readonly SessionPath = '/api/session'
    private static readonly ClientsPath = '/api/clients'
    private static readonly TenantsPath = '/api/tenants'
    private static readonly FleetPath = '/api/fleet'
    private static readonly ApiPrefix = '/api/'
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
    }

    public readonly Calls: Call[] = []
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
            environments: [{ name: FakeControlPlane.EnvName, ready: true, detail: FakeControlPlane.EnvDetail }],
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
            default:
                FakeControlPlane.Json(res, 200, [])
        }
    }

    private async Serve(path: string, res: ServerResponse): Promise<void>
    {
        const rel = path === FakeControlPlane.RootPath ? FakeControlPlane.IndexFile : normalize(path).slice(1)
        if (rel.startsWith(FakeControlPlane.ParentSegment))
        {
            res.writeHead(404)
            res.end()
            return
        }
        try
        {
            const body = await readFile(join(this.root, rel))
            res.writeHead(200, { [FakeControlPlane.ContentTypeHeader]: FakeControlPlane.Types[extname(rel)] ?? FakeControlPlane.DefaultType })
            res.end(body)
        }
        catch
        {
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
// clicked at its position: the header, then one fixed-pitch row per entry.
class PortalSteps
{
    private static readonly RailX = 24
    private static readonly RailFirstY = 97
    private static readonly RailPitch = 40

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

    public static async OpenSection(page: Page, entry: RailEntry): Promise<void>
    {
        await page.mouse.click(PortalSteps.RailX, PortalSteps.RailFirstY + PortalSteps.RailPitch * entry)
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
    })
    test.afterEach(() =>
    {
        expect(fake.Mutations).toEqual([])
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
        await expect(PortalSteps.Text(page, PortalText.TenantsSubtitle)).toBeVisible()
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

    test('Log out posts to the server and returns to the login page', async ({ page }) =>
    {
        await page.goto(base)
        await expect(PortalSteps.Text(page, PortalText.FleetSubtitle)).toBeVisible()
        await PortalSteps.Click(page, PortalText.LogoutLabel)
        await expect.poll(() => fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.LogoutPath)).toBeDefined()
        await expect(PortalSteps.Text(page, PortalText.SignInText)).toBeVisible()
    })
})
