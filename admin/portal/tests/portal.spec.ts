import { test, expect } from '@playwright/test'
import { SpikeView } from '../src/spike-view.js'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

// Serves the built dist/ statically and stubs /api/ping, then asserts the
// Mural-rendered title and the Ping round-trip. GATED: needs Playwright
// browser binaries and a prior `npm run build`.
class StaticDist
{
    private static readonly IndexFile = 'index.html'
    private static readonly ParentSegment = '..'
    private static readonly PingPath = '/api/ping'
    public static readonly PingBody = '{"ok":true}'
    private static readonly JsonType = 'application/json'
    private static readonly DefaultType = 'application/octet-stream'
    private static readonly Types: Record<string, string> =
    {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
    }

    private readonly root = fileURLToPath(new URL('../dist/', import.meta.url))
    private server: Server | undefined

    public async Start(): Promise<string>
    {
        this.server = createServer((req, res) => { void this.Handle(req.url ?? '/', res) })
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
        const addr = this.server.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        return `http://127.0.0.1:${port}`
    }

    public async Stop(): Promise<void>
    {
        await new Promise<void>(resolve => this.server?.close(() => resolve()))
    }

    private async Handle(url: string, res: ServerResponse): Promise<void>
    {
        const path = url.split('?')[0]!
        if (path === StaticDist.PingPath)
        {
            res.writeHead(200, { 'content-type': StaticDist.JsonType })
            res.end(StaticDist.PingBody)
            return
        }
        const rel = path === '/' ? StaticDist.IndexFile : normalize(path).slice(1)
        if (rel.startsWith(StaticDist.ParentSegment))
        {
            res.writeHead(404)
            res.end()
            return
        }
        try
        {
            const body = await readFile(join(this.root, rel))
            res.writeHead(200, { 'content-type': StaticDist.Types[extname(rel)] ?? StaticDist.DefaultType })
            res.end(body)
        }
        catch
        {
            res.writeHead(404)
            res.end()
        }
    }
}

test.describe('portal spike', () =>
{
    const dist = new StaticDist()
    let base = ''

    test.beforeAll(async () => { base = await dist.Start() })
    test.afterAll(async () => { await dist.Stop() })

    test('renders the title and shows ok after clicking Ping', async ({ page }) =>
    {
        await page.goto(base)
        await expect(page.getByText(SpikeView.TitleText)).toBeVisible()
        await page.getByText(SpikeView.PingLabel, { exact: true }).click()
        await expect(page.getByText(StaticDist.PingBody)).toBeVisible()
    })
})
