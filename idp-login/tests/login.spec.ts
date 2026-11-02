import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

// A fake IdP: serves the built app the way IdpHost does (index.html at the
// authorize URL with its flag, assets under /_login/), records every form post
// to the authorize URL, and answers a post with the failed page or a redirect.
class FakeIdp
{
    public static readonly AuthorizePath = '/tenant-1/authorize'
    public static readonly Query = '?response_type=code&client_id=c1&state=s1&nonce=n1'
    public static readonly DonePath = '/done'
    public static readonly GoodPassword = 'right-pw'
    private static readonly ReadyFlag = '<meta name="pragmatic-login" content="ready">'
    private static readonly FailedFlag = '<meta name="pragmatic-login" content="failed">'
    private static readonly AssetPrefix = '/_login/'
    private static readonly Types: Record<string, string> = { '.js': 'text/javascript', '.woff2': 'font/woff2', '.css': 'text/css' }

    public readonly Posts: Array<{ url: string; form: Record<string, string> }> = []
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
        if (url.pathname === FakeIdp.AuthorizePath && req.method === 'POST')
        {
            const chunks: Buffer[] = []
            for await (const chunk of req)
            {
                chunks.push(chunk as Buffer)
            }
            const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))
            this.Posts.push({ url: url.pathname + url.search, form })
            if (form.password === FakeIdp.GoodPassword)
            {
                res.writeHead(302, { Location: FakeIdp.DonePath })
                res.end()
                return
            }
            this.WritePage(res, true)
            return
        }
        if (url.pathname === FakeIdp.AuthorizePath)
        {
            this.WritePage(res, false)
            return
        }
        if (url.pathname === FakeIdp.DonePath)
        {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('signed in')
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

    private WritePage(res: ServerResponse, failed: boolean): void
    {
        const index = readFileSync(join(this.dist, 'index.html'), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(failed ? index.replace(FakeIdp.ReadyFlag, FakeIdp.FailedFlag) : index)
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

    test('renders the form; Sign in posts email and password to the authorize URL with its query, then follows the redirect', async ({ page }) =>
    {
        await page.goto(base + FakeIdp.AuthorizePath + FakeIdp.Query)
        await expect(page.getByText('Use your organisation account.', { exact: true })).toBeVisible()
        await expect(page.getByText('Invalid email or password.', { exact: true })).toHaveCount(0)
        await LoginSteps.TypeInto(page, 'email', 'owner@acme.test')
        await LoginSteps.TypeInto(page, 'current-password', FakeIdp.GoodPassword)
        await page.getByText('Sign in', { exact: true }).last().click({ force: true })
        await page.waitForURL(base + FakeIdp.DonePath)
        expect(idp.Posts.at(-1)).toEqual({ url: FakeIdp.AuthorizePath + FakeIdp.Query, form: { email: 'owner@acme.test', password: FakeIdp.GoodPassword } })
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
        // Autofill writes the inputs directly; the form still posts what they hold.
        await email.fill('autofilled@acme.test')
        await password.fill(FakeIdp.GoodPassword)
        await page.getByText('Sign in', { exact: true }).last().click({ force: true })
        await page.waitForURL(base + FakeIdp.DonePath)
        expect(idp.Posts.at(-1)?.form).toEqual({ email: 'autofilled@acme.test', password: FakeIdp.GoodPassword })
    })

    test('a rejected sign-in comes back flagged and shows the error; Enter submits', async ({ page }) =>
    {
        await page.goto(base + FakeIdp.AuthorizePath + FakeIdp.Query)
        await expect(page.getByText('Use your organisation account.', { exact: true })).toBeVisible()
        await LoginSteps.TypeInto(page, 'email', 'owner@acme.test')
        await LoginSteps.TypeInto(page, 'current-password', 'wrong-pw')
        await page.keyboard.press('Enter')
        await expect(page.getByText('Invalid email or password.', { exact: true })).toBeVisible()
        expect(idp.Posts.at(-1)?.form).toEqual({ email: 'owner@acme.test', password: 'wrong-pw' })
    })
})
