import { test, expect, type Page } from '@playwright/test'
import { App } from '../src/app.js'
import { CreateEnvironmentView } from '../src/create-environment-view.js'
import { LoginView } from '../src/login-view.js'
import { EnvironmentListView } from '../src/environment-list-view.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

// A recorded API call: method + path (+ parsed JSON body for POST /api/environments).
type Call = { method: string; path: string; body?: unknown }

// Serves the built dist/ statically and fakes the control-plane API with
// canned data, recording every mutating call. GATED: needs Playwright
// browser binaries and a prior `npm run build`.
class FakeControlPlane
{
    public static readonly EnvName = 'alpha'
    public static readonly EnvStatus = 'running'
    public static readonly TemplateOneId = 'dev-blank'
    public static readonly TemplateOneTitle = 'Blank development'
    public static readonly TemplateTwoId = 'demo-contoso'
    public static readonly TemplateTwoTitle = 'Contoso demo'
    public static readonly NewName = 'beta'
    public static readonly EnvironmentsPath = '/api/environments'
    public static readonly StopPath = '/api/environments/alpha/stop'
    public static readonly DeletePath = '/api/environments/alpha'
    public static readonly MethodPost = 'POST'
    public static readonly MethodDelete = 'DELETE'
    public static readonly LoginPath = '/api/login'
    public static readonly LogoutPath = '/api/logout'
    public static readonly SessionPath = '/api/session'
    public static readonly OperatorEmail = 'op@example.com'
    public static readonly OperatorPassword = 'correct-horse'
    public static readonly BadCredentialsText = 'Invalid email or password'
    public static readonly BadPassword = 'wrong-password'
    private static readonly UnauthenticatedError = 'unauthenticated'
    private static readonly BadCredentialsError = FakeControlPlane.BadCredentialsText
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly SessionCookie = 'sid=test; Path=/; HttpOnly'
    private static readonly TenantId = 't-1'
    private static readonly HttpUrl = 'http://localhost:4101'
    private static readonly WsUrl = 'ws://localhost:4101/?tenant=t-1'
    private static readonly HtmlExt = '.html'
    private static readonly JsExt = '.js'
    private static readonly CssExt = '.css'
    private static readonly RootPath = '/'
    private static readonly IndexFile = 'index.html'
    private static readonly ParentSegment = '..'
    private static readonly TemplatesPath = '/api/templates'
    private static readonly EnvPrefix = '/api/environments/'
    private static readonly MethodGet = 'GET'
    private static readonly HostLocal = '127.0.0.1'
    private static readonly JsonType = 'application/json'
    private static readonly DefaultType = 'application/octet-stream'
    private static readonly Types: Record<string, string> =
    {
        [FakeControlPlane.HtmlExt]: 'text/html',
        [FakeControlPlane.JsExt]: 'text/javascript',
        [FakeControlPlane.CssExt]: 'text/css',
    }

    public readonly Calls: Call[] = []
    public TemplatesRequests = 0
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

    private static Env(): Record<string, unknown>
    {
        return {
            name: FakeControlPlane.EnvName,
            template: FakeControlPlane.TemplateOneId,
            tenantId: FakeControlPlane.TenantId,
            hostPort: 4101,
            status: FakeControlPlane.EnvStatus,
            createdAt: '2026-01-01T00:00:00.000Z',
            httpUrl: FakeControlPlane.HttpUrl,
            wsUrl: FakeControlPlane.WsUrl,
        }
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
        res.writeHead(status, { 'content-type': FakeControlPlane.JsonType })
        res.end(JSON.stringify(body))
    }

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const method = req.method ?? FakeControlPlane.MethodGet
        const path = (req.url ?? FakeControlPlane.RootPath).split('?')[0]!
        if (path === FakeControlPlane.SessionPath)
        {
            if (this.Authenticated)
            {
                FakeControlPlane.Json(res, 200, { email: FakeControlPlane.OperatorEmail })
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
            const body = JSON.parse(raw) as { password?: string }
            this.Calls.push({ method, path, body })
            if (body.password === FakeControlPlane.BadPassword)
            {
                FakeControlPlane.Json(res, 401, { error: FakeControlPlane.BadCredentialsError })
                return
            }
            this.Authenticated = true
            res.writeHead(200, { 'content-type': FakeControlPlane.JsonType, [FakeControlPlane.SetCookieHeader]: FakeControlPlane.SessionCookie })
            res.end(JSON.stringify({ email: FakeControlPlane.OperatorEmail }))
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
        if (path === FakeControlPlane.TemplatesPath)
        {
            this.TemplatesRequests++
            FakeControlPlane.Json(res, 200, [
                { id: FakeControlPlane.TemplateOneId, title: FakeControlPlane.TemplateOneTitle },
                { id: FakeControlPlane.TemplateTwoId, title: FakeControlPlane.TemplateTwoTitle },
            ])
            return
        }
        if (path === FakeControlPlane.EnvironmentsPath || path.startsWith(FakeControlPlane.EnvPrefix))
        {
            if (method === FakeControlPlane.MethodGet && path === FakeControlPlane.EnvironmentsPath)
            {
                FakeControlPlane.Json(res, 200, [FakeControlPlane.Env()])
                return
            }
            const raw = method === FakeControlPlane.MethodPost ? await FakeControlPlane.ReadBody(req) : ''
            const call: Call = { method, path }
            if (path === FakeControlPlane.EnvironmentsPath && raw.length > 0)
            {
                call.body = JSON.parse(raw)
            }
            this.Calls.push(call)
            const created = method === FakeControlPlane.MethodPost && path === FakeControlPlane.EnvironmentsPath
            FakeControlPlane.Json(res, created ? 201 : 200, FakeControlPlane.Env())
            return
        }
        await this.Serve(path, res)
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
            res.writeHead(200, { 'content-type': FakeControlPlane.Types[extname(rel)] ?? FakeControlPlane.DefaultType })
            res.end(body)
        }
        catch
        {
            res.writeHead(404)
            res.end()
        }
    }
}

// Interaction helpers. ASSUMPTION (adjust empirically): Mural may render
// TextBox either as a real <input> or as a canvas/SVG surface with a hidden
// key sink; handle both, preferring a real input when one exists.
class PortalSteps
{
    private static readonly InputSelector = 'input'

    // Types into the nth text field (input mode) or, failing that, the field showing the placeholder.
    public static async TypeInto(page: Page, index: number, placeholder: string, text: string): Promise<void>
    {
        const inputs = page.locator(PortalSteps.InputSelector)
        if (await inputs.count() > index)
        {
            await inputs.nth(index).fill(text)
            return
        }
        await page.getByText(placeholder, { exact: true }).click()
        await page.keyboard.type(text)
    }

    public static async TypeName(page: Page, text: string): Promise<void>
    {
        const input = page.locator(PortalSteps.InputSelector).first()
        if (await input.count() > 0)
        {
            await input.fill(text)
            return
        }
        await page.getByText(CreateEnvironmentView.NamePlaceholder, { exact: true }).click()
        await page.keyboard.type(text)
    }
}

test.describe('admin portal', () =>
{
    const fake = new FakeControlPlane()
    let base = ''

    test.beforeAll(async () => { base = await fake.Start() })
    test.afterAll(async () => { await fake.Stop() })
    test.beforeEach(() => { fake.Authenticated = true })

    test('lists the environment with its status', async ({ page }) =>
    {
        await page.goto(base)
        await expect(page.getByText(App.TitleText)).toBeVisible()
        await expect(page.getByText(FakeControlPlane.EnvName).first()).toBeVisible()
        await expect(page.getByText(FakeControlPlane.EnvStatus).first()).toBeVisible()
    })

    test('create form populates from the API and posts the preselected one', async ({ page }) =>
    {
        await page.goto(base)
        await page.getByText(EnvironmentListView.NewLabel, { exact: true }).click()

        await PortalSteps.TypeName(page, FakeControlPlane.NewName)

        // The view preselects template index 0 after loading ListTemplates; the
        // native popup is deliberately not driven (Mural ComboBox has no stable locator).
        await expect(page.getByText(FakeControlPlane.TemplateOneTitle)).toBeVisible()
        expect(fake.TemplatesRequests).toBeGreaterThan(0)

        await page.getByText(CreateEnvironmentView.CreateLabel, { exact: true }).click()
        await expect.poll(() => fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.EnvironmentsPath)).toBeDefined()
        expect(fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.EnvironmentsPath)!.body).toEqual({
            name: FakeControlPlane.NewName,
            template: FakeControlPlane.TemplateOneId,
        })
    })

    test('Stop and Delete issue the right calls for the environment', async ({ page }) =>
    {
        await page.goto(base)
        await page.getByText(EnvironmentListView.StopLabel, { exact: true }).click()
        await expect.poll(() => fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.StopPath)).toBeDefined()

        await page.getByText(EnvironmentListView.DeleteLabel, { exact: true }).click()
        await page.getByText(EnvironmentListView.ConfirmDeleteLabel, { exact: true }).click()
        await expect.poll(() => fake.Find(FakeControlPlane.MethodDelete, FakeControlPlane.DeletePath)).toBeDefined()
    })

    test('unauthenticated load shows the login view, not the list', async ({ page }) =>
    {
        fake.Authenticated = false
        await page.goto(base)
        await expect(page.getByText(LoginView.LoginLabel, { exact: true })).toBeVisible()
        await expect(page.getByText(LoginView.EmailPlaceholder, { exact: true })).toBeVisible()
        await expect(page.getByText(EnvironmentListView.NewLabel, { exact: true })).toHaveCount(0)
    })

    test('logging in posts the email and then shows the environment list', async ({ page }) =>
    {
        fake.Authenticated = false
        await page.goto(base)
        await expect(page.getByText(LoginView.LoginLabel, { exact: true })).toBeVisible()
        await PortalSteps.TypeInto(page, 0, LoginView.EmailPlaceholder, FakeControlPlane.OperatorEmail)
        await PortalSteps.TypeInto(page, 1, LoginView.PasswordPlaceholder, FakeControlPlane.OperatorPassword)
        await page.getByText(LoginView.LoginLabel, { exact: true }).click()
        await expect.poll(() => fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.LoginPath)).toBeDefined()
        expect(fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.LoginPath)!.body).toEqual({
            email: FakeControlPlane.OperatorEmail,
            password: FakeControlPlane.OperatorPassword,
        })
        await expect(page.getByText(EnvironmentListView.NewLabel, { exact: true })).toBeVisible()
    })

    test('bad credentials keep the login view and show the error inline', async ({ page }) =>
    {
        fake.Authenticated = false
        await page.goto(base)
        await expect(page.getByText(LoginView.LoginLabel, { exact: true })).toBeVisible()
        await PortalSteps.TypeInto(page, 0, LoginView.EmailPlaceholder, FakeControlPlane.OperatorEmail)
        await PortalSteps.TypeInto(page, 1, LoginView.PasswordPlaceholder, FakeControlPlane.BadPassword)
        await page.getByText(LoginView.LoginLabel, { exact: true }).click()
        await expect(page.getByText(FakeControlPlane.BadCredentialsText)).toBeVisible()
        await expect(page.getByText(LoginView.LoginLabel, { exact: true })).toBeVisible()
        await expect(page.getByText(EnvironmentListView.NewLabel, { exact: true })).toHaveCount(0)
    })

    test('Logout posts to the server and returns to the login view', async ({ page }) =>
    {
        await page.goto(base)
        await expect(page.getByText(EnvironmentListView.NewLabel, { exact: true })).toBeVisible()
        await page.getByText(App.LogoutLabel, { exact: true }).click()
        await expect.poll(() => fake.Find(FakeControlPlane.MethodPost, FakeControlPlane.LogoutPath)).toBeDefined()
        await expect(page.getByText(LoginView.LoginLabel, { exact: true })).toBeVisible()
    })
})
