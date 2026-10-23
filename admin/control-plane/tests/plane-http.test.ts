import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PlaneHttp } from '../plane-http.js'

class FakeRes
{
    public status = 0
    public headers: Record<string, string> = {}
    public body = ''
    public writeHead(status: number, headers?: Record<string, string>): this
    {
        this.status = status
        Object.assign(this.headers, headers)
        return this
    }
    public end(data?: string | Buffer): void
    {
        this.body = data === undefined ? '' : data.toString()
    }
}

class PlaneHttpTestKit
{
    public static Req(method: string, headers: Record<string, string> = {}): IncomingMessage
    {
        return { method, headers } as unknown as IncomingMessage
    }

    public static Serve(root: string, path: string, method = 'GET'): Promise<FakeRes>
    {
        const res = new FakeRes()
        return PlaneHttp.ServeStatic(PlaneHttpTestKit.Req(method), res as unknown as ServerResponse, path, root).then(() => res)
    }
}

const Allowed: ReadonlySet<string> = new Set(['localhost', '[::1]'])

test('HostIn matches an allowed host, strips the port, rejects others and malformed headers', () =>
{
    assert.equal(PlaneHttp.HostIn(PlaneHttpTestKit.Req('GET', { host: 'localhost' }), Allowed), true)
    assert.equal(PlaneHttp.HostIn(PlaneHttpTestKit.Req('GET', { host: 'LocalHost:8080' }), Allowed), true)
    assert.equal(PlaneHttp.HostIn(PlaneHttpTestKit.Req('GET', { host: '[::1]:3000' }), Allowed), true)
    assert.equal(PlaneHttp.HostIn(PlaneHttpTestKit.Req('GET', { host: 'evil.com' }), Allowed), false)
    assert.equal(PlaneHttp.HostIn(PlaneHttpTestKit.Req('GET', { host: 'a:b:c' }), Allowed), false)
    assert.equal(PlaneHttp.HostIn(PlaneHttpTestKit.Req('GET'), Allowed), false)
})

test('IsMutating is true for POST/PUT/DELETE and false for GET', () =>
{
    assert.equal(PlaneHttp.IsMutating(PlaneHttpTestKit.Req('POST')), true)
    assert.equal(PlaneHttp.IsMutating(PlaneHttpTestKit.Req('PUT')), true)
    assert.equal(PlaneHttp.IsMutating(PlaneHttpTestKit.Req('DELETE')), true)
    assert.equal(PlaneHttp.IsMutating(PlaneHttpTestKit.Req('GET')), false)
})

test('OriginInHosts allows absent origin and allowed host, rejects foreign and unparseable', () =>
{
    assert.equal(PlaneHttp.OriginInHosts(PlaneHttpTestKit.Req('POST'), Allowed), true)
    assert.equal(PlaneHttp.OriginInHosts(PlaneHttpTestKit.Req('POST', { origin: 'http://localhost:5173' }), Allowed), true)
    assert.equal(PlaneHttp.OriginInHosts(PlaneHttpTestKit.Req('POST', { origin: 'http://evil.com' }), Allowed), false)
    assert.equal(PlaneHttp.OriginInHosts(PlaneHttpTestKit.Req('POST', { origin: 'not a url' }), Allowed), false)
})

test('ServeStatic serves files with MIME, 404s missing, and refuses traversal', async () =>
{
    const base = mkdtempSync(join(tmpdir(), 'plane-http-'))
    try
    {
        const root = resolve(join(base, 'root'))
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<p>hi</p>')
        writeFileSync(join(root, 'app.js'), 'x')
        writeFileSync(join(base, 'secret.txt'), 'SECRET')

        const idx = await PlaneHttpTestKit.Serve(root, '/')
        assert.equal(idx.status, 200)
        assert.equal(idx.headers['Content-Type'], 'text/html; charset=utf-8')
        assert.equal(idx.body, '<p>hi</p>')

        const js = await PlaneHttpTestKit.Serve(root, '/app.js')
        assert.equal(js.headers['Content-Type'], 'text/javascript; charset=utf-8')

        assert.equal((await PlaneHttpTestKit.Serve(root, '/missing.js')).status, 404)
        assert.equal((await PlaneHttpTestKit.Serve(root, '/app.js', 'POST')).status, 404)

        for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%E0%A4%A'])
        {
            const r = await PlaneHttpTestKit.Serve(root, p)
            assert.equal(r.status, 404, p)
            assert.ok(!r.body.includes('SECRET'), p)
        }
    }
    finally
    {
        rmSync(base, { recursive: true, force: true })
    }
})
