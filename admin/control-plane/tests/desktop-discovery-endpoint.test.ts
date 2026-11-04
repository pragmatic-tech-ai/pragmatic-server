import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopDiscoveryEndpoint } from '../desktop-discovery-endpoint.js'
import { TenantAccountIndex } from '../tenant-account-index.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { TenantRecord } from '../platform-records.js'

type Reply = { status: number; body: unknown; retryAfter: string | undefined }

class FakeDirectory implements ITenantDirectory
{
    public constructor(private readonly tenants: readonly TenantRecord[])
    {
    }

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.tenants.find(t => t.id === id)
    }

    public GetHive(): undefined
    {
        return undefined
    }

    public ListHives(): readonly never[]
    {
        return []
    }
}

class DiscoveryFixture
{
    public static readonly Url = 'http://127.0.0.1:7002'
    public static readonly Ann = 'ann@acme.test'
    public static readonly Nobody = 'nobody@acme.test'
    public static readonly Path = '/api/desktop/discover'
    public static readonly Loopback = '127.0.0.1'
    public static readonly Utf8 = 'utf8'
    public static readonly EvilOrigin = 'http://evil.test'
    public static readonly ThrottleLimit = 10

    public static Tenant(id: string, displayName: string): TenantRecord
    {
        return { id, clientId: 'c1', displayName, createdAt: '2026-01-01T00:00:00.000Z' }
    }

    public static Post(server: Server, payload: string, headers: Record<string, string> = {}): Promise<Reply>
    {
        const port = (server.address() as AddressInfo).port
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: DiscoveryFixture.Loopback, port, method: 'POST', path: DiscoveryFixture.Path, headers: { 'content-type': 'application/json', ...headers } }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString(DiscoveryFixture.Utf8)
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text), retryAfter: res.headers['retry-after'] as string | undefined })
                })
            })
            req.on('error', reject)
            req.end(payload)
        })
    }

    public static Email(email: string): string
    {
        return JSON.stringify({ email })
    }
}

describe('DesktopDiscoveryEndpoint', () =>
{
    let dir: string
    let index: TenantAccountIndex
    let server: Server

    async function Start(url: string | undefined, tenants: readonly TenantRecord[]): Promise<void>
    {
        const endpoint = new DesktopDiscoveryEndpoint(index, new FakeDirectory(tenants), url, DesktopDiscoveryEndpoint.NewThrottle())
        server = createServer((req, res) =>
        {
            void endpoint.Handle(req, res)
        })
        await new Promise<void>(r => server.listen(0, DiscoveryFixture.Loopback, r))
    }

    beforeEach(async () =>
    {
        dir = await mkdtemp(join(tmpdir(), 'discover-'))
        index = new TenantAccountIndex(join(dir, 'tenant-accounts.json'))
        await index.Load()
        await index.Record('acme', 'owner', DiscoveryFixture.Ann)
    })

    afterEach(async () =>
    {
        await new Promise<void>(r => server.close(() => r()))
        await rm(dir, { recursive: true, force: true })
    })

    it('answers 200 with the tenants and the tenant plane url', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal(reply.status, 200)
        assert.deepEqual(reply.body, { tenants: [{ id: 'acme', displayName: 'Acme' }], tenantPlaneUrl: DiscoveryFixture.Url })
    })

    it('sorts tenants by display name and skips unknown tenant ids', async () =>
    {
        await index.Record('zed', 'owner', DiscoveryFixture.Ann)
        await index.Record('gone', 'owner', DiscoveryFixture.Ann)
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('zed', 'Aardvark'), DiscoveryFixture.Tenant('acme', 'Acme')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.deepEqual((reply.body as { tenants: unknown[] }).tenants, [{ id: 'zed', displayName: 'Aardvark' }, { id: 'acme', displayName: 'Acme' }])
    })

    it('answers 404 no-account for an unknown email', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Nobody))
        assert.equal(reply.status, 404)
        assert.deepEqual(reply.body, { error: 'no-account' })
    })

    it('answers 400 invalid-email for a missing, non-string or oversized email', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        for (const payload of ['{}', '{"email":5}', 'not json', DiscoveryFixture.Email('a'.repeat(255))])
        {
            const reply = await DiscoveryFixture.Post(server, payload)
            assert.equal(reply.status, 400, payload.slice(0, 20))
            assert.deepEqual(reply.body, { error: 'invalid-email' })
        }
    })

    it('answers 503 unavailable when no tenant plane url is configured', async () =>
    {
        await Start(undefined, [DiscoveryFixture.Tenant('acme', 'Acme')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal(reply.status, 503)
        assert.deepEqual(reply.body, { error: 'unavailable' })
    })

    it('answers 403 when an Origin header is present and does not count it against the throttle', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        for (let i = 0; i < DiscoveryFixture.ThrottleLimit + 5; i++)
        {
            assert.equal((await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann), { origin: DiscoveryFixture.EvilOrigin })).status, 403)
        }
        assert.equal((await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))).status, 200)
    })

    it('throttles the 11th request in a minute from one address with Retry-After', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        for (let i = 0; i < DiscoveryFixture.ThrottleLimit; i++)
        {
            assert.equal((await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Nobody))).status, 404)
        }
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal(reply.status, 429)
        assert.ok(Number(reply.retryAfter) > 0)
    })
})
