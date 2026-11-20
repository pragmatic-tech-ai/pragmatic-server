import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

// A fake realm sign-in service: serves the built app the way the IdP does
// (index.html at the realm's authorize URL, assets under /_login/), answers the
// page's config (local accounts plus one upstream source), records every JSON
// login post and answers it with a redirect or invalid_credentials, and
// records the broker login the source button navigates to.
class FakeIdp
{
    public static readonly AuthorizePath = '/realms/central/protocol/openid-connect/auth'
    public static readonly ConfigPath = '/realms/central/login/config'
    public static readonly LoginPath = '/realms/central/login'
    public static readonly BrokerPath = '/realms/central/broker/corp/login'
    public static readonly Request = 'response_type=code&client_id=c1&state=s1&nonce=n1'
    public static readonly Query = '?' + FakeIdp.Request
    public static readonly DonePath = '/done'
    public static readonly GoodPassword = 'right-pw'
    public static readonly SourceLabel = 'Corporate SSO'
    private static readonly AssetPrefix = '/_login/'
    private static readonly Types: Record<string, string> = { '.js': 'text/javascript', '.woff2': 'font/woff2', '.css': 'text/css' }

    public readonly Posts: Array<{ contentType: string | undefined; body: Record<string, unknown> }> = []
    public readonly Brokered: string[] = []
    private readonly dist = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
    private server: Server | undefined

    public async Start(): Promise<string>
    {
        this.server = createServer((req, res) => { void this.Handle(req, res) })
        await new Promise<void>(done => this.server!.listen(0, '127.0.0.1', done))
        return 'http://127.0.0.1:' + String((this.server.address() as AddressInfo).port)
    }

    public async Stop(): Promise<void>
    {
        await new Promise<void>(done => this.server?.close(() => done()))
    }

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === FakeIdp.LoginPath && req.method === 'POST')
        {
            const chunks: Buffer[] = []
            for await (const chunk of req)
            {
                chunks.push(chunk as Buffer)
            }
            const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
            this.Posts.push({ contentType: req.headers['content-type'], body })
            if (body.password === FakeIdp.GoodPassword)
            {
                this.WriteJson(res, 200, { redirect: FakeIdp.DonePath })
                return
            }
            this.WriteJson(res, 401, { error: 'invalid_credentials' })
            return
        }
        if (url.pathname === FakeIdp.ConfigPath)
        {
            this.WriteJson(res, 200, {
                realm: 'central',
                displayName: 'Central',
                local: true,
                sources: [{ id: 'corp', kind: 'oidc', label: FakeIdp.SourceLabel, login: FakeIdp.BrokerPath + '?' }],
                identityPlatform: null,
                signUp: false,
            })
            return
        }
        if (url.pathname === FakeIdp.AuthorizePath)
        {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(readFileSync(join(this.dist, 'index.html'), 'utf8'))
            return
        }
        if (url.pathname === FakeIdp.BrokerPath || url.pathname === FakeIdp.DonePath)
        {
            if (url.pathname === FakeIdp.BrokerPath)
            {
                this.Brokered.push(url.search)
            }
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('left the page')
            return
        }
        if (url.pathname.startsWith(FakeIdp.AssetPrefix))
        {
            const file = resolve(this.dist, url.pathname.slice(FakeIdp.AssetPrefix.length))
            if (file.startsWith(this.dist + sep) && existsSync(file) && statSync(file).isFile())
            {
                res.writeHead(200, { 'content-type': FakeIdp.Types[extname(file)] ?? 'application/octet-stream' })
                res.end(readFileSync(file))
                return
            }
        }
        res.writeHead(404)
        res.end()
    }

    private WriteJson(res: ServerResponse, status: number, body: unknown): void
    {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
    }
}

// The boxes are real browser inputs (TextBox.UsesNativeInput): type into them
// as a user (or a password manager) would, by their autocomplete token.
class LoginSteps
{
    public static async TypeInto(page: Page, autocomplete: string, text: string): Promise<void>
    {
        await page.locator('input[autocomplete="' + autocomplete + '"]').click()
        await page.keyboard.type(text)
    }
}

test.describe('IdP sign-in app', () =>
{
    const idp = new FakeIdp()
    let base = ''

    test.beforeAll(async () =>
    {
        base = await idp.Start()
    })

    test.afterAll(async () =>
    {
        await idp.Stop()
    })

    test('renders the form; Sign in posts the request, email and password as JSON, then follows the redirect', async ({ page }) =>
    {
        await page.goto(base + FakeIdp.AuthorizePath + FakeIdp.Query)
        await expect(page.getByText('Use your organisation account.', { exact: true })).toBeVisible()
        await expect(page.getByText('Invalid email or password.', { exact: true })).toHaveCount(0)
        await LoginSteps.TypeInto(page, 'email', 'owner@acme.test')
        await LoginSteps.TypeInto(page, 'current-password', FakeIdp.GoodPassword)
        await page.getByText('Sign in', { exact: true }).last().click({ force: true })
        await page.waitForURL(base + FakeIdp.DonePath)
        expect(idp.Posts.at(-1)).toEqual({
            contentType: 'application/json',
            body: { request: FakeIdp.Request, method: 'password', email: 'owner@acme.test', password: FakeIdp.GoodPassword },
        })
    })

    test('the fields are real inputs a password manager recognises', async ({ page }) =>
    {
        await page.goto(base + FakeIdp.AuthorizePath + FakeIdp.Query)
        const email = page.locator('input[autocomplete="email"]')
        const password = page.locator('input[autocomplete="current-password"]')
        await expect(email).toBeVisible()
        await expect(email).toHaveAttribute('type', 'email')
        await expect(email).toHaveAttribute('aria-label', 'Email')
        await expect(password).toHaveAttribute('type', 'password')
        // Autofill writes the inputs directly; the page still posts what they hold.
        await email.fill('autofilled@acme.test')
        await password.fill(FakeIdp.GoodPassword)
        await page.getByText('Sign in', { exact: true }).last().click({ force: true })
        await page.waitForURL(base + FakeIdp.DonePath)
        expect(idp.Posts.at(-1)?.body).toEqual({ request: FakeIdp.Request, method: 'password', email: 'autofilled@acme.test', password: FakeIdp.GoodPassword })
    })

    test('a rejected sign-in shows the error on the same page; Enter submits', async ({ page }) =>
    {
        await page.goto(base + FakeIdp.AuthorizePath + FakeIdp.Query)
        await expect(page.getByText('Use your organisation account.', { exact: true })).toBeVisible()
        await LoginSteps.TypeInto(page, 'email', 'owner@acme.test')
        await LoginSteps.TypeInto(page, 'current-password', 'wrong-pw')
        await page.keyboard.press('Enter')
        await expect(page.getByText('Invalid email or password.', { exact: true })).toBeVisible()
        expect(page.url()).toBe(base + FakeIdp.AuthorizePath + FakeIdp.Query)
        expect(idp.Posts.at(-1)?.body).toEqual({ request: FakeIdp.Request, method: 'password', email: 'owner@acme.test', password: 'wrong-pw' })
    })

    test('an upstream source button navigates to its broker login with the authorize request', async ({ page }) =>
    {
        await page.goto(base + FakeIdp.AuthorizePath + FakeIdp.Query)
        await page.getByText(FakeIdp.SourceLabel, { exact: true }).click({ force: true })
        await page.waitForURL(base + FakeIdp.BrokerPath + FakeIdp.Query)
        expect(idp.Brokered.at(-1)).toBe(FakeIdp.Query)
    })
})
