import { test, expect } from '@playwright/test'
import { App } from '../src/app.js'
import { CreateEnvironmentView } from '../src/create-environment-view.js'
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
    private static readonly IndexFile = 'index.html'
    private static readonly ParentSegment = '..'
    private static readonly TemplatesPath = '/api/templates'
    private static readonly EnvPrefix = '/api/environments/'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly JsonType = 'application/json'
    private static readonly DefaultType = 'application/octet-stream'
    private static readonly Types: Record<string, string> =
    {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
    }

    public readonly Calls: Call[] = []
    private readonly root = fileURLToPath(new URL('../dist/', import.meta.url))
    private server: Server | undefined

    public async Start(): Promise<string>
    {
        this.server = createServer((req, res) => { void this.Handle(req, res) })
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
        const addr = this.server.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        return `http://127.0.0.1:${port}`
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
            tenantId: 't-1',
            hostPort: 4101,
            status: FakeControlPlane.EnvStatus,
            createdAt: '2026-01-01T00:00:00.000Z',
            httpUrl: 'http://localhost:4101',
            wsUrl: 'ws://localhost:4101/?tenant=t-1',
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
        const path = (req.url ?? '/').split('?')[0]!
        if (path === FakeControlPlane.TemplatesPath)
        {
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
        const rel = path === '/' ? FakeControlPlane.IndexFile : normalize(path).slice(1)
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

test.describe('admin portal', () =>
{
    const fake = new FakeControlPlane()
    let base = ''

    test.beforeAll(async () => { base = await fake.Start() })
    test.afterAll(async () => { await fake.Stop() })

    test('lists the environment with its status', async ({ page }) =>
    {
        await page.goto(base)
        await expect(page.getByText(App.TitleText)).toBeVisible()
        await expect(page.getByText(FakeControlPlane.EnvName).first()).toBeVisible()
        await expect(page.getByText(FakeControlPlane.EnvStatus).first()).toBeVisible()
    })

    test('create form lists both templates and posts the chosen one', async ({ page }) =>
    {
        await page.goto(base)
        await page.getByText(EnvironmentListView.NewLabel, { exact: true }).click()

        await page.getByText(CreateEnvironmentView.NamePlaceholder, { exact: true }).click()
        await page.keyboard.type(FakeControlPlane.NewName)

        // Open the dropdown: the first template is preselected, both titles must be offered.
        await page.getByText(FakeControlPlane.TemplateOneTitle, { exact: true }).click()
        await expect(page.getByText(FakeControlPlane.TemplateTwoTitle, { exact: true })).toBeVisible()
        await page.getByText(FakeControlPlane.TemplateTwoTitle, { exact: true }).click()

        await page.getByText(CreateEnvironmentView.CreateLabel, { exact: true }).click()
        await expect.poll(() => fake.Find('POST', FakeControlPlane.EnvironmentsPath)).toBeDefined()
        expect(fake.Find('POST', FakeControlPlane.EnvironmentsPath)!.body).toEqual({
            name: FakeControlPlane.NewName,
            template: FakeControlPlane.TemplateTwoId,
        })
    })

    test('Stop and Delete issue the right calls for the environment', async ({ page }) =>
    {
        await page.goto(base)
        await page.getByText(EnvironmentListView.StopLabel, { exact: true }).click()
        await expect.poll(() => fake.Find('POST', `/api/environments/${FakeControlPlane.EnvName}/stop`)).toBeDefined()

        await page.getByText(EnvironmentListView.DeleteLabel, { exact: true }).click()
        await page.getByText(EnvironmentListView.ConfirmDeleteLabel, { exact: true }).click()
        await expect.poll(() => fake.Find('DELETE', `/api/environments/${FakeControlPlane.EnvName}`)).toBeDefined()
    })
})
